import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Adb } from "../adb/adb";
import type { LineProcess } from "../exec";
import { parseLogLine, type LogEntry } from "./parse";

export interface LogcatStreamOptions {
  uid?: number;
  /** Device epoch seconds to start from (avoids replaying old lines). */
  sinceEpoch?: number;
}

/**
 * A live `logcat --uid` stream that reconnects with backoff and resumes from the last timestamp.
 * Emits "line" (raw, entry | undefined), "status" (connected|reconnecting|stopped), "error".
 */
export class LogcatStream extends EventEmitter {
  private proc: LineProcess | undefined;
  private stopped = false;
  private backoffMs = 1000;
  private lastEpoch: number | undefined;
  private useUid = true;

  constructor(
    private readonly adb: Adb,
    private readonly opts: LogcatStreamOptions,
  ) {
    super();
    this.lastEpoch = opts.sinceEpoch;
  }

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = undefined;
    this.emit("status", "stopped");
  }

  private spawn(): void {
    const args = ["logcat", "-v", "threadtime", "-v", "epoch"];
    if (this.lastEpoch !== undefined) args.push("-T", `${this.lastEpoch.toFixed(3)}`);
    if (this.opts.uid !== undefined && this.useUid) args.push(`--uid=${this.opts.uid}`);
    let gotLine = false;
    let stderr = "";
    const proc = this.adb.spawnLines(
      ["shell", args.join(" ")],
      (line) => {
        gotLine = true;
        this.backoffMs = 1000;
        const epoch = /^\s*(\d+\.\d{3})\s/.exec(line);
        if (epoch) this.lastEpoch = parseFloat(epoch[1]!) + 0.001;
        const display = epoch ? epochLineToThreadtime(line) : line;
        this.emit("line", display, parseLogLine(display));
      },
      (text) => (stderr += text),
    );
    this.proc = proc;
    this.emit("status", "connected");
    void proc.done.then(() => {
      if (this.stopped || this.proc !== proc) return;
      if (!gotLine && /unrecognized option|invalid option/i.test(stderr) && this.useUid) {
        this.useUid = false;
        this.emit("error", new Error("This device's logcat doesn't support --uid; showing all logs."));
        this.spawn();
        return;
      }
      this.emit("status", "reconnecting");
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      setTimeout(() => {
        if (!this.stopped && this.proc === proc) this.spawn();
      }, delay);
    });
  }
}

/** `-v epoch` prints seconds instead of a date; convert to the threadtime layout for display/parsing. */
export function epochLineToThreadtime(line: string): string {
  const m = /^\s*(\d+)\.(\d{3})(\s+.*)$/.exec(line);
  if (!m) return line;
  const d = new Date(parseInt(m[1]!, 10) * 1000 + parseInt(m[2]!, 10));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${m[2]}`;
  return stamp + m[3];
}

/** Appends lines to a log file and rotates it (file → file.1) when it exceeds maxBytes. */
export class RotatingFileSink {
  private fd: number | undefined;
  private size = 0;

  constructor(
    readonly file: string,
    private readonly maxBytes: number,
  ) {}

  write(line: string): void {
    if (this.fd === undefined) this.open();
    const data = line + "\n";
    fs.writeSync(this.fd!, data);
    this.size += Buffer.byteLength(data);
    if (this.size > this.maxBytes) this.rotate();
  }

  close(): void {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }

  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, "a");
    this.size = fs.fstatSync(this.fd).size;
  }

  private rotate(): void {
    this.close();
    const ext = path.extname(this.file);
    const rotated = this.file.slice(0, this.file.length - ext.length) + ".1" + ext;
    try {
      fs.renameSync(this.file, rotated);
    } catch {
      // another process may have rotated it
    }
    this.open();
  }
}

export type { LogEntry };
