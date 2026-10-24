import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCargoToml, parseManifestPackage, readAppInfo } from "../../src/core/workspace";
import { shJoin, shQuote } from "../../src/core/shell";
import { compareVersions } from "../../src/core/env";

describe("manifest", () => {
  it("reads the package from manifest.yaml (both names)", () => {
    expect(parseManifestPackage("android:\n  manifest:\n    package: app.polarbear\n")).toBe("app.polarbear");
    expect(parseManifestPackage("android:\n  manifest:\n    package: io.github.localdesktop\n")).toBe("io.github.localdesktop");
    expect(parseManifestPackage("icon: x\n")).toBeUndefined();
  });
  it("reads the real repository", () => {
    const info = readAppInfo(path.resolve(__dirname, "../../.."));
    expect(info.packageName).toMatch(/^(app\.polarbear|io\.github\.localdesktop)$/);
    expect(info.libName).toBe("localdesktop");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("parses Cargo.toml sections", () => {
    expect(parseCargoToml('[package]\nname = "localdesktop"\nversion = "2.1.1"\n\n[lib]\ncrate-type = ["cdylib"]\n')).toEqual({ name: "localdesktop", version: "2.1.1", libName: undefined });
  });
});

describe("shell quoting", () => {
  it("quotes only when needed", () => {
    expect(shQuote("io.github.localdesktop")).toBe("io.github.localdesktop");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote("")).toBe("''");
    expect(shJoin(["run-as", "pkg", "sh", "-c", "cd lldb && ls"])).toBe("run-as pkg sh -c 'cd lldb && ls'");
  });
});

describe("compareVersions", () => {
  it("orders NDK versions numerically", () => {
    expect(["26.3.11579264", "27.0.12077973", "25.2.9519653"].sort((a, b) => compareVersions(b, a))[0]).toBe("27.0.12077973");
  });
});

describe("parseCargoToml array tables", () => {
  it("ignores [[bin]] names", () => {
    expect(parseCargoToml('[package]\nname = "localdesktop"\n[lib]\ncrate-type = ["lib"]\n[[bin]]\nname = "build_apk"\n').libName).toBeUndefined();
  });
});
