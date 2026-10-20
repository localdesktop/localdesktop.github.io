import { describe, expect, it } from "vitest";
import { parseProcessList } from "../../src/core/adb/app";
import { parseDumpsysPackage, parseInstallFailure, parseUidFromPmList } from "../../src/core/adb/packages";
import { parseGetprop, deviceInfoFromProps } from "../../src/core/adb/props";

describe("parseUidFromPmList", () => {
  it("matches the package exactly, not by prefix", () => {
    const out = "package:io.github.localdesktop.beta uid:10301\npackage:io.github.localdesktop uid:10234\n";
    expect(parseUidFromPmList(out, "io.github.localdesktop")).toBe(10234);
    expect(parseUidFromPmList(out, "io.github")).toBeUndefined();
  });
});

describe("parseDumpsysPackage", () => {
  it("reads version, uid and the debuggable flag", () => {
    const out = `Packages:
  Package [io.github.localdesktop] (a1b2c3):
    userId=10234
    pkg=Package{d4e5f6 io.github.localdesktop}
    versionCode=16908545 minSdk=21 targetSdk=33
    versionName=2.1.1
    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]
    firstInstallTime=2026-10-01 10:00:00
    lastUpdateTime=2026-10-20 09:30:12
`;
    expect(parseDumpsysPackage(out)).toEqual({
      versionName: "2.1.1",
      versionCode: 16908545,
      userId: 10234,
      debuggable: true,
      firstInstallTime: "2026-10-01 10:00:00",
      lastUpdateTime: "2026-10-20 09:30:12",
    });
  });
  it("returns undefined when the package is missing", () => {
    expect(parseDumpsysPackage("Unable to find package: io.github.localdesktop\n")).toBeUndefined();
  });
});

describe("parseInstallFailure", () => {
  it("extracts failure codes", () => {
    expect(parseInstallFailure("Performing Streamed Install\nadb: failed to install x.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package io.github.localdesktop signatures do not match newer version; ignoring!]")).toMatchObject({
      code: "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
    });
    expect(parseInstallFailure("Performing Streamed Install\nSuccess\n")).toBeUndefined();
  });
});

describe("parseProcessList", () => {
  it("parses toybox ps output", () => {
    const out = `  PID   UID     RSS NAME
12345 10234  250000 io.github.localdesktop
12400 10234   12000 /data/app/~~x/lib/arm64/libproot.so
1     0        3000 init
`;
    expect(parseProcessList(out)).toEqual([
      { pid: 12345, uid: 10234, rssKb: 250000, name: "io.github.localdesktop" },
      { pid: 12400, uid: 10234, rssKb: 12000, name: "/data/app/~~x/lib/arm64/libproot.so" },
      { pid: 1, uid: 0, rssKb: 3000, name: "init" },
    ]);
  });
});

describe("getprop", () => {
  it("builds device info", () => {
    const props = parseGetprop("[ro.product.model]: [Pixel 7]\n[ro.product.cpu.abi]: [arm64-v8a]\n[ro.product.cpu.abilist]: [arm64-v8a,armeabi-v7a]\n[ro.build.version.sdk]: [34]\n[ro.build.version.release]: [14]\n");
    expect(deviceInfoFromProps("s", props)).toMatchObject({ model: "Pixel 7", abi: "arm64-v8a", abiList: ["arm64-v8a", "armeabi-v7a"], sdk: 34, release: "14" });
  });
});
