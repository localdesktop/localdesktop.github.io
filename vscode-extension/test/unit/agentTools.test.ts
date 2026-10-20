import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseArgs } from "../../src/cli/args";
import { extractCrashBuffer, extractPanics, parseDropbox } from "../../src/core/crash/collect";
import { parseFrames } from "../../src/core/crash/symbolize";
import { downscalePng } from "../../src/core/image";
import { inputTextArg, keycodeName } from "../../src/core/input";
import { pngSize } from "../../src/core/screen";
import { TOOLS } from "../../src/core/tools";

describe("input", () => {
  it("maps key names", () => {
    expect(keycodeName("enter")).toBe("KEYCODE_ENTER");
    expect(keycodeName("Ctrl")).toBe("KEYCODE_CTRL_LEFT");
    expect(keycodeName("a")).toBe("KEYCODE_A");
    expect(keycodeName("F5")).toBe("KEYCODE_F5");
    expect(keycodeName("66")).toBe("66");
    expect(keycodeName("KEYCODE_MOVE_HOME")).toBe("KEYCODE_MOVE_HOME");
  });
  it("escapes text for input text", () => {
    expect(inputTextArg("hello world")).toBe("hello%sworld");
    expect(inputTextArg("it's 100%")).toBe(`'it'\\''s%s100\\%'`);
    expect(() => inputTextArg("héllo")).toThrow(/ASCII/);
  });
});

describe("downscalePng", () => {
  it("scales to maxSize and reports the device scale", () => {
    const src = new PNG({ width: 2400, height: 1080 });
    src.data.fill(200);
    const png = PNG.sync.write(src);
    expect(pngSize(png)).toEqual({ width: 2400, height: 1080 });
    const out = downscalePng(png, 1200, "jpeg");
    expect(out).toMatchObject({ width: 1200, height: 540, mimeType: "image/jpeg", scale: 2 });
    expect(out.data.subarray(0, 2).toString("hex")).toBe("ffd8");
    const same = downscalePng(PNG.sync.write(new PNG({ width: 100, height: 50 })), 1280, "png");
    expect(same).toMatchObject({ width: 100, height: 50, scale: 1 });
  });
});

describe("crash parsing", () => {
  const dropbox = `Drop box contents: 2 entries
Max entries: 1000

========================================
2026-10-20 10:00:00 data_app_native_crash (text, 4000 bytes)
Process: io.github.localdesktop
*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
pid: 12345, tid: 12360, name: winit  >>> io.github.localdesktop <<<
signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0
backtrace:
      #00 pc 00000000001a2b3c  /data/app/~~abc/io.github.localdesktop-xyz/lib/arm64/liblocaldesktop.so (BuildId: 1234)
      #01 pc 0000000000088f00  /apex/com.android.runtime/lib64/bionic/libc.so (__start_thread+64)

========================================
2026-10-20 09:00:00 data_app_native_crash (text, 3000 bytes)
Process: com.other.app
`;
  it("keeps dropbox entries of our package", () => {
    const r = parseDropbox(dropbox, "io.github.localdesktop", "native", "data_app_native_crash");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "native", time: "2026-10-20 10:00:00" });
  });
  it("parses tombstone frames", () => {
    expect(parseFrames(dropbox).map((f) => [f.index, f.pc, f.lib])).toEqual([
      [0, "00000000001a2b3c", "liblocaldesktop.so"],
      [1, "0000000000088f00", "libc.so"],
    ]);
  });
  it("extracts Rust panics with their backtrace lines", () => {
    const log = `2026-10-20 10:00:00.200 12345 12361 E RustStdoutStderr: thread 'main' panicked at src/android/main.rs:42:5:
2026-10-20 10:00:00.201 12345 12361 E RustStdoutStderr: called \`Option::unwrap()\` on a \`None\` value
2026-10-20 10:00:00.202 12345 12361 E RustStdoutStderr: stack backtrace:
2026-10-20 10:00:00.300 12345 12362 I localdesktop::android..: unrelated
`;
    const r = extractPanics(log);
    expect(r).toHaveLength(1);
    expect(r[0]!.text.split("\n")).toHaveLength(3);
  });
  it("extracts debuggerd dumps from the crash buffer", () => {
    const log = `2026-10-20 10:00:00.000  1000  1000 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
2026-10-20 10:00:00.001  1000  1000 F DEBUG   : pid: 12345, tid: 12360, name: winit  >>> io.github.localdesktop <<<
2026-10-20 10:00:00.002  1000  1000 F DEBUG   :       #00 pc 00000000001a2b3c  /data/app/x/lib/arm64/liblocaldesktop.so
2026-10-20 10:00:00.003  1000  1000 F DEBUG   : *** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***
2026-10-20 10:00:00.004  1000  1000 F DEBUG   : pid: 1, tid: 1, name: other  >>> com.other <<<
`;
    const r = extractCrashBuffer(log, "io.github.localdesktop");
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toContain("liblocaldesktop.so");
  });
});

describe("CLI args", () => {
  const shape = { serial: z.string().optional(), x: z.number(), lines: z.number().int().default(200), crash: z.boolean().default(false), tags: z.array(z.string()).optional() };
  it("maps flags onto the tool schema", () => {
    expect(parseArgs(["--x", "12.5", "--crash", "--tags", "A", "--tags=B", "--serial", "emulator-5554", "--json"], shape)).toEqual({
      args: { x: 12.5, crash: true, tags: ["A", "B"], serial: "emulator-5554" },
      json: true,
      root: undefined,
    });
    expect(parseArgs(["--crash=false", "--root", "/repo"], shape)).toMatchObject({ args: { crash: false }, root: "/repo" });
  });
  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope", "1"], shape)).toThrow(/Unknown option/);
  });
  it("accepts kebab-case for camelCase inputs", () => {
    const tool = TOOLS.find((t) => t.name === "swipe")!;
    expect(parseArgs(["--duration-ms", "500", "--x1", "1"], tool.input).args).toMatchObject({ durationMs: 500, x1: 1 });
  });
});

describe("tool registry", () => {
  it("has unique snake_case names and descriptions", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description.length).toBeGreaterThan(20);
      z.object(t.input); // valid zod shape
    }
  });
});
