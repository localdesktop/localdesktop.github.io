import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { forceStop, getUid, installApk, sha256File, startApp } from "../core/adb/app";
import type { AdbDevice } from "../core/adb/devices";
import { deviceEpoch } from "../core/adb/props";
import { findScrcpy } from "../core/env";
import { formatChecks, runDoctor, type Check } from "../core/doctor";
import { LdError } from "../core/errors";
import { LOCKED_HINT } from "../core/power";
import { saveScreenshot } from "../core/screen";
import { readState, updateState } from "../core/state";
import { findApk, localDir } from "../core/workspace";
import { requireRoot, type Services } from "./services";
import { buildWithTask, installXbuildWithTask } from "./tasks";
import { abortSignal, registerCommand, withProgress } from "./ui";

/** Accepts a tree item argument (AdbDevice) or nothing (use/ask for the selected device). */
async function targetDevice(s: Services, arg: unknown): Promise<AdbDevice> {
  const serial = arg && typeof arg === "object" && "serial" in arg ? String((arg as AdbDevice).serial) : undefined;
  return s.devices.resolve(serial);
}

/**
 * Installs an APK on a device, reusing the last-install hash to skip identical installs.
 * Exported for the debug orchestrator and the Releases view ("Install on device").
 */
export async function installOnDevice(
  s: Services,
  serial: string,
  apk: string,
  opts: { token?: vscode.CancellationToken; force?: boolean; progress?: vscode.Progress<{ message?: string }> } = {},
): Promise<"installed" | "unchanged"> {
  const root = s.root;
  const app = s.app();
  const adb = s.devices.adb().forDevice(serial);
  const hash = sha256File(apk);
  if (!opts.force && root) {
    const installed = readState(root).installHash?.[serial] === hash && (await getUid(adb, app.packageName)) !== undefined;
    if (installed) return "unchanged";
  }
  opts.progress?.report({ message: `Installing ${vscode.workspace.asRelativePath(apk)}…` });
  try {
    await installApk(adb, apk, { signal: opts.token ? abortSignal(opts.token) : undefined });
  } catch (e) {
    if (e instanceof LdError && e.code === "INSTALL_FAILED" && /newer version/.test(e.message)) {
      const ok = await vscode.window.showWarningMessage(`${e.message} Install anyway (downgrade)?`, { modal: true }, "Downgrade");
      if (!ok) throw new LdError("CANCELLED", "Install cancelled.");
      await installApk(adb, apk, { allowDowngrade: true });
    } else {
      throw e;
    }
  }
  if (root) {
    updateState(root, (st) => {
      st.installHash = { ...st.installHash, [serial]: hash };
    });
  }
  // A fresh install can change the uid; retarget logcat and refresh the tree details.
  void s.logcat.follow(serial, { refreshUid: true });
  void s.devices.loadDetails(serial);
  return "installed";
}

export function registerDeviceCommands(s: Services): void {
  const { context, output } = s;
  const reg = (id: string, fn: (...args: any[]) => unknown) => registerCommand(context, id, fn, output);

  reg("localdesktop.devices.refresh", () => s.devices.refresh());

  reg("localdesktop.devices.select", async (arg?: unknown) => {
    if (arg && typeof arg === "object" && "serial" in arg) s.devices.setSelected((arg as AdbDevice).serial);
    else await s.devices.pick();
  });

  reg("localdesktop.doctor", async () => {
    const root = requireRoot(s.root);
    const extra: Check[] = [];
    const lldb = vscode.extensions.getExtension("vadimcn.vscode-lldb");
    const version: string | undefined = lldb?.packageJSON?.version;
    extra.push(
      !lldb
        ? { id: "codelldb", label: "CodeLLDB", status: "warn", detail: "Not installed (needed for breakpoints).", fix: "Install vadimcn.vscode-lldb" }
        : version === "1.11.2" || version === "1.11.3"
          ? { id: "codelldb", label: "CodeLLDB", status: "error", detail: `${version} can't attach to Android processes.`, fix: "Update CodeLLDB to 1.11.4 or newer." }
          : { id: "codelldb", label: "CodeLLDB", status: "ok", detail: version ?? "installed" },
    );
    const checks = await withProgress("Checking the Local Desktop toolchain…", () => runDoctor(root, s.toolPaths(), extra));
    output.info(`Environment check:\n${formatChecks(checks)}`);
    const errors = checks.filter((c) => c.status === "error");
    const warnings = checks.filter((c) => c.status === "warn");
    const summary = errors.length ? `${errors.length} problem(s): ${errors.map((c) => c.label).join(", ")}` : warnings.length ? `OK with ${warnings.length} warning(s)` : "Everything looks good.";
    const show = await (errors.length ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(`Local Desktop: ${summary}`, "Show Details");
    if (show) output.show(true);
  });

  reg("localdesktop.build.debug", async () => {
    await buildWithTask(requireRoot(s.root), "debug", s.toolPaths());
    void vscode.window.showInformationMessage("Debug APK built.", "Install on Device").then((c) => c && vscode.commands.executeCommand("localdesktop.devices.installApk"));
  });

  reg("localdesktop.build.release", async () => {
    await buildWithTask(requireRoot(s.root), "release", s.toolPaths());
    void vscode.window.showInformationMessage("Release build finished (the installable debug-signed APK is next to it).");
  });

  reg("localdesktop.build.installXbuild", async () => {
    const ok = await installXbuildWithTask(requireRoot(s.root));
    if (ok) void vscode.window.showInformationMessage("Patched xbuild installed.");
  });

  reg("localdesktop.devices.installApk", async (arg?: unknown, opts?: { replace?: boolean; serial?: string }) => {
    let apk: string | undefined;
    if (arg instanceof vscode.Uri) apk = arg.fsPath;
    else if (typeof arg === "string") apk = arg;
    if (!apk) {
      const root = s.root;
      const built = root ? (findApk(root, "debug") ?? findApk(root, "release")) : undefined;
      const picks: (vscode.QuickPickItem & { path?: string })[] = [];
      if (built) picks.push({ label: "$(package) Latest local build", description: vscode.workspace.asRelativePath(built), path: built });
      picks.push({ label: "$(folder-opened) Choose an APK file…" });
      const choice = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks, { title: "Install which APK?" });
      if (!choice) return;
      if (choice.path) apk = choice.path;
      else {
        const uris = await vscode.window.showOpenDialog({ filters: { "Android package": ["apk"] }, canSelectMany: false });
        apk = uris?.[0]?.fsPath;
      }
    }
    if (!apk) return;
    const device = await s.devices.resolve(opts?.serial);
    const result = await withProgress(`Installing on ${s.devices.label(device)}`, (progress, token) =>
      installOnDevice(s, device.serial, apk!, { token, progress, force: opts?.replace ?? true }),
    );
    const start = await vscode.window.showInformationMessage(
      result === "unchanged" ? "That APK is already installed." : `Installed on ${s.devices.label(device)}.`,
      "Start App",
    );
    if (start) await vscode.commands.executeCommand("localdesktop.app.start", device);
  });

  reg("localdesktop.app.start", async (arg?: unknown) => {
    const d = await targetDevice(s, arg);
    const adb = s.devices.adb().forDevice(d.serial);
    const pkg = s.app().packageName;
    const since = await deviceEpoch(adb).catch(() => undefined);
    const screen = await startApp(adb, pkg);
    if (screen.locked) void vscode.window.showWarningMessage(LOCKED_HINT);
    s.logcat.marker(`started ${pkg}`);
    void s.logcat.follow(d.serial, { sinceEpoch: since });
  });

  reg("localdesktop.app.stop", async (arg?: unknown) => {
    const d = await targetDevice(s, arg);
    await forceStop(s.devices.adb().forDevice(d.serial), s.app().packageName);
    s.logcat.marker("app stopped");
  });

  reg("localdesktop.app.restart", async (arg?: unknown) => {
    const d = await targetDevice(s, arg);
    const adb = s.devices.adb().forDevice(d.serial);
    const pkg = s.app().packageName;
    const since = await deviceEpoch(adb).catch(() => undefined);
    const screen = await startApp(adb, pkg, { restart: true });
    if (screen.locked) void vscode.window.showWarningMessage(LOCKED_HINT);
    s.logcat.marker(`restarted ${pkg}`);
    void s.logcat.follow(d.serial, { sinceEpoch: since });
  });

  reg("localdesktop.devices.screenshot", async (arg?: unknown) => {
    const d = await targetDevice(s, arg);
    const root = requireRoot(s.root);
    const shot = await saveScreenshot(s.devices.adb().forDevice(d.serial), localDir(root, "screenshots"));
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(shot.file), { preview: true });
  });

  reg("localdesktop.devices.mirror", async (arg?: unknown) => {
    const d = await targetDevice(s, arg);
    const scrcpy = findScrcpy(s.toolPaths());
    if (!scrcpy) {
      throw new LdError("SCRCPY_MISSING", "scrcpy is not installed.", process.platform === "darwin" ? "Install it with `brew install scrcpy`." : "Install scrcpy ≥ 2.1.");
    }
    const child = spawn(scrcpy, ["-s", d.serial, "--window-title", `Local Desktop — ${s.devices.label(d)}`], { stdio: "ignore", detached: true });
    child.on("error", (e) => output.error(`scrcpy: ${e.message}`));
    child.unref();
  });

  reg("localdesktop.logcat.show", async (arg?: unknown) => {
    if (arg && typeof arg === "object" && "serial" in arg) await s.logcat.follow((arg as AdbDevice).serial);
    else if (s.devices.selectedDevice) await s.logcat.follow(s.devices.selectedDevice.serial);
    s.logcat.show();
  });
  reg("localdesktop.logcat.clear", () => s.logcat.clear());
  reg("localdesktop.logcat.filter", () => s.logcat.pickFilter());
  reg("localdesktop.logcat.openFile", async () => {
    const file = s.logcat.logFile;
    if (file) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
  });
}
