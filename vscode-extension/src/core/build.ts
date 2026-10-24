import * as fs from "node:fs";
import * as path from "node:path";
import { buildEnv, findX, type ToolPaths } from "./env";
import { LdError } from "./errors";
import { execFile, spawnLines } from "./exec";
import { findApk, type Profile } from "./workspace";

export interface BuildCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The xbuild invocation used everywhere (editor task, MCP, CLI). Only arm64 is built. */
export function xbuildCommand(root: string, profile: Profile, format: "apk" | "aab", paths: ToolPaths = {}, env: NodeJS.ProcessEnv = process.env): BuildCommand {
  const x = findX(paths, env);
  if (!x) {
    throw new LdError("X_MISSING", "The patched xbuild (`x`) is not installed.", "Run `cargo install --path patches/xbuild/xbuild --force` (Local Desktop: Install Patched xbuild).");
  }
  const args = ["build"];
  if (profile === "release") args.push("--release");
  args.push("--platform", "android", "--arch", "arm64", "--format", format);
  return { command: x, args, cwd: root, env: buildEnv(paths, env) };
}

export function installXbuildCommand(root: string, env: NodeJS.ProcessEnv = process.env): BuildCommand {
  return { command: "cargo", args: ["install", "--path", path.join("patches", "xbuild", "xbuild"), "--force"], cwd: root, env };
}

/**
 * `x` is built from patches/xbuild; warn when the sources changed after the binary was installed.
 * Compares the binary's mtime with the newest commit touching patches/xbuild.
 */
export async function isXbuildStale(root: string, paths: ToolPaths = {}): Promise<boolean> {
  const x = findX(paths);
  if (!x) return false;
  const res = await execFile("git", ["log", "-1", "--format=%ct", "--", "patches/xbuild"], { cwd: root, timeoutMs: 10_000 }).catch(() => undefined);
  const ts = parseInt(res?.stdout.toString("utf8").trim() ?? "", 10);
  if (!Number.isFinite(ts)) return false;
  return fs.statSync(x).mtimeMs / 1000 < ts;
}

export interface RustDiagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

/** Extracts rustc diagnostics ("error[E0308]: …" followed by " --> file:line:col"). */
export function parseRustDiagnostics(output: string): RustDiagnostic[] {
  const diags: RustDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = /^(error|warning)(?:\[[A-Z0-9]+\])?: (.+)$/.exec(lines[i]!);
    if (!head) continue;
    if (/^(aborting due to|could not compile|build failed)/.test(head[2]!) || /generated \d+ warnings?/.test(head[2]!)) continue;
    const d: RustDiagnostic = { severity: head[1] as "error" | "warning", message: head[2]! };
    const loc = /^\s*-->\s*(.+?):(\d+):(\d+)/.exec(lines[i + 1] ?? "");
    if (loc) {
      d.file = loc[1];
      d.line = parseInt(loc[2]!, 10);
      d.column = parseInt(loc[3]!, 10);
    }
    diags.push(d);
  }
  return diags;
}

export interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  apk?: string;
  diagnostics: RustDiagnostic[];
  tail: string;
  durationMs: number;
}

/** Runs xbuild outside the editor (MCP/CLI), streaming output to `onLine`. */
export async function runBuild(
  root: string,
  profile: Profile,
  opts: { paths?: ToolPaths; format?: "apk" | "aab"; onLine?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<BuildResult> {
  const cmd = xbuildCommand(root, profile, opts.format ?? "apk", opts.paths);
  const started = Date.now();
  const all: string[] = [];
  const proc = spawnLines(
    cmd.command,
    cmd.args,
    (line) => {
      all.push(line);
      opts.onLine?.(line);
    },
    {
      cwd: cmd.cwd,
      env: cmd.env,
      onStderr: (text) => {
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          all.push(line);
          opts.onLine?.(line);
        }
      },
    },
  );
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const exitCode = await proc.done;
  opts.signal?.removeEventListener("abort", onAbort);
  const text = all.join("\n");
  const apk = exitCode === 0 ? findApk(root, profile, started - 1000) : undefined;
  return {
    ok: exitCode === 0,
    exitCode,
    apk,
    diagnostics: parseRustDiagnostics(text),
    tail: all.slice(-50).join("\n"),
    durationMs: Date.now() - started,
  };
}
