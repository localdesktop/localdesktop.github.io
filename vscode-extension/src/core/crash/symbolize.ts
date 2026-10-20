import * as fs from "node:fs";
import * as path from "node:path";
import { findNdkTool, type ToolPaths } from "../env";
import { execFile } from "../exec";

export interface NativeFrame {
  index: number;
  pc: string;
  /** Library basename (e.g. liblocaldesktop.so). */
  lib: string;
  line: string;
}

/** Tombstone backtrace frames: "#05 pc 00000000001a2b3c  /data/app/…/lib/arm64/liblocaldesktop.so (…)". */
export function parseFrames(text: string): NativeFrame[] {
  const frames: NativeFrame[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /#(\d+)\s+pc\s+([0-9a-fA-F]+)\s+(\S+)/.exec(line);
    if (!m) continue;
    frames.push({ index: parseInt(m[1]!, 10), pc: m[2]!, lib: path.basename(m[3]!), line });
  }
  return frames;
}

/**
 * Symbolizes frames from our own libraries with llvm-symbolizer against the unstripped .so files
 * (the APK copies are stripped). Returns the text with "→ function (file:line)" annotations.
 */
export async function symbolize(text: string, symbolDirs: string[], paths: ToolPaths = {}): Promise<{ text: string; symbolized: number; tool?: string }> {
  const frames = parseFrames(text);
  if (!frames.length) return { text, symbolized: 0 };
  const tool = findNdkTool("llvm-symbolizer", paths) ?? findNdkTool("llvm-addr2line", paths);
  if (!tool) return { text, symbolized: 0 };
  const byLib = new Map<string, NativeFrame[]>();
  for (const f of frames) {
    const obj = symbolDirs.map((d) => path.join(d, f.lib)).find((p) => fs.existsSync(p));
    if (!obj) continue;
    byLib.set(obj, [...(byLib.get(obj) ?? []), f]);
  }
  const annotations = new Map<string, string>();
  for (const [obj, libFrames] of byLib) {
    const args = path.basename(tool).startsWith("llvm-symbolizer")
      ? ["--obj", obj, "--functions=linkage", "--demangle", "--no-inlines", ...libFrames.map((f) => `0x${f.pc}`)]
      : ["-e", obj, "-f", "-C", ...libFrames.map((f) => `0x${f.pc}`)];
    const res = await execFile(tool, args, { timeoutMs: 60_000 }).catch(() => undefined);
    if (!res || res.code !== 0) continue;
    const out = res.stdout.toString("utf8").trim().split(/\r?\n/).filter((l) => l.trim() !== "");
    // llvm-symbolizer prints "function\nfile:line:col" per address (blank-separated); addr2line prints pairs too.
    for (let i = 0; i < libFrames.length && i * 2 + 1 < out.length; i++) {
      const fn = out[i * 2]!;
      const loc = out[i * 2 + 1]!;
      if (fn === "??" && loc.startsWith("??")) continue;
      annotations.set(libFrames[i]!.line, `${fn} (${loc.replace(/^.*?((?:src|patches)\/)/, "$1")})`);
    }
  }
  const lines = text.split(/\r?\n/).map((l) => (annotations.has(l) ? `${l}\n      → ${annotations.get(l)}` : l));
  return { text: lines.join("\n"), symbolized: annotations.size, tool };
}
