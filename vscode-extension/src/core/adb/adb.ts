import { LdError } from "../errors";
import { execFile, spawnLines, type ExecOptions, type ExecResult, type LineProcess } from "../exec";
import { shJoin } from "../shell";

export interface AdbRunOptions extends ExecOptions {
  /** Don't throw on a non-zero exit status. */
  allowFailure?: boolean;
}

/**
 * Thin wrapper over the adb binary. Every call takes an argument array; device-side commands are
 * passed to `adb shell` as ONE pre-quoted string so the device's sh parses them exactly once.
 */
export class Adb {
  constructor(
    readonly adbPath: string,
    readonly serial?: string,
  ) {}

  forDevice(serial: string): Adb {
    return new Adb(this.adbPath, serial);
  }

  private args(args: readonly string[]): string[] {
    return this.serial ? ["-s", this.serial, ...args] : [...args];
  }

  async exec(args: readonly string[], opts: AdbRunOptions = {}): Promise<ExecResult> {
    const result = await execFile(this.adbPath, this.args(args), { timeoutMs: 60_000, ...opts }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new LdError("ADB_MISSING", `adb not found at ${this.adbPath}`);
      throw e;
    });
    if (result.timedOut) throw new LdError("TIMEOUT", `adb ${args.join(" ")} timed out`);
    if (!opts.allowFailure && result.code !== 0) {
      throw adbFailure(args, result);
    }
    return result;
  }

  /** `adb <args>` → stdout as text. */
  async run(args: readonly string[], opts: AdbRunOptions = {}): Promise<string> {
    return (await this.exec(args, opts)).stdout.toString("utf8");
  }

  /** Runs a command on the device. `cmd` is either a raw shell line or words to quote. */
  async shell(cmd: string | readonly string[], opts: AdbRunOptions = {}): Promise<string> {
    const line = typeof cmd === "string" ? cmd : shJoin(cmd);
    return this.run(["shell", line], opts);
  }

  /** Like shell() but returns the full result (exit code, stderr) without throwing. */
  async shellResult(cmd: string | readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const line = typeof cmd === "string" ? cmd : shJoin(cmd);
    return this.exec(["shell", line], { ...opts, allowFailure: true });
  }

  /** `adb exec-out` for binary output (screencap). */
  async execOut(cmd: string | readonly string[], opts: AdbRunOptions = {}): Promise<Buffer> {
    const line = typeof cmd === "string" ? cmd : shJoin(cmd);
    return (await this.exec(["exec-out", line], opts)).stdout;
  }

  spawnLines(args: readonly string[], onLine: (line: string) => void, onStderr?: (text: string) => void): LineProcess {
    return spawnLines(this.adbPath, this.args(args), onLine, { onStderr });
  }
}

export function adbFailure(args: readonly string[], result: ExecResult): LdError {
  const out = (result.stderr || result.stdout.toString("utf8")).trim();
  const lower = out.toLowerCase();
  if (lower.includes("no devices/emulators found")) {
    return new LdError("NO_DEVICE", "No Android device is connected.", "Plug in a phone with USB debugging enabled, or pair one over Wi‑Fi.");
  }
  if (lower.includes("more than one device")) {
    return new LdError("MULTIPLE_DEVICES", "More than one device is connected; choose one.", "Select a device (or pass a serial).");
  }
  if (lower.includes("unauthorized")) {
    return new LdError("DEVICE_UNAUTHORIZED", "The device hasn't authorized this computer.", "Unlock the device and accept the USB debugging prompt.");
  }
  const notFound = /device '([^']+)' not found/.exec(out);
  if (notFound) return new LdError("DEVICE_NOT_FOUND", `Device ${notFound[1]} is not connected.`);
  if (lower.includes("device offline")) {
    return new LdError("DEVICE_OFFLINE", "The device is offline.", "Reconnect the cable, or run `adb reconnect offline`.");
  }
  return new LdError("ADB_FAILED", `adb ${args.join(" ")} failed (exit ${result.code}): ${out.slice(0, 2000)}`);
}
