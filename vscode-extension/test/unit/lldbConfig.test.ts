import { describe, expect, it } from "vitest";
import { buildLldbAttachConfig, lldbQuote, platformConnectUrl } from "../../src/core/debug/lldbConfig";
import { newPlatformSocket, platformServerCommand, procNetUnixHas } from "../../src/core/debug/lldbServer";

const base = {
  name: "Local Desktop native (Pixel 7, pid 4242)",
  pid: 4242,
  socketPath: "/io.github.localdesktop-1a2b3c4d/platform.sock",
  symbolDirs: ["/repo/target/x/debug/android/gradle/app/src/main/jniLibs/arm64-v8a", "/repo/assets/libs/arm64-v8a"],
  rust: { commitHash: "48a229ce0123456789abcdef0123456789abcdef", sysroot: "/home/u/.rustup/toolchains/stable-aarch64-apple-darwin" },
};

describe("buildLldbAttachConfig", () => {
  it("generates the CodeLLDB attach config (golden)", () => {
    expect(buildLldbAttachConfig({ ...base, serial: "R58M12345ABC", meta: { parent: "p1", serial: "R58M12345ABC", pid: 4242 } })).toEqual({
      type: "lldb",
      request: "attach",
      name: "Local Desktop native (Pixel 7, pid 4242)",
      pid: 4242,
      initCommands: [
        "platform select remote-android",
        "platform connect unix-abstract-connect://[R58M12345ABC]/io.github.localdesktop-1a2b3c4d/platform.sock",
        "settings set plugin.jit-loader.gdb.enable off",
        'settings append target.exec-search-paths "/repo/target/x/debug/android/gradle/app/src/main/jniLibs/arm64-v8a" "/repo/assets/libs/arm64-v8a"',
        "process handle SIGBUS SIGSEGV --pass true --stop false --notify false",
        "breakpoint set --shlib libart.so --name art_sigsegv_fault",
        "breakpoint set --shlib libart.so --name art_sigbus_fault",
      ],
      sourceLanguages: ["rust"],
      sourceMap: {
        "/rustc/48a229ce0123456789abcdef0123456789abcdef": "/home/u/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/src/rust",
      },
      stopOnEntry: false,
      __localdesktop: { parent: "p1", serial: "R58M12345ABC", pid: 4242 },
    });
  });

  it("brackets Wi‑Fi serials so ip:port isn't parsed as host:port", () => {
    const cfg = buildLldbAttachConfig({ ...base, serial: "192.168.1.5:37853" });
    expect((cfg.initCommands as string[])[1]).toBe("platform connect unix-abstract-connect://[192.168.1.5:37853]/io.github.localdesktop-1a2b3c4d/platform.sock");
  });

  it("handles mDNS serials", () => {
    const cfg = buildLldbAttachConfig({ ...base, serial: "adb-28041FDH2000LD-abcDEF._adb-tls-connect._tcp" });
    expect((cfg.initCommands as string[])[1]).toBe(
      "platform connect unix-abstract-connect://[adb-28041FDH2000LD-abcDEF._adb-tls-connect._tcp]/io.github.localdesktop-1a2b3c4d/platform.sock",
    );
  });

  it("appends user commands and lets `lldb` override anything", () => {
    const cfg = buildLldbAttachConfig({
      ...base,
      serial: "s",
      symbolDirs: [],
      initCommands: ["log enable lldb process"],
      preRunCommands: ["breakpoint set -n rust_panic"],
      exitCommands: ["bt"],
      sourceMap: { "/build": "/local" },
      stopOnEntry: true,
      lldb: { sourceLanguages: ["rust", "c"], expressions: "native" },
    });
    const init = cfg.initCommands as string[];
    expect(init.some((c) => c.startsWith("settings append target.exec-search-paths"))).toBe(false);
    expect(init.at(-1)).toBe("log enable lldb process");
    expect(cfg.preRunCommands).toEqual(["breakpoint set -n rust_panic"]);
    expect(cfg.exitCommands).toEqual(["bt"]);
    expect(cfg).not.toHaveProperty("postRunCommands");
    expect(cfg.sourceMap).toMatchObject({ "/build": "/local" });
    expect(cfg.stopOnEntry).toBe(true);
    expect(cfg.sourceLanguages).toEqual(["rust", "c"]);
    expect(cfg.expressions).toBe("native");
  });

  it("quotes paths for the LLDB interpreter", () => {
    expect(lldbQuote('C:\\Users\\me\\my "repo"')).toBe('"C:\\\\Users\\\\me\\\\my \\"repo\\""');
    expect(platformConnectUrl("s", "sock")).toBe("unix-abstract-connect://[s]/sock");
  });
});

describe("lldb-server platform", () => {
  it("builds the run-as command line", () => {
    const socket = newPlatformSocket("io.github.localdesktop", "deadbeef");
    expect(socket).toEqual({ dir: "/io.github.localdesktop-deadbeef", path: "/io.github.localdesktop-deadbeef/platform.sock" });
    expect(platformServerCommand("io.github.localdesktop", socket)).toBe(
      "run-as io.github.localdesktop sh -c 'cd lldb && LLDB_DEBUGSERVER_DOMAINSOCKET_DIR=/io.github.localdesktop-deadbeef exec ./bin/lldb-server platform --listen unix-abstract:///io.github.localdesktop-deadbeef/platform.sock'",
    );
    // The inner quotes survive the outer sh -c '…' quoting.
    expect(platformServerCommand("p", socket, true)).toContain(`--log-file platform.log --log-channels '\\''lldb process:gdb-remote packets'\\'''`);
  });

  it("finds the abstract socket in /proc/net/unix", () => {
    const out = `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 123456 @/io.github.localdesktop-deadbeef/platform.sock
0000000000000000: 00000003 00000000 00000000 0001 03 123457 /dev/socket/logdw
`;
    expect(procNetUnixHas(out, "/io.github.localdesktop-deadbeef/platform.sock")).toBe(true);
    expect(procNetUnixHas(out, "/io.github.localdesktop-cafebabe/platform.sock")).toBe(false);
  });
});
