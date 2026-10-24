import type { Adb } from "./adb/adb";
import { LdError } from "./errors";
import { shQuote } from "./shell";

/** Friendly key names → Android KEYCODE_* names (input keyevent accepts names or numbers). */
const KEY_ALIASES: Record<string, string> = {
  enter: "ENTER",
  return: "ENTER",
  back: "BACK",
  home: "HOME",
  menu: "MENU",
  tab: "TAB",
  space: "SPACE",
  escape: "ESCAPE",
  esc: "ESCAPE",
  backspace: "DEL",
  delete: "FORWARD_DEL",
  del: "FORWARD_DEL",
  up: "DPAD_UP",
  down: "DPAD_DOWN",
  left: "DPAD_LEFT",
  right: "DPAD_RIGHT",
  pageup: "PAGE_UP",
  pagedown: "PAGE_DOWN",
  ctrl: "CTRL_LEFT",
  control: "CTRL_LEFT",
  alt: "ALT_LEFT",
  shift: "SHIFT_LEFT",
  meta: "META_LEFT",
  super: "META_LEFT",
  win: "META_LEFT",
  cmd: "META_LEFT",
  power: "POWER",
  volumeup: "VOLUME_UP",
  volumedown: "VOLUME_DOWN",
  appswitch: "APP_SWITCH",
  recents: "APP_SWITCH",
  wakeup: "WAKEUP",
};

/** "ctrl" → "KEYCODE_CTRL_LEFT", "a" → "KEYCODE_A", "f5" → "KEYCODE_F5", "66" → "66". */
export function keycodeName(key: string): string {
  const k = key.trim();
  if (/^\d+$/.test(k)) return k;
  if (/^KEYCODE_[A-Z0-9_]+$/.test(k)) return k;
  const alias = KEY_ALIASES[k.toLowerCase()];
  if (alias) return `KEYCODE_${alias}`;
  if (/^[a-z0-9]$/i.test(k)) return `KEYCODE_${k.toUpperCase()}`;
  if (/^f([1-9]|1[0-2])$/i.test(k)) return `KEYCODE_${k.toUpperCase()}`;
  if (/^[A-Z0-9_]+$/i.test(k)) return `KEYCODE_${k.toUpperCase()}`;
  throw new LdError("INVALID_ARGUMENT", `Unknown key "${key}".`, "Use names like enter, back, home, tab, ctrl+c, alt+tab, f5, or KEYCODE_* names.");
}

/** Escapes text for `input text` (spaces become %s; everything is shell-quoted). ASCII only. */
export function inputTextArg(text: string): string {
  if (/[^\x20-\x7e]/.test(text)) {
    throw new LdError("INVALID_ARGUMENT", "`input text` only supports printable ASCII.", "Split non-ASCII text out, or paste it via the guest's clipboard.");
  }
  return shQuote(text.replace(/%/g, "\\%").replace(/ /g, "%s"));
}

export interface Point {
  x: number;
  y: number;
}

function round(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export async function tap(adb: Adb, p: Point): Promise<void> {
  const { x, y } = round(p);
  await adb.shell(`input tap ${x} ${y}`);
}

export async function longPress(adb: Adb, p: Point, durationMs = 800): Promise<void> {
  const { x, y } = round(p);
  await adb.shell(`input swipe ${x} ${y} ${x} ${y} ${Math.round(durationMs)}`);
}

export async function swipe(adb: Adb, from: Point, to: Point, durationMs = 300): Promise<void> {
  const a = round(from);
  const b = round(to);
  await adb.shell(`input swipe ${a.x} ${a.y} ${b.x} ${b.y} ${Math.round(durationMs)}`);
}

/** Drag with a press-and-hold first, which desktop apps need to start a drag. */
export async function drag(adb: Adb, from: Point, to: Point, durationMs = 600): Promise<void> {
  const a = round(from);
  const b = round(to);
  await adb.shell(`input draganddrop ${a.x} ${a.y} ${b.x} ${b.y} ${Math.round(durationMs)}`).catch(() => swipe(adb, a, b, durationMs));
}

export async function typeText(adb: Adb, text: string): Promise<void> {
  // Long strings overflow the input command's buffer on some devices; send in chunks.
  for (let i = 0; i < text.length; i += 200) {
    await adb.shell(`input text ${inputTextArg(text.slice(i, i + 200))}`);
  }
}

/**
 * Presses a key or a chord ("enter", "ctrl+c", "alt+tab"). Chords use `input keycombination`
 * (Android 13+); single keys use `input keyevent`.
 */
export async function pressKey(adb: Adb, key: string, opts: { longPress?: boolean; sdk?: number } = {}): Promise<void> {
  const parts = key.split("+").map((k) => k.trim()).filter(Boolean);
  if (parts.length === 0) throw new LdError("INVALID_ARGUMENT", "No key given.");
  const codes = parts.map(keycodeName);
  if (codes.length === 1) {
    await adb.shell(`input keyevent ${opts.longPress ? "--longpress " : ""}${codes[0]}`);
    return;
  }
  if (opts.sdk !== undefined && opts.sdk < 33) {
    throw new LdError("INVALID_ARGUMENT", `Key combinations need Android 13+ (device is API ${opts.sdk}).`);
  }
  const out = await adb.shell(`input keycombination ${codes.join(" ")}`, { allowFailure: true });
  if (/Error|Unknown command|usage:/i.test(out)) {
    throw new LdError("COMMAND_FAILED", `This device's input command doesn't support keycombination: ${out.trim().split("\n")[0]}`);
  }
}

/** Mouse events (desktop-style clicks/scroll) via the mouse input source. */
export async function mouse(adb: Adb, action: "click" | "scroll" | "move", p: Point, opts: { scrollV?: number; scrollH?: number } = {}): Promise<void> {
  const { x, y } = round(p);
  switch (action) {
    case "click":
      await adb.shell(`input mouse tap ${x} ${y}`);
      return;
    case "move":
      await adb.shell(`input mouse motionevent HOVER_MOVE ${x} ${y}`).catch(() => adb.shell(`input mouse swipe ${x} ${y} ${x} ${y} 10`));
      return;
    case "scroll": {
      const args = [`--axis VSCROLL,${opts.scrollV ?? 0}`];
      if (opts.scrollH) args.push(`--axis HSCROLL,${opts.scrollH}`);
      await adb.shell(`input mouse scroll ${x} ${y} ${args.join(" ")}`);
      return;
    }
  }
}
