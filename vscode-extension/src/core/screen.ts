import * as fs from "node:fs";
import * as path from "node:path";
import type { Adb } from "./adb/adb";
import { LdError } from "./errors";

/** Width/height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new LdError("COMMAND_FAILED", "Not a PNG (screencap failed?)");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** `adb exec-out screencap -p` (Local Desktop doesn't set FLAG_SECURE, so this captures the desktop). */
export async function captureScreen(adb: Adb, display?: number): Promise<Buffer> {
  const cmd = display !== undefined ? `screencap -p -d ${display}` : "screencap -p";
  const png = await adb.execOut(cmd, { timeoutMs: 30_000 });
  // Some old devices translate \n to \r\n on exec-out; PNGs then fail to parse.
  pngSize(png);
  return png;
}

export function timestampName(prefix: string, ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

export async function saveScreenshot(adb: Adb, dir: string): Promise<{ file: string; png: Buffer; width: number; height: number }> {
  const png = await captureScreen(adb);
  const { width, height } = pngSize(png);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, timestampName("screenshot", "png"));
  fs.writeFileSync(file, png);
  return { file, png, width, height };
}
