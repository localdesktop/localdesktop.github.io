import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { which } from "../env";
import { LdError } from "../errors";
import { sleep } from "../exec";
import type { Adb } from "./adb";
import { parseForwardPort } from "./wireless";

export const JDWP_HANDSHAKE = "JDWP-Handshake";
const HEADER_LENGTH = 11;
const REPLY_FLAG = 0x80;

/** VirtualMachine.Resume (command set 1, command 9): 11-byte header, no payload. */
export function resumePacket(id: number): Buffer {
  const buf = Buffer.alloc(HEADER_LENGTH);
  buf.writeUInt32BE(HEADER_LENGTH, 0);
  buf.writeUInt32BE(id >>> 0, 4);
  buf[8] = 0;
  buf[9] = 1;
  buf[10] = 9;
  return buf;
}

/**
 * A minimal JDWP client: performs the handshake and resumes the VM, which releases an app started
 * with `am start -D`. The socket stays open (and drained) for the session so ART keeps treating a
 * debugger as attached; closing it is how the session lets go.
 */
export class JdwpConnection {
  private buffered = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private closed = false;
  private nextId = 1;

  private constructor(private readonly socket: net.Socket) {
    socket.on("data", (d: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, d]);
      // Never let unsolicited events (or replies nobody waits for) pile up.
      if (this.buffered.length > 1024 * 1024) this.buffered = Buffer.alloc(0);
      this.wake();
    });
    const end = () => {
      this.closed = true;
      this.wake();
    };
    socket.on("close", end);
    socket.on("end", end);
    socket.on("error", end);
  }

  static async connect(port: number, host = "127.0.0.1", timeoutMs = 10_000): Promise<JdwpConnection> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ port, host });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new LdError("TIMEOUT", `Timed out connecting to JDWP on ${host}:${port}`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const conn = new JdwpConnection(socket);
    try {
      socket.write(JDWP_HANDSHAKE, "latin1");
      const reply = await conn.read(JDWP_HANDSHAKE.length, timeoutMs);
      if (reply.toString("latin1") !== JDWP_HANDSHAKE) throw new LdError("COMMAND_FAILED", "JDWP handshake failed (unexpected reply).");
    } catch (e) {
      conn.close();
      throw e;
    }
    return conn;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  private async read(n: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.buffered.length < n) {
      if (this.closed) throw new LdError("COMMAND_FAILED", "JDWP connection closed.");
      const left = deadline - Date.now();
      if (left <= 0) throw new LdError("TIMEOUT", "Timed out waiting for the JDWP peer.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return Buffer.from(out);
  }

  /** Sends VirtualMachine.Resume and waits for its reply, skipping unrelated packets. */
  async resume(timeoutMs = 10_000): Promise<void> {
    const id = this.nextId++;
    this.socket.write(resumePacket(id));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const header = await this.read(HEADER_LENGTH, Math.max(1, deadline - Date.now()));
      const length = header.readUInt32BE(0);
      const packetId = header.readUInt32BE(4);
      const flags = header[8]!;
      if (length > HEADER_LENGTH) await this.read(length - HEADER_LENGTH, Math.max(1, deadline - Date.now()));
      if (!(flags & REPLY_FLAG) || packetId !== id) continue;
      const error = header.readUInt16BE(9);
      if (error !== 0) throw new LdError("COMMAND_FAILED", `JDWP resume failed (error ${error}).`);
      return;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
    this.wake();
  }
}

export async function forwardJdwp(adb: Adb, pid: number): Promise<number> {
  const out = await adb.run(["forward", "tcp:0", `jdwp:${pid}`], { timeoutMs: 15_000 });
  const port = parseForwardPort(out);
  if (!port) throw new LdError("COMMAND_FAILED", `adb forward jdwp:${pid} returned no port: ${out.trim()}`);
  return port;
}

export async function removeForward(adb: Adb, port: number): Promise<void> {
  await adb.run(["forward", "--remove", `tcp:${port}`], { allowFailure: true, timeoutMs: 10_000 });
}

function findJdb(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = process.platform === "win32" ? "jdb.exe" : "jdb";
  if (env.JAVA_HOME) {
    const p = path.join(env.JAVA_HOME, "bin", exe);
    try {
      fs.accessSync(p);
      return p;
    } catch {
      // fall through
    }
  }
  return which("jdb", env);
}

export interface JavaRelease {
  /** How the app was released: our JDWP client, or jdb as a fallback. */
  method: "jdwp" | "jdb";
  close(): Promise<void>;
}

/**
 * Releases an app waiting in `am start -D`: forwards its JDWP port, handshakes and resumes the VM.
 * Falls back to attaching `jdb` (kept running until close()).
 */
export async function releaseWaitingApp(
  adb: Adb,
  pid: number,
  opts: { log?: (message: string) => void; timeoutMs?: number } = {},
): Promise<JavaRelease> {
  const log = opts.log ?? (() => undefined);
  // The VM only answers once its threads run; under LLDB that's after the native debugger resumes.
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const port = await forwardJdwp(adb, pid);
  try {
    const conn = await JdwpConnection.connect(port, "127.0.0.1", timeoutMs);
    await conn.resume(timeoutMs);
    return {
      method: "jdwp",
      close: async () => {
        conn.close();
        await removeForward(adb, port);
      },
    };
  } catch (e) {
    log(`JDWP resume failed (${e instanceof Error ? e.message : String(e)}); trying jdb…`);
  }
  const jdb = findJdb();
  if (!jdb) {
    await removeForward(adb, port);
    throw new LdError("COMMAND_FAILED", "Couldn't release the app from 'waiting for debugger'.", "Install a JDK (jdb) or stop and restart the app.");
  }
  // The previous attempt may have consumed the JDWP connection; forward again for a fresh one.
  await removeForward(adb, port);
  const jdbPort = await forwardJdwp(adb, pid);
  const child: ChildProcess = spawn(jdb, ["-connect", `com.sun.jdi.SocketAttach:hostname=localhost,port=${jdbPort}`], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  child.on("error", () => undefined);
  await sleep(2000);
  if (child.exitCode !== null) {
    await removeForward(adb, jdbPort);
    throw new LdError("COMMAND_FAILED", `jdb exited (code ${child.exitCode}) before the app was released.`);
  }
  return {
    method: "jdb",
    close: async () => {
      child.stdin?.end("exit\n");
      setTimeout(() => child.kill(), 1000).unref();
      await removeForward(adb, jdbPort);
    },
  };
}
