import { describe, expect, it } from "vitest";
import {
  isHostPort,
  pairingQrPayload,
  parseConnectResult,
  parseForwardPort,
  parseMdnsCheck,
  parseMdnsServices,
  parsePairResult,
  parseWlanIp,
  randomPairingPassword,
} from "../../src/core/adb/wireless";
import { parseRustcVersion, rustSourceMap } from "../../src/core/debug/rust";

describe("parseMdnsServices", () => {
  it("parses pairing and connect services (with and without trailing dots)", () => {
    const out = `List of discovered mdns services
adb-28041FDH2000LD-abcDEF\t_adb-tls-connect._tcp\t192.168.1.5:37853
localdesktop-1a2b3c\t_adb-tls-pairing._tcp.\t192.168.1.5:41234
adb-emu\t_adb._tcp\t10.0.0.2:5555
garbage line
`;
    expect(parseMdnsServices(out)).toEqual([
      { name: "adb-28041FDH2000LD-abcDEF", type: "connect", address: "192.168.1.5:37853", host: "192.168.1.5", port: 37853 },
      { name: "localdesktop-1a2b3c", type: "pairing", address: "192.168.1.5:41234", host: "192.168.1.5", port: 41234 },
      { name: "adb-emu", type: "adb", address: "10.0.0.2:5555", host: "10.0.0.2", port: 5555 },
    ]);
  });

  it("detects mDNS support", () => {
    expect(parseMdnsCheck("mdns daemon version [Openscreen discovery 0.0.0]")).toBe(true);
    expect(parseMdnsCheck("ERROR: mdns daemon unavailable")).toBe(false);
  });
});

describe("pair / connect output", () => {
  it("parses adb pair", () => {
    expect(parsePairResult("Successfully paired to 192.168.1.5:41234 [guid=adb-28041FDH2000LD-abcDEF]")).toEqual({
      ok: true,
      message: "Successfully paired to 192.168.1.5:41234 [guid=adb-28041FDH2000LD-abcDEF]",
      guid: "adb-28041FDH2000LD-abcDEF",
    });
    expect(parsePairResult("Failed: Wrong password or connection was dropped.").ok).toBe(false);
  });

  it("parses adb connect (exit status lies)", () => {
    expect(parseConnectResult("connected to 192.168.1.5:37853")).toMatchObject({ ok: true, already: false });
    expect(parseConnectResult("already connected to 192.168.1.5:37853")).toMatchObject({ ok: true, already: true });
    expect(parseConnectResult("failed to connect to '192.168.1.5:37853': Connection refused")).toMatchObject({ ok: false });
    expect(parseConnectResult("cannot connect to 192.168.1.5:5555: No route to host (65)")).toMatchObject({ ok: false });
  });

  it("parses forward ports and wlan addresses", () => {
    expect(parseForwardPort("43561\n")).toBe(43561);
    expect(parseForwardPort("error: cannot bind")).toBeUndefined();
    expect(
      parseWlanIp("31: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet 192.168.1.5/24 brd 192.168.1.255 scope global wlan0\n"),
    ).toBe("192.168.1.5");
    expect(parseWlanIp("Device \"wlan0\" does not exist.")).toBeUndefined();
  });

  it("validates ip:port", () => {
    expect(isHostPort("192.168.1.5:37853")).toBe(true);
    expect(isHostPort("[fe80::1]:5555")).toBe(true);
    expect(isHostPort("192.168.1.5")).toBe(false);
  });

  it("builds the QR payload Android scans", () => {
    const pwd = randomPairingPassword();
    expect(pwd).toMatch(/^[A-Za-z2-9]{10}$/);
    expect(pairingQrPayload("localdesktop-abc", "secret")).toBe("WIFI:T:ADB;S:localdesktop-abc;P:secret;;");
  });
});

describe("rust toolchain", () => {
  it("parses rustc -vV and maps /rustc/<hash>", () => {
    const parsed = parseRustcVersion(`rustc 1.98.1 (48a229ce0 2026-09-01)
binary: rustc
commit-hash: 48a229ce0123456789abcdef0123456789abcdef
commit-date: 2026-09-01
host: aarch64-apple-darwin
release: 1.98.1
LLVM version: 21.1.0
`);
    expect(parsed).toEqual({ commitHash: "48a229ce0123456789abcdef0123456789abcdef", release: "1.98.1" });
    expect(rustSourceMap({ ...parsed, sysroot: "/sysroot" })).toEqual({
      "/rustc/48a229ce0123456789abcdef0123456789abcdef": "/sysroot/lib/rustlib/src/rust",
    });
    expect(rustSourceMap({ sysroot: "/sysroot" })).toEqual({});
    expect(parseRustcVersion("commit-hash: unknown\n").commitHash).toBeUndefined();
  });
});
