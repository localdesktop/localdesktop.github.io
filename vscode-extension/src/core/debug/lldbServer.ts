import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { Adb } from "../adb/adb";
import { runAs } from "../adb/app";
import { LdError } from "../errors";
import { sleep, type LineProcess } from "../exec";
import { shQuote } from "../shell";

/** Staging path on the shell-writable tmp dir; the binary is then piped into the app's data dir. */
export const DEVICE_TMP_LLDB_SERVER = "/data/local/tmp/ld-lldb-server";
/** Relative to the app's data dir (run-as starts there). */
export const APP_LLDB_SERVER = "lldb/bin/lldb-server";

export function md5File(file: string): string {
  return createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Copies lldb-server into the app's sandbox (only run-as can exec it there under SELinux).
 * Skips the copy when the on-device md5 matches.
 */
export async function deployLldbServer(adb: Adb, pkg: string, localPath: string, signal?: AbortSignal): Promise<"copied" | "unchanged"> {
  const localMd5 = md5File(localPath);
  const remote = await adb.shellResult(runAs(pkg, `md5sum ${APP_LLDB_SERVER} 2>/dev/null`), { signal, timeoutMs: 20_000 });
  if (remote.stdout.toString("utf8").trim().split(/\s+/)[0] === localMd5) return "unchanged";

  await adb.run(["push", localPath, DEVICE_TMP_LLDB_SERVER], { signal, timeoutMs: 5 * 60_000 });
  const install = `mkdir -p lldb/bin && cat > ${APP_LLDB_SERVER} && chmod 700 ${APP_LLDB_SERVER}`;
  const res = await adb.shellResult(`cat ${DEVICE_TMP_LLDB_SERVER} | ${runAs(pkg, install)}`, { signal, timeoutMs: 60_000 });
  await adb.shell(`rm -f ${DEVICE_TMP_LLDB_SERVER}`, { allowFailure: true });
  const out = `${res.stdout.toString("utf8")}${res.stderr}`.trim();
  if (res.code !== 0 || /run-as:|not debuggable|Permission denied/i.test(out)) {
    throw new LdError("NOT_DEBUGGABLE", `Couldn't copy lldb-server into ${pkg}: ${out || `exit ${res.code}`}`, "Install a debug build of the app (F5 does this).");
  }
  return "copied";
}

/** Kills lldb-server instances left by an earlier session (ignores failures). */
export async function killLldbServers(adb: Adb, pkg: string): Promise<void> {
  // Matches the platform ("./bin/lldb-server platform …") and the gdbservers it spawns (absolute path).
  await adb.shellResult(runAs(pkg, "pkill -f bin/lldb-server; true"), { timeoutMs: 15_000 }).catch(() => undefined);
}

export interface PlatformSocket {
  /** Abstract socket directory, also LLDB_DEBUGSERVER_DOMAINSOCKET_DIR for spawned gdbservers. */
  dir: string;
  /** Abstract socket path, e.g. "/io.github.localdesktop-1a2b3c4d/platform.sock". */
  path: string;
}

export function newPlatformSocket(pkg: string, rand = randomBytes(4).toString("hex")): PlatformSocket {
  const dir = `/${pkg}-${rand}`;
  return { dir, path: `${dir}/platform.sock` };
}

/** Device shell line that runs the LLDB platform server as the app's uid. */
export function platformServerCommand(pkg: string, socket: PlatformSocket, log = false): string {
  const logArgs = log ? ` --log-file platform.log --log-channels ${shQuote("lldb process:gdb-remote packets")}` : "";
  // No --server: the platform exits when LLDB disconnects, so sessions don't leak servers.
  const inner = `cd lldb && LLDB_DEBUGSERVER_DOMAINSOCKET_DIR=${socket.dir} exec ./bin/lldb-server platform --listen unix-abstract://${socket.path}${logArgs}`;
  return runAs(pkg, inner);
}

/** True when /proc/net/unix lists the abstract socket ("@/pkg-rand/platform.sock"). */
export function procNetUnixHas(output: string, socketPath: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    const last = line.trim().split(/\s+/).pop();
    return last === `@${socketPath}` || last === socketPath;
  });
}

/** A running `lldb-server platform` inside the app sandbox. */
export class PlatformServer {
  private exited = false;

  private constructor(
    private readonly adb: Adb,
    private readonly pkg: string,
    readonly socket: PlatformSocket,
    private readonly proc: LineProcess,
    private readonly output: { text: string },
  ) {
    void proc.done.then(() => {
      this.exited = true;
    });
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get recentOutput(): string {
    return this.output.text.slice(-4000);
  }

  static async start(
    adb: Adb,
    pkg: string,
    opts: { log?: boolean; timeoutMs?: number; signal?: AbortSignal; onOutput?: (line: string) => void } = {},
  ): Promise<PlatformServer> {
    const socket = newPlatformSocket(pkg);
    const output = { text: "" };
    const record = (line: string) => {
      output.text += line + "\n";
      opts.onOutput?.(line);
    };
    const proc = adb.spawnLines(["shell", platformServerCommand(pkg, socket, opts.log)], record, (text) => text.split(/\r?\n/).filter(Boolean).forEach(record));
    const server = new PlatformServer(adb, pkg, socket, proc, output);

    try {
      const deadline = Date.now() + (opts.timeoutMs ?? 8000);
      while (Date.now() < deadline) {
        if (server.exited) {
          throw new LdError("COMMAND_FAILED", `lldb-server exited right away: ${server.recentOutput.trim() || "no output"}`, "Enable lldbServerLog and check lldb/platform.log in the app's data dir.");
        }
        const unix = await adb.shellResult(runAs(pkg, "cat /proc/net/unix"), { timeoutMs: 10_000, signal: opts.signal });
        if (procNetUnixHas(unix.stdout.toString("utf8"), socket.path)) return server;
        await sleep(200, opts.signal);
      }
      throw new LdError("TIMEOUT", "lldb-server didn't start listening in time.", "Enable lldbServerLog in launch.json and check lldb/platform.log (run-as <pkg> cat lldb/platform.log).");
    } catch (e) {
      await server.stop();
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.proc.kill();
    await killLldbServers(this.adb, this.pkg);
  }
}
