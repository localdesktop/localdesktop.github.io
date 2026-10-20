import * as path from "node:path";
import { execFile } from "../exec";

export interface RustToolchain {
  /** Commit hash of the compiler (std paths in DWARF are /rustc/<hash>/library/…). */
  commitHash?: string;
  release?: string;
  sysroot?: string;
}

/** Parses `rustc -vV`. */
export function parseRustcVersion(output: string): { commitHash?: string; release?: string } {
  const field = (key: string) => new RegExp(`^${key}:\\s*(\\S+)`, "m").exec(output)?.[1];
  const hash = field("commit-hash");
  return { commitHash: hash && hash !== "unknown" ? hash : undefined, release: field("release") };
}

const cache = new Map<string, Promise<RustToolchain>>();

/** Reads the active toolchain for `cwd` (rust-toolchain files apply), cached per directory. */
export function rustToolchain(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<RustToolchain> {
  let hit = cache.get(cwd);
  if (!hit) {
    hit = (async () => {
      const [version, sysroot] = await Promise.all([
        execFile("rustc", ["-vV"], { cwd, env, timeoutMs: 20_000 }).catch(() => undefined),
        execFile("rustc", ["--print", "sysroot"], { cwd, env, timeoutMs: 20_000 }).catch(() => undefined),
      ]);
      const parsed = version?.code === 0 ? parseRustcVersion(version.stdout.toString("utf8")) : {};
      const root = sysroot?.code === 0 ? sysroot.stdout.toString("utf8").trim() : undefined;
      return { ...parsed, sysroot: root || undefined };
    })();
    cache.set(cwd, hit);
  }
  return hit;
}

/** Maps the compiler's remapped std paths to the local rust-src component, so stepping into std works. */
export function rustSourceMap(t: RustToolchain): Record<string, string> {
  if (!t.commitHash || !t.sysroot) return {};
  return { [`/rustc/${t.commitHash}`]: path.join(t.sysroot, "lib", "rustlib", "src", "rust") };
}
