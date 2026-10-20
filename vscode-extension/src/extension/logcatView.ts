import * as path from "node:path";
import * as vscode from "vscode";
import { getUid } from "../core/adb/app";
import { deviceEpoch } from "../core/adb/props";
import { compileFilter, LEVELS, type LogEntry, type LogFilter, type LogLevel } from "../core/logcat/parse";
import { LogcatStream, RotatingFileSink } from "../core/logcat/stream";
import { localDir } from "../core/workspace";
import type { DeviceManager } from "./deviceManager";

const LEVEL_NAMES: Record<LogLevel, string> = { V: "verbose", D: "debug", I: "info", W: "warning", E: "error", F: "fatal", S: "silent" };

/**
 * The "Local Desktop Logcat" output: follows the selected device, filtered by the app's uid (stable
 * across restarts, and it includes proot/pipewire children). Every line also goes to
 * .localdesktop/logs/logcat.log so agents can read it without the editor.
 */
export class LogcatView implements vscode.Disposable {
  readonly channel: vscode.OutputChannel;
  private stream: LogcatStream | undefined;
  private sink: RotatingFileSink | undefined;
  private target: { serial: string; uid?: number } | undefined;
  private filter: LogFilter = {};
  private match: (e: LogEntry) => boolean = () => true;
  private readonly lineEmitter = new vscode.EventEmitter<{ raw: string; entry?: LogEntry }>();
  /** Every received line, unfiltered (the debug session mirrors a subset into the Debug Console). */
  readonly onLine = this.lineEmitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly root: string | undefined,
    private readonly devices: DeviceManager,
    private readonly appPackage: () => string | undefined,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.channel = vscode.window.createOutputChannel("Local Desktop Logcat", "logcat");
    this.subs.push(
      devices.onDidChangeSelection((d) => {
        if (!this.autoStart()) return;
        if (d && d.state === "device") void this.follow(d.serial);
        else this.stop();
      }),
    );
  }

  get logFile(): string | undefined {
    return this.root ? path.join(localDir(this.root, "logs"), "logcat.log") : undefined;
  }

  private autoStart(): boolean {
    return vscode.workspace.getConfiguration("localdesktop").get<boolean>("logcat.autoStart", true);
  }

  /** Starts streaming once at activation if a device is already selected. */
  startIfConfigured(): void {
    const d = this.devices.selectedDevice;
    if (this.autoStart() && d?.state === "device") void this.follow(d.serial);
  }

  /**
   * (Re)targets the stream. Call after installs: a reinstall can change the uid.
   * `sinceEpoch` (device seconds) avoids replaying old lines.
   */
  async follow(serial: string, opts: { sinceEpoch?: number; refreshUid?: boolean } = {}): Promise<void> {
    const pkg = this.appPackage();
    const adb = this.devices.adb().forDevice(serial);
    let uid = this.target?.serial === serial && !opts.refreshUid ? this.target.uid : undefined;
    if (uid === undefined && pkg) uid = await getUid(adb, pkg).catch(() => undefined);
    if (this.stream && this.target?.serial === serial && this.target.uid === uid && opts.sinceEpoch === undefined) return;
    this.stop();
    if (uid === undefined) {
      this.channel.appendLine(`--- ${pkg ?? "app"} is not installed on ${serial}; logcat starts after the first install ---`);
      this.target = { serial };
      return;
    }
    const sinceEpoch = opts.sinceEpoch ?? (await deviceEpoch(adb).catch(() => undefined)) ?? undefined;
    this.target = { serial, uid };
    if (!this.sink && this.logFile) {
      const maxMb = vscode.workspace.getConfiguration("localdesktop").get<number>("logcat.maxFileMB", 10);
      this.sink = new RotatingFileSink(this.logFile, maxMb * 1024 * 1024);
    }
    const stream = new LogcatStream(adb, { uid, sinceEpoch });
    stream.on("line", (raw: string, entry: LogEntry | undefined) => {
      this.sink?.write(raw);
      this.lineEmitter.fire({ raw, entry });
      if (!entry || this.match(entry)) this.channel.appendLine(raw);
    });
    stream.on("status", (status: string) => {
      if (status === "reconnecting") this.output.debug(`logcat for ${serial} disconnected; reconnecting`);
    });
    stream.on("error", (e: Error) => this.channel.appendLine(`--- ${e.message} ---`));
    stream.start();
    this.stream = stream;
  }

  marker(text: string): void {
    const line = `--- ${new Date().toISOString()} ${text} ---`;
    this.channel.appendLine(line);
    this.sink?.write(line);
  }

  stop(): void {
    this.stream?.stop();
    this.stream = undefined;
  }

  show(): void {
    this.channel.show(true);
  }

  clear(): void {
    this.channel.clear();
  }

  async pickFilter(): Promise<void> {
    const level = await vscode.window.showQuickPick(
      LEVELS.slice(0, 6).map((l) => ({ label: l, description: LEVEL_NAMES[l] })),
      { title: "Minimum level", placeHolder: `Current: ${this.filter.minLevel ?? "V"}` },
    );
    if (!level) return;
    const grep = await vscode.window.showInputBox({
      title: "Filter (regex on tag and message, empty = everything)",
      value: this.filter.grep ?? "",
      placeHolder: "e.g. RustStdoutStderr|panicked|pipewire",
    });
    if (grep === undefined) return;
    this.filter = { minLevel: level.label as LogLevel, grep: grep || undefined };
    this.match = compileFilter(this.filter);
    this.marker(`filter: level>=${this.filter.minLevel}${this.filter.grep ? ` grep=/${this.filter.grep}/` : ""} (applies to new lines; the log file stays unfiltered)`);
  }

  dispose(): void {
    this.stop();
    this.sink?.close();
    this.subs.forEach((s) => s.dispose());
    this.lineEmitter.dispose();
    this.channel.dispose();
  }
}
