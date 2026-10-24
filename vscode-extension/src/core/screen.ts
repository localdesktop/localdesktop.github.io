import * as fs from "node:fs";
import * as path from "node:path";
import type { Adb } from "./adb/adb";
import { LdError } from "./errors";
import { wakeAndUnlock } from "./power";

/** Width/height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new LdError("COMMAND_FAILED", "Not a PNG (screencap failed?)");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Physical id of the display apps run on (logical display 0), for phones with several screens. */
async function appDisplayId(adb: Adb): Promise<string | undefined> {
  const ids = await adb.shell("dumpsys SurfaceFlinger --display-id", { allowFailure: true });
  if ((ids.match(/^Display \d+/gm) ?? []).length < 2) return undefined;
  const display = await adb.shell("dumpsys display", { allowFailure: true, timeoutMs: 20_000 });
  return /mDisplayId=0\s+mPrimaryDisplayDevice=[^\n]*\(local:(\d+)\)/.exec(display)?.[1];
}

/** `adb exec-out screencap -p` (Local Desktop doesn't set FLAG_SECURE, so this captures the desktop). */
export async function captureScreen(adb: Adb): Promise<Buffer> {
  const id = await appDisplayId(adb);
  let png = await adb.execOut(id ? `screencap -p -d ${id}` : "screencap -p", { timeoutMs: 30_000 });
  const start = png.indexOf(PNG_SIGNATURE);
  if (start > 0) png = png.subarray(start);
  pngSize(png);
  return png;
}

export function timestampName(prefix: string, ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

export async function saveScreenshot(adb: Adb, dir: string): Promise<{ file: string; png: Buffer; width: number; height: number }> {
  await wakeAndUnlock(adb);
  const png = await captureScreen(adb);
  const { width, height } = pngSize(png);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, timestampName("screenshot", "png"));
  fs.writeFileSync(file, png);
  return { file, png, width, height };
}
