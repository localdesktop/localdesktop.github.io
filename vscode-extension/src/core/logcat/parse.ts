export type LogLevel = "V" | "D" | "I" | "W" | "E" | "F" | "S";

export const LEVELS: LogLevel[] = ["V", "D", "I", "W", "E", "F", "S"];

export interface LogEntry {
  /** "2026-10-20 10:00:00.123" (year included when logcat ran with `-v year`). */
  time: string;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
  raw: string;
}

// threadtime: [YYYY-]MM-DD HH:MM:SS.mmm  PID  TID L TAG     : message
const THREADTIME =
  /^((?:\d{4}-)?\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*: (.*)$/;
// threadtime with an empty message ("TAG     :")
const THREADTIME_EMPTY = /^((?:\d{4}-)?\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*:$/;

export function parseLogLine(raw: string): LogEntry | undefined {
  const m = THREADTIME.exec(raw) ?? THREADTIME_EMPTY.exec(raw);
  if (!m) return undefined;
  return {
    time: m[1]!.replace(/\s+/, " "),
    pid: parseInt(m[2]!, 10),
    tid: parseInt(m[3]!, 10),
    level: m[4] as LogLevel,
    tag: m[5]!,
    message: m[6] ?? "",
    raw,
  };
}

export function isBufferMarker(raw: string): boolean {
  return raw.startsWith("--------- ");
}

export function levelAtLeast(level: LogLevel, min: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(min);
}

export interface LogFilter {
  minLevel?: LogLevel;
  /** Only these tags (exact match). */
  tags?: string[];
  /** Case-insensitive regex (or substring if it isn't a valid regex) against tag + message. */
  grep?: string;
  pid?: number;
}

export function compileFilter(f: LogFilter): (e: LogEntry) => boolean {
  let re: RegExp | undefined;
  if (f.grep) {
    try {
      re = new RegExp(f.grep, "i");
    } catch {
      const needle = f.grep.toLowerCase();
      re = { test: (s: string) => s.toLowerCase().includes(needle) } as RegExp;
    }
  }
  const tags = f.tags?.length ? new Set(f.tags) : undefined;
  return (e) =>
    (!f.minLevel || levelAtLeast(e.level, f.minLevel)) &&
    (!tags || tags.has(e.tag)) &&
    (f.pid === undefined || e.pid === f.pid) &&
    (!re || re.test(`${e.tag}: ${e.message}`));
}

/** The tag android-activity uses for redirected stdout/stderr (panics, println!, proot guest stderr). */
export const RUST_STDIO_TAG = "RustStdoutStderr";
/** The Java accessibility keyboard service. */
export const A11Y_TAG = "LocalDesktopA11y";

/**
 * Default Debug Console filter: stdout/stderr, warnings and errors. Debug builds log at Trace, so
 * mirroring everything would drown the console.
 */
export function consoleFilter(mode: "rust" | "warnings" | "all" | "none"): (e: LogEntry) => boolean {
  switch (mode) {
    case "none":
      return () => false;
    case "all":
      return () => true;
    case "warnings":
      return (e) => levelAtLeast(e.level, "W");
    case "rust":
      return (e) => e.tag === RUST_STDIO_TAG || e.tag === A11Y_TAG || levelAtLeast(e.level, "W");
  }
}
