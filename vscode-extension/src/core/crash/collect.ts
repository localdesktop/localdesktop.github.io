import type { Adb } from "../adb/adb";

export type CrashKind = "native" | "java" | "anr" | "panic";

export interface CrashReport {
  kind: CrashKind;
  /** When it happened, as printed by the source. */
  time?: string;
  source: string;
  text: string;
}

const DROPBOX_TAGS: Record<string, CrashKind> = {
  data_app_native_crash: "native",
  data_app_crash: "java",
  data_app_anr: "anr",
};

/** Splits `dumpsys dropbox --print <tag>` into entries and keeps those mentioning the package. */
export function parseDropbox(output: string, pkg: string, kind: CrashKind, tag: string): CrashReport[] {
  const reports: CrashReport[] = [];
  const parts = output.split(/^={20,}\s*$/m);
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    const header = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+)/m.exec(text);
    if (!header || header[2] !== tag) continue;
    if (!text.includes(pkg)) continue;
    reports.push({ kind, time: header[1], source: `dropbox:${tag}`, text });
  }
  return reports;
}

/** Rust panics from RustStdoutStderr lines: "thread '…' panicked at …" plus the following lines. */
export function extractPanics(logText: string): CrashReport[] {
  const lines = logText.split(/\r?\n/);
  const reports: CrashReport[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/RustStdoutStderr.*panicked at/.test(lines[i]!)) continue;
    const pid = /^\S+\s+\S+\s+(\d+)/.exec(lines[i]!)?.[1];
    const block = [lines[i]!];
    for (let j = i + 1; j < lines.length && block.length < 120; j++) {
      const l = lines[j]!;
      if (/RustStdoutStderr/.test(l) && (!pid || l.includes(` ${pid} `))) block.push(l);
      else if (/panicked at/.test(l)) break;
    }
    reports.push({ kind: "panic", time: /^(\S+\s+\S+)/.exec(lines[i]!)?.[1], source: "logcat:RustStdoutStderr", text: block.join("\n") });
    i += block.length - 1;
  }
  return reports;
}

/** Native crash dumps from the crash buffer (logged by debuggerd as tag DEBUG), for the package. */
export function extractCrashBuffer(logText: string, pkg: string): CrashReport[] {
  const lines = logText.split(/\r?\n/);
  const reports: CrashReport[] = [];
  let current: string[] | undefined;
  let mentions = false;
  const flush = () => {
    if (current && mentions) reports.push({ kind: "native", time: /^(\S+\s+\S+)/.exec(current[0]!)?.[1], source: "logcat:crash", text: current.join("\n") });
    current = undefined;
    mentions = false;
  };
  for (const l of lines) {
    if (/ F DEBUG\s*: \*\*\* \*\*\* \*\*\*/.test(l) || / E AndroidRuntime: FATAL EXCEPTION/.test(l)) {
      flush();
      current = [l];
      continue;
    }
    if (current) {
      if (/ (F DEBUG|E AndroidRuntime)\s*:/.test(l)) {
        current.push(l);
        if (l.includes(pkg)) mentions = true;
      } else if (current.length > 3) flush();
    }
  }
  flush();
  return reports;
}

export async function collectCrashes(adb: Adb, pkg: string, uid: number | undefined, max = 3): Promise<CrashReport[]> {
  const out: CrashReport[] = [];
  for (const [tag, kind] of Object.entries(DROPBOX_TAGS)) {
    const text = await adb.shell(`dumpsys dropbox --print ${tag}`, { allowFailure: true, timeoutMs: 30_000 });
    out.push(...parseDropbox(text, pkg, kind, tag));
  }
  const crashBuffer = await adb.shell("logcat -d -v threadtime -v year -b crash", { allowFailure: true, timeoutMs: 30_000 });
  const fromBuffer = extractCrashBuffer(crashBuffer, pkg);
  // The crash buffer and dropbox usually hold the same native crash; prefer dropbox (full tombstone).
  if (!out.some((r) => r.kind === "native")) out.push(...fromBuffer);
  const main = await adb.shell(`logcat -d -v threadtime -v year -b main${uid !== undefined ? ` --uid=${uid}` : ""}`, { allowFailure: true, timeoutMs: 30_000 });
  out.push(...extractPanics(main));
  out.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  return out.slice(-max);
}
