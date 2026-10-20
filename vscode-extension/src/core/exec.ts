import { spawn, type ChildProcess } from "node:child_process";
import { LdError } from "./errors";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string | Buffer;
  /** Stop collecting stdout beyond this many bytes (the process keeps running). */
  maxBuffer?: number;
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a program with an argument array (never through a shell) and collects its output.
 * Resolves on exit whatever the status; callers decide what a failure is.
 */
export function execFile(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new LdError("CANCELLED", `Cancelled before running ${cmd}`));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      reject(e);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let timedOut = false;
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;

    child.stdout!.on("data", (d: Buffer) => {
      if (size < max) {
        chunks.push(d);
        size += d.length;
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (stderr.length < 1024 * 1024) stderr += d.toString("utf8");
    });

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : undefined;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) {
        reject(new LdError("CANCELLED", `Cancelled: ${cmd} ${args.join(" ")}`));
        return;
      }
      resolve({ code, signal, stdout: Buffer.concat(chunks), stderr, timedOut });
    });

    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

export interface LineProcess {
  readonly child: ChildProcess;
  /** Resolves with the exit code once the process has exited and all lines were delivered. */
  readonly done: Promise<number | null>;
  kill(): void;
}

/** Spawns a long-running program and delivers its stdout line by line. */
export function spawnLines(
  cmd: string,
  args: readonly string[],
  onLine: (line: string) => void,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onStderr?: (text: string) => void } = {},
): LineProcess {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let pending = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    pending += d;
    let idx: number;
    while ((idx = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, idx).replace(/\r$/, "");
      pending = pending.slice(idx + 1);
      onLine(line);
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => opts.onStderr?.(d));
  const done = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (pending) onLine(pending.replace(/\r$/, ""));
      pending = "";
      resolve(code);
    });
  });
  return {
    child,
    done,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LdError("CANCELLED", "Cancelled"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new LdError("CANCELLED", "Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
