import { describe, expect, it } from "vitest";
import { consoleFilter, parseLogLine } from "../../src/core/logcat/parse";
import { filterLogText } from "../../src/core/logcat/query";
import { epochLineToThreadtime } from "../../src/core/logcat/stream";

const LOG = `--------- beginning of main
2026-10-20 10:00:00.123 12345 12360 I localdesktop::android..: Starting compositor
2026-10-20 10:00:00.200 12345 12361 E RustStdoutStderr: thread 'main' panicked at src/android/main.rs:42:5:
2026-10-20 10:00:00.201 12345 12361 E RustStdoutStderr: called \`Option::unwrap()\` on a \`None\` value
2026-10-20 10:00:01.000 12400 12400 W pipewire: [PipeWireAAudio] underrun
2026-10-20 10:00:02.000 12345 12345 D LocalDesktopA11y: key event 66
`;

describe("parseLogLine", () => {
  it("parses threadtime with year", () => {
    expect(parseLogLine("2026-10-20 10:00:00.123 12345 12360 I localdesktop::android..: Starting compositor")).toMatchObject({
      time: "2026-10-20 10:00:00.123",
      pid: 12345,
      tid: 12360,
      level: "I",
      tag: "localdesktop::android..",
      message: "Starting compositor",
    });
  });
  it("parses threadtime without year and padded tags", () => {
    expect(parseLogLine("10-20 10:00:00.123  1234  1250 W ActivityManager: Slow operation")).toMatchObject({ level: "W", tag: "ActivityManager" });
  });
});

describe("filterLogText", () => {
  it("filters by level and grep, keeping the newest lines", () => {
    const r = filterLogText(LOG, { minLevel: "W" });
    expect(r.lineCount).toBe(3);
    expect(filterLogText(LOG, { grep: "panicked|underrun" }).lineCount).toBe(2);
    expect(filterLogText(LOG, { lines: 1 }).text).toContain("LocalDesktopA11y");
  });
  it("truncates to maxBytes", () => {
    const r = filterLogText(LOG, { maxBytes: 120 });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(120);
  });
});

describe("consoleFilter", () => {
  it("mirrors stdout and warnings in rust mode", () => {
    const f = consoleFilter("rust");
    const lines = LOG.split("\n").map(parseLogLine).filter((e) => e !== undefined);
    expect(lines.filter(f).map((e) => e.tag)).toEqual(["RustStdoutStderr", "RustStdoutStderr", "pipewire", "LocalDesktopA11y"]);
  });
});

describe("epochLineToThreadtime", () => {
  it("converts epoch timestamps", () => {
    const out = epochLineToThreadtime("1760954400.123  1234  1234 I Tag: hi");
    expect(parseLogLine(out)).toMatchObject({ pid: 1234, tag: "Tag", message: "hi" });
    expect(out).toMatch(/\.123 +1234/);
  });
});
