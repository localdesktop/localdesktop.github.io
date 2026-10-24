import * as fs from "node:fs";
import * as path from "node:path";
import { findAdb, findLldbServer, findNdkTool, findScrcpy, findX, resolveAndroidHome, which, type ToolPaths } from "./env";
import { errorMessage } from "./errors";
import { execFile } from "./exec";
import { isXbuildStale } from "./build";

export type CheckStatus = "ok" | "warn" | "error";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

async function version(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await execFile(cmd, args, { timeoutMs: 10_000 });
    const text = (r.stdout.toString("utf8") + r.stderr).trim();
    return text.split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

/** Environment checks shared by `Local Desktop: Check Environment`, the CLI and the MCP `doctor` tool. */
export async function runDoctor(root: string, paths: ToolPaths = {}, extra: Check[] = []): Promise<Check[]> {
  const checks: Check[] = [];
  const push = (c: Check) => checks.push(c);

  try {
    const adb = findAdb(paths);
    push({ id: "adb", label: "adb", status: "ok", detail: `${adb} (${(await version(adb, ["version"])) ?? "unknown version"})` });
  } catch (e) {
    push({ id: "adb", label: "adb", status: "error", detail: errorMessage(e) });
  }

  const sdk = resolveAndroidHome(paths);
  push(
    sdk
      ? { id: "android-home", label: "Android SDK", status: "ok", detail: sdk + (process.env.ANDROID_HOME ? "" : " (ANDROID_HOME unset; injected into builds)") }
      : { id: "android-home", label: "Android SDK", status: "error", detail: "Not found.", fix: "Install Android Studio or the command-line tools and set ANDROID_HOME." },
  );

  const x = findX(paths);
  if (!x) {
    push({ id: "xbuild", label: "xbuild (x)", status: "error", detail: "Not installed.", fix: "cargo install --path patches/xbuild/xbuild --force" });
  } else if (await isXbuildStale(root, paths)) {
    push({ id: "xbuild", label: "xbuild (x)", status: "warn", detail: `${x} is older than patches/xbuild.`, fix: "cargo install --path patches/xbuild/xbuild --force" });
  } else {
    push({ id: "xbuild", label: "xbuild (x)", status: "ok", detail: x });
  }

  const gradle = which("gradle");
  push(
    gradle
      ? { id: "gradle", label: "Gradle", status: "ok", detail: gradle }
      : { id: "gradle", label: "Gradle", status: "error", detail: "Not on PATH (xbuild runs `gradle`).", fix: process.platform === "darwin" ? "brew install gradle@8" : "Install Gradle 8." },
  );

  const java = which("java");
  const javaVersion = java ? await version(java, ["-version"]) : undefined;
  push(
    java
      ? { id: "java", label: "Java", status: "ok", detail: javaVersion ?? java }
      : { id: "java", label: "Java", status: "error", detail: "Not on PATH.", fix: process.platform === "darwin" ? "brew install openjdk@17" : "Install JDK 17." },
  );

  const rustup = which("rustup");
  if (rustup) {
    const targets = await execFile(rustup, ["target", "list", "--installed"], { timeoutMs: 15_000 }).catch(() => undefined);
    const has = targets?.stdout.toString("utf8").includes("aarch64-linux-android");
    push(
      has
        ? { id: "rust-target", label: "Rust target", status: "ok", detail: "aarch64-linux-android" }
        : { id: "rust-target", label: "Rust target", status: "error", detail: "aarch64-linux-android missing.", fix: "rustup target add aarch64-linux-android" },
    );
  } else {
    push({ id: "rust-target", label: "Rust", status: "warn", detail: "rustup not found; can't check the aarch64-linux-android target." });
  }

  try {
    push({ id: "lldb-server", label: "lldb-server (arm64)", status: "ok", detail: findLldbServer(paths) });
  } catch (e) {
    push({ id: "lldb-server", label: "lldb-server (arm64)", status: "warn", detail: errorMessage(e), fix: "Needed for breakpoints only." });
  }

  // crash_report symbolizes with llvm-symbolizer (llvm-addr2line as a fallback).
  const symbolizer = findNdkTool("llvm-symbolizer", paths) ?? findNdkTool("llvm-addr2line", paths);
  push(
    symbolizer
      ? { id: "symbolizer", label: "Crash symbolizer", status: "ok", detail: symbolizer }
      : { id: "symbolizer", label: "Crash symbolizer", status: "warn", detail: "llvm-symbolizer not found (it ships with the NDK); crash reports stay unsymbolicated." },
  );

  const scrcpy = findScrcpy(paths);
  push(
    scrcpy
      ? { id: "scrcpy", label: "scrcpy", status: "ok", detail: `${scrcpy} (${(await version(scrcpy, ["--version"])) ?? "?"})` }
      : { id: "scrcpy", label: "scrcpy", status: "warn", detail: "Not installed (screen mirroring and audio capture).", fix: process.platform === "darwin" ? "brew install scrcpy" : "Install scrcpy ≥ 2.1." },
  );

  const gitignore = path.join(root, ".gitignore");
  try {
    if (!/^\/?\.localdesktop\/?$/m.test(fs.readFileSync(gitignore, "utf8"))) {
      push({ id: "gitignore", label: ".gitignore", status: "warn", detail: ".localdesktop/ (logs, screenshots, state) isn't ignored.", fix: "Add /.localdesktop/ to .gitignore." });
    }
  } catch {
    // no .gitignore
  }

  return [...checks, ...extra];
}

export function formatChecks(checks: Check[]): string {
  const icon = { ok: "✓", warn: "!", error: "✗" } as const;
  return checks.map((c) => `${icon[c.status]} ${c.label}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`).join("\n");
}
