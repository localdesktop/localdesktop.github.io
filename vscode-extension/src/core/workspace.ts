import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { LdError } from "./errors";

export type Profile = "debug" | "release";

export interface AppInfo {
  /** Repository root (contains manifest.yaml and Cargo.toml). */
  root: string;
  /** Android package name, read from manifest.yaml (never hardcoded: it was renamed once already). */
  packageName: string;
  /** Cargo package version (also the Android versionName). */
  version?: string;
  /** Native library name without lib prefix / .so suffix. */
  libName: string;
}

/** Walks up from `start` to the directory holding manifest.yaml and Cargo.toml. */
export function findRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "manifest.yaml")) && fs.existsSync(path.join(dir, "Cargo.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function requireRepoRoot(start: string): string {
  const root = findRepoRoot(start);
  if (!root) {
    throw new LdError(
      "WORKSPACE_NOT_FOUND",
      `Not inside the Local Desktop repository (no manifest.yaml + Cargo.toml above ${start}).`,
      "Run from a checkout of localdesktop/localdesktop.github.io, or pass --root.",
    );
  }
  return root;
}

export function parseManifestPackage(yamlText: string): string | undefined {
  const doc = parseYaml(yamlText) as { android?: { manifest?: { package?: unknown } } } | null;
  const pkg = doc?.android?.manifest?.package;
  return typeof pkg === "string" && pkg ? pkg : undefined;
}

/** Reads `[package]` name/version and `[lib]` name from Cargo.toml without a TOML parser. */
export function parseCargoToml(text: string): { name?: string; version?: string; libName?: string } {
  const sections = new Map<string, string>();
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    // [[bin]] array tables get their own (unused) section so their `name` never leaks into [lib].
    const header = /^\s*(\[\[?)([^\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      current = header[1] === "[[" ? `[[${header[2]!.trim()}]]` : header[2]!.trim();
      continue;
    }
    sections.set(current, (sections.get(current) ?? "") + line + "\n");
  }
  const field = (section: string, key: string) => {
    const body = sections.get(section);
    if (!body) return undefined;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(body);
    return m?.[1];
  };
  return { name: field("package", "name"), version: field("package", "version"), libName: field("lib", "name") };
}

export function readAppInfo(root: string): AppInfo {
  const manifestPath = path.join(root, "manifest.yaml");
  const pkg = parseManifestPackage(fs.readFileSync(manifestPath, "utf8"));
  if (!pkg) throw new LdError("WORKSPACE_NOT_FOUND", `No android.manifest.package in ${manifestPath}`);
  const cargo = parseCargoToml(fs.readFileSync(path.join(root, "Cargo.toml"), "utf8"));
  const libName = (cargo.libName ?? cargo.name ?? "localdesktop").replace(/-/g, "_");
  return { root, packageName: pkg, version: cargo.version, libName };
}

export function targetDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const t = env.CARGO_TARGET_DIR;
  return t ? path.resolve(root, t) : path.join(root, "target");
}

export interface BuildArtifacts {
  /** Candidate APKs, best first. */
  apkCandidates: string[];
  /** Directories holding unstripped .so files for LLDB / symbolization, best first. */
  symbolDirs: string[];
}

export function buildArtifacts(root: string, profile: Profile, env: NodeJS.ProcessEnv = process.env): BuildArtifacts {
  const x = path.join(targetDir(root, env), "x", profile, "android");
  const gradleApp = path.join(x, "gradle", "app");
  // Without a keystore the release variant is unsigned (not installable); gradle always builds the
  // debug-signed variant too, so prefer that for local installs.
  const apkCandidates = [
    path.join(gradleApp, "build", "outputs", "apk", "debug", "app-debug.apk"),
    ...(profile === "release" ? [path.join(gradleApp, "build", "outputs", "apk", "release", "app-release.apk")] : []),
    path.join(x, "localdesktop.apk"),
  ];
  const symbolDirs = [
    // xbuild copies every packaged .so here unstripped (patches/xbuild/xbuild/src/gradle/mod.rs).
    path.join(gradleApp, "src", "main", "jniLibs", "arm64-v8a"),
    path.join(x, "arm64", "cargo", "aarch64-linux-android", profile),
    path.join(root, "assets", "libs", "arm64-v8a"),
  ];
  return { apkCandidates, symbolDirs };
}

/** Newest existing APK among the candidates (optionally only those modified after `since`). */
export function findApk(root: string, profile: Profile, since?: number): string | undefined {
  let best: { p: string; mtime: number } | undefined;
  for (const p of buildArtifacts(root, profile).apkCandidates) {
    try {
      const st = fs.statSync(p);
      if (since !== undefined && st.mtimeMs < since) continue;
      if (!best || st.mtimeMs > best.mtime) best = { p, mtime: st.mtimeMs };
    } catch {
      // missing candidate
    }
  }
  return best?.p;
}

/** Per-workspace scratch directory for state, logs, screenshots and recordings (gitignored). */
export function localDir(root: string, ...sub: string[]): string {
  const dir = path.join(root, ".localdesktop", ...sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
