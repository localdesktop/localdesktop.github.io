import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Adb } from "../../core/adb/adb";
import { assertDebuggable, forceStop, pidof, startApp, waitForPid } from "../../core/adb/app";
import { releaseWaitingApp } from "../../core/adb/jdwp";
import { deviceEpoch } from "../../core/adb/props";
import { inspectElfFile } from "../../core/debug/elf";
import { buildLldbAttachConfig } from "../../core/debug/lldbConfig";
import { deployLldbServer, killLldbServers, PlatformServer } from "../../core/debug/lldbServer";
import { rustToolchain, type RustToolchain } from "../../core/debug/rust";
import { findLldbServer } from "../../core/env";
import { isLdError, LdError } from "../../core/errors";
import { consoleFilter, type LogEntry } from "../../core/logcat/parse";
import { updateState } from "../../core/state";
import { buildArtifacts, findApk, type AppInfo, type Profile } from "../../core/workspace";
import { installOnDevice } from "../deviceCommands";
import { requireRoot, type Services } from "../services";
import { buildWithTask } from "../tasks";
import { abortSignal } from "../ui";
import { ensureCodeLldb } from "./codelldb";

export interface LocalDesktopDebugConfig extends vscode.DebugConfiguration {
  /** "auto" | "pick" | serial, as written in launch.json. */
  device?: string;
  /** The serial resolved before launch (kept so Restart reuses the same device). */
  serial?: string;
  build?: boolean;
  profile?: Profile;
  apk?: string;
  install?: boolean;
  stopOnEntry?: boolean;
  stopAppOnDisconnect?: boolean;
  logcat?: "rust" | "warnings" | "all" | "none";
  symbolSearchPaths?: string[];
  lldbServer?: string;
  lldbServerLog?: boolean;
  initCommands?: string[];
  preRunCommands?: string[];
  postRunCommands?: string[];
  exitCommands?: string[];
  sourceMap?: Record<string, string>;
  lldb?: Record<string, unknown>;
  pid?: number | string;
  noDebug?: boolean;
}

export interface SessionOutput {
  /** Progress and diagnostics (Debug Console, "console" category). */
  log(message: string): void;
  /** Mirrored app output. */
  output(text: string, category: "stdout" | "stderr" | "important"): void;
}

type Cleanup = () => unknown;

/**
 * Runs one Local Desktop debug session: build → install → launch (waiting for the debugger) →
 * lldb-server in the app sandbox → CodeLLDB child session → release the Java wait. Everything it
 * starts is registered as a cleanup and undone in reverse order by dispose().
 */
export class DebugOrchestrator {
  private readonly cleanups: Cleanup[] = [];
  private readonly cancel = new vscode.CancellationTokenSource();
  private readonly subs: vscode.Disposable[] = [];
  private child: vscode.DebugSession | undefined;
  private disposed = false;

  constructor(
    private readonly s: Services,
    private readonly parent: vscode.DebugSession,
    private readonly io: SessionOutput,
    /** Called when the session should end on its own (child stopped, app exited). */
    private readonly onEnded: (reason: string) => void,
  ) {
    this.subs.push(
      vscode.debug.onDidStartDebugSession((session) => {
        if (session.parentSession?.id === parent.id) this.child = session;
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (this.child && session.id === this.child.id) {
          this.child = undefined;
          if (!this.disposed) this.onEnded("native debugger detached");
        }
      }),
    );
  }

  private get token(): vscode.CancellationToken {
    return this.cancel.token;
  }

  private checkCancelled(): void {
    if (this.token.isCancellationRequested) throw new LdError("CANCELLED", "Debug session stopped.");
  }

  private onCleanup(fn: Cleanup): void {
    this.cleanups.push(fn);
  }

  private folder(root: string): vscode.WorkspaceFolder | undefined {
    return this.parent.workspaceFolder ?? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  }

  async launch(config: LocalDesktopDebugConfig, noDebugRequested: boolean): Promise<void> {
    const s = this.s;
    const root = requireRoot(s.root);
    const app = s.app();
    const profile: Profile = config.profile ?? "debug";
    const device = await s.devices.resolve(config.serial ?? config.device);
    const serial = device.serial;
    const adb = s.devices.adb().forDevice(serial);
    let noDebug = noDebugRequested;
    this.io.log(`Local Desktop ${noDebug ? "run" : "debug"} on ${s.devices.label(device)} (${serial}), package ${app.packageName}`);

    // 1. Preflight in parallel, before spending minutes on a build.
    const [abiOk, lldbServerOrError, rust] = await Promise.all([
      this.checkAbi(serial, noDebug),
      // Only fatal if we end up debugging (the ABI check may switch to run-without-debugging).
      noDebug ? Promise.resolve(undefined) : this.locateLldbServer(config).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
      noDebug ? Promise.resolve<RustToolchain>({}) : rustToolchain(root),
    ]);
    if (abiOk === "noDebug") noDebug = true;
    if (!noDebug && lldbServerOrError instanceof Error) throw lldbServerOrError;
    const lldbServer = typeof lldbServerOrError === "string" ? lldbServerOrError : undefined;
    if (!noDebug) {
      try {
        await ensureCodeLldb();
      } catch (e) {
        if (isLdError(e, "CODELLDB_MISSING") && e.message === "RUN_WITHOUT_DEBUGGING") noDebug = true;
        else throw e;
      }
    }
    this.checkCancelled();

    // 2. Build.
    const apk = await this.buildApk(root, profile, config);
    this.checkCancelled();

    // 3. Symbols.
    const symbolDirs = noDebug ? [] : this.symbolDirs(root, profile, app, config);

    // 4. Install.
    if (config.install !== false) {
      this.io.log(`Installing ${path.relative(root, apk) || apk}…`);
      const result = await installOnDevice(s, serial, apk, { token: this.token, force: false });
      this.io.log(result === "unchanged" ? "APK unchanged since the last install; skipped." : "Installed.");
    }
    this.checkCancelled();

    // 5. Clean slate: no stale lldb-servers or app instances.
    if (!noDebug) await killLldbServers(adb, app.packageName);
    await forceStop(adb, app.packageName);

    // 6. lldb-server into the sandbox (needs a debuggable build).
    if (!noDebug) {
      await assertDebuggable(adb, app.packageName);
      this.io.log(`Deploying lldb-server (${lldbServer})…`);
      const deployed = await deployLldbServer(adb, app.packageName, lldbServer!, abortSignal(this.token));
      if (deployed === "unchanged") this.io.log("lldb-server already up to date on the device.");
    }
    this.checkCancelled();

    // 7. Logcat from now on, mirrored into the Debug Console.
    const since = await deviceEpoch(adb).catch(() => undefined);
    await s.logcat.follow(serial, { sinceEpoch: since, refreshUid: true });
    s.logcat.marker(`${noDebug ? "run" : "debug"} session on ${serial}`);
    this.mirrorLogcat(config.logcat ?? "rust");

    // 8. Launch.
    this.io.log(noDebug ? "Starting the app…" : "Starting the app (waiting for debugger)…");
    await startApp(adb, app.packageName, { waitForDebugger: !noDebug });
    if (config.stopAppOnDisconnect !== false) this.onCleanup(() => forceStop(adb, app.packageName));
    const pid = await waitForPid(adb, app.packageName, 15_000, abortSignal(this.token));
    this.io.log(`App process: ${pid}`);
    updateState(root, (st) => {
      st.lastLaunch = { serial, pid, deviceEpoch: since, profile, debug: !noDebug, at: new Date().toISOString() };
    });

    if (noDebug) {
      this.watchProcess(adb, app.packageName, pid);
      this.io.output(`Running without debugging. Stop the session to ${config.stopAppOnDisconnect !== false ? "stop the app" : "detach"}.\n`, "important");
      return;
    }

    // 9-10. Platform server + CodeLLDB child session.
    await this.attachNative(root, adb, serial, s.devices.label(device), app, pid, config, symbolDirs, rust);

    // 11. Release the Java "waiting for debugger" state; native breakpoints are pending by now.
    // Not awaited: with stopOnEntry the VM can't answer until the user continues in LLDB.
    void this.releaseJava(adb, pid, config.stopOnEntry ? 10 * 60_000 : 60_000);
  }

  private async releaseJava(adb: Adb, pid: number, timeoutMs: number): Promise<void> {
    try {
      const release = await releaseWaitingApp(adb, pid, { log: (m) => this.io.log(m), timeoutMs });
      if (this.disposed) {
        await release.close();
        return;
      }
      this.onCleanup(() => release.close());
      this.io.log(`App resumed (${release.method}).`);
    } catch (e) {
      if (this.disposed) return;
      this.io.output(`Couldn't resume the app: ${e instanceof Error ? e.message : String(e)}\n`, "stderr");
      void vscode.window.showWarningMessage("The app is still waiting for a Java debugger. Stop and restart the session.");
    }
  }

  async attach(config: LocalDesktopDebugConfig): Promise<void> {
    const s = this.s;
    const root = requireRoot(s.root);
    const app = s.app();
    const device = await s.devices.resolve(config.serial ?? config.device);
    const adb = s.devices.adb().forDevice(device.serial);
    const pid = typeof config.pid === "number" ? config.pid : parseInt(String(config.pid ?? ""), 10);
    if (!Number.isFinite(pid)) throw new LdError("INVALID_ARGUMENT", "No process to attach to.", "Set `pid` or pick a process.");

    const [abi, lldbServer, rust] = await Promise.all([this.checkAbi(device.serial, false), this.locateLldbServer(config), rustToolchain(root)]);
    if (abi === "noDebug") throw new LdError("UNSUPPORTED_ABI", "Native debugging needs an arm64-v8a device.");
    await ensureCodeLldb();
    await assertDebuggable(adb, app.packageName);
    this.io.log(`Attaching to ${pid} on ${s.devices.label(device)}…`);
    await deployLldbServer(adb, app.packageName, lldbServer, abortSignal(this.token));
    const profile: Profile = config.profile ?? "debug";
    await s.logcat.follow(device.serial);
    this.mirrorLogcat(config.logcat ?? "rust");
    await this.attachNative(root, adb, device.serial, s.devices.label(device), app, pid, config, this.symbolDirs(root, profile, app, config), rust);
  }

  private async attachNative(
    root: string,
    adb: Adb,
    serial: string,
    label: string,
    app: AppInfo,
    pid: number,
    config: LocalDesktopDebugConfig,
    symbolDirs: string[],
    rust: RustToolchain,
  ): Promise<void> {
    this.io.log("Starting lldb-server platform in the app sandbox…");
    const platform = await PlatformServer.start(adb, app.packageName, {
      log: config.lldbServerLog,
      signal: abortSignal(this.token),
      onOutput: (line) => this.io.log(`lldb-server: ${line}`),
    });
    this.onCleanup(() => platform.stop());
    this.checkCancelled();

    const lldbConfig = buildLldbAttachConfig({
      name: `Local Desktop native (${label}, pid ${pid})`,
      pid,
      serial,
      socketPath: platform.socket.path,
      symbolDirs,
      rust,
      stopOnEntry: config.stopOnEntry,
      initCommands: config.initCommands,
      preRunCommands: config.preRunCommands,
      postRunCommands: config.postRunCommands,
      exitCommands: config.exitCommands,
      sourceMap: config.sourceMap,
      lldb: config.lldb,
      meta: { parent: this.parent.id, serial, pid },
    });
    this.io.log("Attaching LLDB (the first attach downloads system libraries and can take a while)…");
    const started = await vscode.debug.startDebugging(this.folder(root), lldbConfig as vscode.DebugConfiguration, {
      parentSession: this.parent,
      lifecycleManagedByParent: true,
      compact: true,
      consoleMode: vscode.DebugConsoleMode.MergeWithParent,
    });
    if (!started) {
      throw new LdError("LAUNCH_FAILED", "CodeLLDB couldn't attach to the app.", "Set lldbServerLog: true in launch.json and check lldb/platform.log in the app's data dir.");
    }
    this.onCleanup(async () => {
      if (this.child) await vscode.debug.stopDebugging(this.child);
    });
    this.io.log("Native debugger attached. Breakpoints bind once liblocaldesktop.so is loaded.");
  }

  private async checkAbi(serial: string, noDebug: boolean): Promise<"ok" | "noDebug"> {
    const info = await this.s.devices.info(serial);
    if (info.abi === "arm64-v8a") return "ok";
    if (!info.abiList.includes("arm64-v8a")) {
      throw new LdError("UNSUPPORTED_ABI", `${info.model || serial} is ${info.abi || "an unknown ABI"}; Local Desktop is built for arm64-v8a only.`, "Use an arm64 phone or an arm64 emulator image.");
    }
    if (noDebug) return "ok";
    const choice = await vscode.window.showWarningMessage(
      `${info.model || serial} runs arm64 code through translation (${info.abi}), so native debugging isn't possible.`,
      "Run Without Debugging",
    );
    if (!choice) throw new LdError("CANCELLED", "Debug session cancelled.");
    return "noDebug";
  }

  private async locateLldbServer(config: LocalDesktopDebugConfig): Promise<string> {
    const paths = { ...this.s.toolPaths() };
    if (config.lldbServer) paths.lldbServerPath = config.lldbServer;
    return findLldbServer(paths);
  }

  private async buildApk(root: string, profile: Profile, config: LocalDesktopDebugConfig): Promise<string> {
    if (config.apk) {
      const apk = path.resolve(root, config.apk);
      if (!fs.existsSync(apk)) throw new LdError("APK_NOT_FOUND", `APK not found: ${apk}`);
      return apk;
    }
    if (config.build !== false) {
      this.io.log(`Building the ${profile} APK with xbuild (see the terminal for progress)…`);
      try {
        await buildWithTask(root, profile, this.s.toolPaths(), this.token);
      } catch (e) {
        const previous = isLdError(e, "BUILD_FAILED") ? findApk(root, profile) : undefined;
        if (!previous) throw e;
        const when = new Date(fs.statSync(previous).mtimeMs).toLocaleString();
        const choice = await vscode.window.showErrorMessage(`${(e as LdError).message} Debug the previous APK (built ${when}) instead?`, "Use Previous APK");
        if (!choice) throw e;
        this.io.log(`Build failed; using the previous APK from ${when}.`);
      }
    }
    const apk = findApk(root, profile);
    if (!apk) {
      throw new LdError("APK_NOT_FOUND", `No ${profile} APK under target/x/${profile}/android.`, "Build it first (set build: true) or point apk at a file.");
    }
    return apk;
  }

  private symbolDirs(root: string, profile: Profile, app: AppInfo, config: LocalDesktopDebugConfig): string[] {
    const extra = (config.symbolSearchPaths ?? []).map((p) => path.resolve(root, p));
    const dirs = [...extra, ...buildArtifacts(root, profile).symbolDirs].filter((d) => fs.existsSync(d));
    const lib = `lib${app.libName}.so`;
    const withLib = dirs.find((d) => fs.existsSync(path.join(d, lib)));
    if (!withLib) {
      this.io.output(`Warning: no local ${lib} found; LLDB will only see the stripped copy from the device.\n`, "stderr");
    } else {
      const elf = inspectElfFile(path.join(withLib, lib));
      if (elf && !elf.hasDebugInfo) {
        this.io.output(`Warning: ${path.join(withLib, lib)} has no debug info (release profile?), so breakpoints won't bind.\n`, "stderr");
      } else if (elf) {
        this.io.log(`Symbols: ${path.join(withLib, lib)}${elf.buildId ? ` (build-id ${elf.buildId.slice(0, 12)}…)` : ""}`);
      }
    }
    return dirs;
  }

  private mirrorLogcat(mode: NonNullable<LocalDesktopDebugConfig["logcat"]>): void {
    if (mode === "none") return;
    const keep = consoleFilter(mode);
    let lastKept = false;
    const sub = this.s.logcat.onLine(({ raw, entry }: { raw: string; entry?: LogEntry }) => {
      if (!entry) {
        if (lastKept) this.io.output(raw + "\n", "stdout");
        return;
      }
      lastKept = keep(entry);
      if (lastKept) this.io.output(raw + "\n", entry.level === "E" || entry.level === "F" ? "stderr" : "stdout");
    });
    this.onCleanup(() => sub.dispose());
  }

  /** In run-without-debugging mode, end the session when the app process goes away. */
  private watchProcess(adb: Adb, pkg: string, pid: number): void {
    const timer = setInterval(async () => {
      const current = await pidof(adb, pkg).catch(() => pid);
      if (current !== pid && !this.disposed) {
        clearInterval(timer);
        this.onEnded(current ? `app restarted (pid ${current})` : "app exited");
      }
    }, 3000);
    this.onCleanup(() => clearInterval(timer));
  }

  /** Undoes everything in reverse order. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel.cancel();
    this.subs.forEach((d) => d.dispose());
    for (const fn of this.cleanups.reverse()) {
      try {
        await fn();
      } catch (e) {
        this.s.output.debug(`Debug cleanup step failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.cleanups.length = 0;
    this.cancel.dispose();
  }
}
