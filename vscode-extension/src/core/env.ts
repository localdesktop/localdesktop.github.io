import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LdError } from "./errors";

/** User overrides for tool locations (editor settings, or LOCALDESKTOP_* env vars for CLI/MCP). */
export interface ToolPaths {
  adbPath?: string;
  xPath?: string;
  androidHome?: string;
  lldbServerPath?: string;
  scrcpyPath?: string;
}

export function toolPathsFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPaths {
  return {
    adbPath: env.LOCALDESKTOP_ADB || undefined,
    xPath: env.LOCALDESKTOP_X || undefined,
    androidHome: env.LOCALDESKTOP_ANDROID_HOME || undefined,
    lldbServerPath: env.LOCALDESKTOP_LLDB_SERVER || undefined,
    scrcpyPath: env.LOCALDESKTOP_SCRCPY || undefined,
  };
}

const isWindows = process.platform === "win32";
const exe = (name: string) => (isWindows ? `${name}.exe` : name);

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Finds a program on PATH (honouring PATHEXT on Windows). */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = isWindows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function defaultAndroidHomes(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return [path.join(home, "Library", "Android", "sdk")];
    case "win32":
      return [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk")];
    default:
      return [path.join(home, "Android", "Sdk"), path.join(home, "Android", "sdk")];
  }
}

export function resolveAndroidHome(paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [paths.androidHome, env.ANDROID_HOME, env.ANDROID_SDK_ROOT, ...defaultAndroidHomes()];
  for (const c of candidates) {
    if (c && isDir(expandHome(c))) return expandHome(c);
  }
  return undefined;
}

export function findAdb(paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): string {
  if (paths.adbPath) {
    const p = expandHome(paths.adbPath);
    if (isFile(p)) return p;
    throw new LdError("ADB_MISSING", `adb not found at ${p}`, "Fix the localdesktop.adbPath setting.");
  }
  const sdk = resolveAndroidHome(paths, env);
  if (sdk) {
    const p = path.join(sdk, "platform-tools", exe("adb"));
    if (isFile(p)) return p;
  }
  const onPath = which("adb", env);
  if (onPath) return onPath;
  throw new LdError(
    "ADB_MISSING",
    "adb (Android platform-tools) was not found.",
    process.platform === "darwin"
      ? "Install it with `brew install --cask android-platform-tools`, or set localdesktop.adbPath."
      : "Install Android platform-tools and put adb on PATH, or set localdesktop.adbPath.",
  );
}

export function findX(paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (paths.xPath) {
    const p = expandHome(paths.xPath);
    return isFile(p) ? p : undefined;
  }
  const cargoHome = env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  const p = path.join(cargoHome, "bin", exe("x"));
  if (isFile(p)) return p;
  return which("x", env);
}

export function findScrcpy(paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (paths.scrcpyPath) {
    const p = expandHome(paths.scrcpyPath);
    return isFile(p) ? p : undefined;
  }
  return which("scrcpy", env);
}

/** Compares dotted version strings numerically ("27.0.12077973" > "26.3.11579264"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0);
    const y = Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0);
    if (x !== y) return x - y;
  }
  return 0;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** NDK roots, most preferred first: env vars, then $ANDROID_HOME/ndk/* (newest first), then ndk-bundle. */
export function findNdkRoots(paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  for (const v of [env.ANDROID_NDK_HOME, env.ANDROID_NDK_ROOT, env.ANDROID_NDK]) {
    if (v && isDir(v)) roots.push(v);
  }
  const sdk = resolveAndroidHome(paths, env);
  if (sdk) {
    const ndkDir = path.join(sdk, "ndk");
    const versions = listDirs(ndkDir).sort((a, b) => compareVersions(b, a));
    roots.push(...versions.map((v) => path.join(ndkDir, v)));
    const bundle = path.join(sdk, "ndk-bundle");
    if (isDir(bundle)) roots.push(bundle);
  }
  return [...new Set(roots)];
}

function hostTags(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["darwin-x86_64", "darwin-arm64"];
    case "win32":
      return ["windows-x86_64"];
    default:
      return ["linux-x86_64"];
  }
}

/** The xbuild download cache (`x` fetches its own NDK sysroot there). */
export function xbuildCacheDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "x");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "x");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "x");
}

/** Locates an arm64 lldb-server, newest clang first. */
export function findLldbServer(paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): string {
  if (paths.lldbServerPath) {
    const p = expandHome(paths.lldbServerPath);
    if (isFile(p)) return p;
    throw new LdError("LLDB_SERVER_MISSING", `lldb-server not found at ${p}`, "Fix the localdesktop.lldbServerPath setting.");
  }
  for (const ndk of findNdkRoots(paths, env)) {
    for (const tag of hostTags()) {
      const prebuilt = path.join(ndk, "toolchains", "llvm", "prebuilt", tag);
      for (const lib of ["lib", "lib64"]) {
        const clangDir = path.join(prebuilt, lib, "clang");
        const versions = listDirs(clangDir).sort((a, b) => compareVersions(b, a));
        for (const v of versions) {
          const p = path.join(clangDir, v, "lib", "linux", "aarch64", "lldb-server");
          if (isFile(p)) return p;
        }
      }
    }
  }
  const cached = path.join(xbuildCacheDir(), "Android.ndk", "usr", "lib", "aarch64-linux-android", "lldb-server");
  if (isFile(cached)) return cached;
  throw new LdError(
    "LLDB_SERVER_MISSING",
    "No arm64 lldb-server found in any Android NDK.",
    'Install an NDK (Android Studio → SDK Manager → NDK, or `sdkmanager "ndk;27.0.12077973"`), or set localdesktop.lldbServerPath.',
  );
}

/** Finds an NDK host tool such as ndk-stack or llvm-symbolizer. */
export function findNdkTool(name: string, paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const ndk of findNdkRoots(paths, env)) {
    const top = path.join(ndk, exe(name));
    if (isFile(top)) return top;
    for (const tag of hostTags()) {
      const p = path.join(ndk, "toolchains", "llvm", "prebuilt", tag, "bin", exe(name));
      if (isFile(p)) return p;
    }
  }
  return which(name, env);
}

/** Environment for build tasks: fills ANDROID_HOME when only the platform default exists. */
export function buildEnv(paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  if (!out.ANDROID_HOME && !out.ANDROID_SDK_ROOT) {
    const sdk = resolveAndroidHome(paths, env);
    if (sdk) out.ANDROID_HOME = sdk;
  }
  return out;
}
