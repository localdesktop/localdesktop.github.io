import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { LdError } from "../errors";
import { sleep } from "../exec";
import { shQuote } from "../shell";
import type { Adb } from "./adb";
import { parseDumpsysPackage, parseInstallFailure, parseUidFromPmList, type PackageDump } from "./packages";

export const DEFAULT_ACTIVITY = "android.app.NativeActivity";

export async function getUid(adb: Adb, pkg: string): Promise<number | undefined> {
  const out = await adb.shell(["pm", "list", "packages", "-U", pkg], { allowFailure: true });
  const uid = parseUidFromPmList(out, pkg);
  if (uid !== undefined) return uid;
  const dump = await getPackageDump(adb, pkg);
  return dump?.userId;
}

export async function getPackageDump(adb: Adb, pkg: string): Promise<PackageDump | undefined> {
  const out = await adb.shell(["dumpsys", "package", pkg], { allowFailure: true, timeoutMs: 20_000 });
  return parseDumpsysPackage(out);
}

/** The launcher activity (falls back to NativeActivity, which xbuild always declares). */
export async function resolveActivity(adb: Adb, pkg: string): Promise<string> {
  const out = await adb.shell(["cmd", "package", "resolve-activity", "--brief", pkg], { allowFailure: true });
  const last = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
  const m = /^([\w.]+)\/([\w.$]+)$/.exec(last);
  if (m && m[1] === pkg) return m[2]!.startsWith(".") ? pkg + m[2] : m[2]!;
  return DEFAULT_ACTIVITY;
}

export interface StartOptions {
  /** Start suspended until a Java debugger attaches (`am start -D`). */
  waitForDebugger?: boolean;
  /** Force-stop first (`am start -S`). */
  restart?: boolean;
}

export async function startApp(adb: Adb, pkg: string, opts: StartOptions = {}): Promise<void> {
  const activity = await resolveActivity(adb, pkg);
  const args = ["am", "start"];
  if (opts.waitForDebugger) args.push("-D");
  if (opts.restart) args.push("-S");
  args.push("-n", `${pkg}/${activity}`, "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER");
  const out = await adb.shell(args);
  if (/^Error|Exception/m.test(out)) {
    throw new LdError("LAUNCH_FAILED", `Couldn't start ${pkg}: ${out.trim()}`, "Is the app installed? Run `install_apk` first.");
  }
}

export async function forceStop(adb: Adb, pkg: string): Promise<void> {
  await adb.shell(["am", "force-stop", pkg], { allowFailure: true });
}

export async function pidof(adb: Adb, pkg: string): Promise<number | undefined> {
  const out = await adb.shell(["pidof", "-s", pkg], { allowFailure: true });
  const n = parseInt(out.trim(), 10);
  if (Number.isFinite(n)) return n;
  // Very old toybox: fall back to ps.
  const procs = parseProcessList(await adb.shell("ps -A -o PID,UID,RSS,NAME", { allowFailure: true }));
  return procs.find((p) => p.name === pkg)?.pid;
}

export async function waitForPid(adb: Adb, pkg: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await pidof(adb, pkg);
    if (pid) return pid;
    await sleep(100, signal);
  }
  throw new LdError("LAUNCH_FAILED", `${pkg} did not start within ${timeoutMs / 1000}s.`);
}

export interface ProcessInfo {
  pid: number;
  uid?: number;
  rssKb?: number;
  name: string;
}

/** Parses `ps -A -o PID,UID,RSS,NAME` (toybox) output. */
export function parseProcessList(output: string): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const uid = /^\d+$/.test(m[2]!) ? parseInt(m[2]!, 10) : undefined;
    procs.push({ pid: parseInt(m[1]!, 10), uid, rssKb: parseInt(m[3]!, 10), name: m[4]! });
  }
  return procs;
}

/** Processes owned by the app's uid: the app itself, proot, pipewire, the AAudio sink, lldb-server… */
export async function appProcesses(adb: Adb, uid: number): Promise<ProcessInfo[]> {
  // -o UID prints names for system users on some builds; numeric uids are what we filter on.
  const out = await adb.shell("ps -A -n -o PID,UID,RSS,NAME", { allowFailure: true });
  let procs = parseProcessList(out);
  if (!procs.some((p) => p.uid !== undefined)) procs = parseProcessList(await adb.shell("ps -A -o PID,UID,RSS,NAME", { allowFailure: true }));
  return procs.filter((p) => p.uid === uid);
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export interface InstallOptions {
  /** Allow version downgrades (-d). */
  allowDowngrade?: boolean;
  signal?: AbortSignal;
}

/** `adb install -r -t`; maps failures to actionable errors. Never uninstalls (that wipes the Arch rootfs). */
export async function installApk(adb: Adb, apk: string, opts: InstallOptions = {}): Promise<void> {
  if (!fs.existsSync(apk)) throw new LdError("APK_NOT_FOUND", `APK not found: ${apk}`);
  const args = ["install", "-r", "-t"];
  if (opts.allowDowngrade) args.push("-d");
  args.push(apk);
  const res = await adb.exec(args, { allowFailure: true, timeoutMs: 15 * 60_000, signal: opts.signal });
  const text = `${res.stdout.toString("utf8")}\n${res.stderr}`;
  const failure = parseInstallFailure(text) ?? (res.code !== 0 ? { code: "UNKNOWN", message: text.trim() } : undefined);
  if (!failure) return;
  switch (failure.code) {
    case "INSTALL_FAILED_UPDATE_INCOMPATIBLE":
      throw new LdError(
        "SIGNATURE_MISMATCH",
        "The installed app is signed with a different key (e.g. from Google Play or a GitHub release).",
        "Uninstalling first would delete the app's data, including the Arch Linux rootfs. Uninstall manually only if that's OK.",
      );
    case "INSTALL_FAILED_VERSION_DOWNGRADE":
      throw new LdError("INSTALL_FAILED", "The device has a newer version installed.", "Retry allowing downgrade.");
    case "INSTALL_FAILED_NO_MATCHING_ABIS":
      throw new LdError("UNSUPPORTED_ABI", "This device's CPU isn't supported (the APK is arm64-v8a only).");
    case "INSTALL_FAILED_INSUFFICIENT_STORAGE":
      throw new LdError("INSTALL_FAILED", "Not enough storage on the device.");
    case "INSTALL_FAILED_USER_RESTRICTED":
      throw new LdError("INSTALL_FAILED", "Installation was blocked on the device.", 'Enable "Install via USB" in developer options (Xiaomi/Oppo) and accept the prompt.');
    default:
      throw new LdError("INSTALL_FAILED", `Install failed: ${failure.code}${failure.message ? ` (${failure.message})` : ""}`);
  }
}

/** Runs a command as the app's uid (requires a debuggable build). */
export function runAs(pkg: string, command: string): string {
  return `run-as ${shQuote(pkg)} sh -c ${shQuote(command)}`;
}

export async function assertDebuggable(adb: Adb, pkg: string): Promise<void> {
  const res = await adb.shellResult(runAs(pkg, "id -u"));
  const out = `${res.stdout.toString("utf8")}${res.stderr}`;
  if (res.code !== 0 || /not debuggable|unknown package|run-as:/i.test(out)) {
    throw new LdError(
      "NOT_DEBUGGABLE",
      `${pkg} on this device is not debuggable (${out.trim() || "run-as failed"}).`,
      "Install a debug build (F5 does this). A release build from Play/GitHub can't be debugged.",
    );
  }
}
