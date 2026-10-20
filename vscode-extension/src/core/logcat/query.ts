import * as fs from "node:fs";
import type { Adb } from "../adb/adb";
import { compileFilter, isBufferMarker, parseLogLine, type LogFilter, type LogLevel } from "./parse";

export interface LogQuery extends LogFilter {
  uid?: number;
  /** Number of most recent lines to return (after filtering). */
  lines?: number;
  /** Device epoch seconds to start from. */
  sinceEpoch?: number;
  buffers?: string[];
  /** Cap the returned text (keeps the newest lines). */
  maxBytes?: number;
}

export interface LogQueryResult {
  text: string;
  lineCount: number;
  truncated: boolean;
  /** Which device-side filter was applied ("uid" normally, "none" on devices without --uid). */
  deviceFilter: "uid" | "none";
}

/** Snapshot of recent logcat (`logcat -d`), filtered on the device by uid where supported. */
export async function queryLogcat(adb: Adb, q: LogQuery): Promise<LogQueryResult> {
  const lines = q.lines ?? 200;
  const base = ["logcat", "-d", "-v", "threadtime", "-v", "year"];
  if (q.buffers?.length) base.push("-b", q.buffers.join(","));
  if (q.sinceEpoch !== undefined) base.push("-T", `${q.sinceEpoch}.000`);
  else if (!hasClientFilters(q)) base.push("-t", String(lines));
  else base.push("-t", String(Math.max(lines * 20, 5000)));

  let deviceFilter: "uid" | "none" = "none";
  let out: string;
  if (q.uid !== undefined) {
    const res = await adb.exec(["shell", [...base, `--uid=${q.uid}`].join(" ")], { allowFailure: true, timeoutMs: 30_000 });
    const text = res.stdout.toString("utf8");
    if (res.code === 0 && !/unrecognized option|invalid option/i.test(res.stderr + text.slice(0, 200))) {
      out = text;
      deviceFilter = "uid";
    } else {
      out = await adb.shell(base.join(" "), { timeoutMs: 30_000 });
    }
  } else {
    out = await adb.shell(base.join(" "), { timeoutMs: 30_000 });
  }
  return filterLogText(out, q, deviceFilter);
}

function hasClientFilters(q: LogFilter): boolean {
  return Boolean(q.minLevel || q.tags?.length || q.grep || q.pid !== undefined);
}

export function filterLogText(text: string, q: LogQuery, deviceFilter: "uid" | "none" = "none"): LogQueryResult {
  const match = compileFilter(q);
  const kept: string[] = [];
  let lastKept = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || isBufferMarker(raw)) continue;
    const e = parseLogLine(raw);
    if (!e) {
      // Continuation of a multi-line message: keep it with the preceding kept entry.
      if (lastKept) kept.push(raw);
      continue;
    }
    lastKept = match(e);
    if (lastKept) kept.push(raw);
  }
  let selected = q.lines !== undefined ? kept.slice(-q.lines) : kept;
  let truncated = selected.length < kept.length;
  const max = q.maxBytes ?? 32 * 1024;
  let out = selected.join("\n");
  while (Buffer.byteLength(out) > max && selected.length > 1) {
    selected = selected.slice(Math.ceil(selected.length / 10));
    out = selected.join("\n");
    truncated = true;
  }
  return { text: out, lineCount: selected.length, truncated, deviceFilter };
}

/** Reads the extension's persisted log file instead of the device. */
export function queryLogFile(file: string, q: LogQuery): LogQueryResult {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { text: "", lineCount: 0, truncated: false, deviceFilter: "none" };
  }
  return filterLogText(text, q, "uid");
}

export function parseLevel(s: string | undefined): LogLevel | undefined {
  if (!s) return undefined;
  const c = s.trim().charAt(0).toUpperCase();
  return "VDIWEFS".includes(c) ? (c as LogLevel) : undefined;
}
