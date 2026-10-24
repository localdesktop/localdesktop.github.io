import * as fs from "node:fs";
import * as path from "node:path";
import { findScrcpy, type ToolPaths } from "../env";
import { LdError } from "../errors";
import { execFile } from "../exec";
import { timestampName } from "../screen";

export function parseScrcpyVersion(output: string): [number, number] | undefined {
  const m = /scrcpy\s+v?(\d+)\.(\d+)/i.exec(output);
  return m ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10)] : undefined;
}

function atLeast(v: [number, number], major: number, minor: number): boolean {
  return v[0] > major || (v[0] === major && v[1] >= minor);
}

/** scrcpy arguments for an audio-only WAV recording. */
export function scrcpyAudioArgs(serial: string, file: string, seconds: number, sdk: number, version: [number, number]): string[] {
  const args = ["-s", serial, "--no-video", "--no-window", "--no-control", "--no-audio-playback", "--require-audio", "--audio-codec=raw", `--record=${file}`, `--time-limit=${seconds}`];
  // Android 13+ with scrcpy ≥ 2.6 can capture app playback without muting the device.
  if (sdk >= 33 && atLeast(version, 2, 6)) args.push("--audio-source=playback", "--audio-dup");
  else args.push("--audio-source=output");
  return args;
}

/** Records device audio output to a WAV file with scrcpy (Android 11+). */
export async function recordAudio(serial: string, outDir: string, seconds: number, sdk: number, paths: ToolPaths = {}, signal?: AbortSignal): Promise<string> {
  if (sdk && sdk < 30) throw new LdError("INVALID_ARGUMENT", `Audio capture needs Android 11+ (device is API ${sdk}).`);
  const scrcpy = findScrcpy(paths);
  if (!scrcpy) {
    throw new LdError("SCRCPY_MISSING", "scrcpy is required to record audio.", process.platform === "darwin" ? "Install it with `brew install scrcpy`." : "Install scrcpy ≥ 2.1.");
  }
  const versionOut = await execFile(scrcpy, ["--version"], { timeoutMs: 10_000 });
  const version = parseScrcpyVersion(versionOut.stdout.toString("utf8"));
  if (!version || !atLeast(version, 2, 1)) {
    throw new LdError("SCRCPY_MISSING", `scrcpy ${version?.join(".") ?? "(unknown)"} is too old for raw WAV audio capture.`, "Update to scrcpy 2.1 or newer.");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, timestampName("audio", "wav"));
  const res = await execFile(scrcpy, scrcpyAudioArgs(serial, file, seconds, sdk, version), { timeoutMs: (seconds + 30) * 1000, signal });
  if (!fs.existsSync(file) || fs.statSync(file).size <= 44) {
    const err = (res.stderr || res.stdout.toString("utf8")).trim().split(/\r?\n/).slice(-5).join("\n");
    throw new LdError("COMMAND_FAILED", `scrcpy didn't produce audio: ${err}`, sdk < 33 ? "On Android 11/12 the device must be unlocked while recording." : undefined);
  }
  return file;
}
