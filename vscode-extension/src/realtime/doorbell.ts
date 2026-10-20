import type { RefreshScope } from "./hub";

/**
 * Realtime "doorbell": a GitHub repository webhook delivers to an ntfy topic (or a smee channel),
 * and every editor subscribes to that stream. A ping only says *what* to refetch; its payload is
 * never trusted. Kept free of editor APIs so it can be unit-tested.
 */

export type DoorbellProvider = "ntfy" | "smee";

export interface DoorbellEvent {
  scope?: RefreshScope;
  /** A webhook ping (sent by setup/status checks). */
  ping?: string;
  /** Raw ntfy message id, for resuming with ?since=. */
  id?: string;
}

const TAG = /\[ld:(\w+):([^\]]*)\]/;

/** Large GitHub ids may come through Go templates as floats ("1.2345678901e+10"). */
function parseId(text: string): number | undefined {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** Maps a machine tag from the ntfy message template to a refresh scope. */
export function scopeFromTag(message: string): DoorbellEvent | undefined {
  const m = TAG.exec(message);
  if (!m) return undefined;
  const [, kind, value] = m;
  switch (kind) {
    case "d": {
      const n = parseId(value!);
      return { scope: n ? `chat:${n}` : "all" };
    }
    case "r": {
      const id = parseId(value!);
      return { scope: id ? `run:${id}` : "runs" };
    }
    case "rel":
      return { scope: "releases" };
    case "pr": {
      const n = parseId(value!);
      return { scope: n ? `pr:${n}` : "releases" };
    }
    case "m":
      return { scope: "members" };
    case "ping":
      return { ping: value || "ping" };
    default:
      return { scope: "all" };
  }
}

/** One line of ntfy's `/json` stream. Keepalive/open/poll_request events carry no hint. */
export function parseNtfyLine(line: string): DoorbellEvent | undefined {
  if (!line.trim()) return undefined;
  let msg: { id?: unknown; event?: unknown; message?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (msg.event !== "message" || typeof msg.message !== "string") return undefined;
  const ev = scopeFromTag(msg.message);
  if (!ev) return undefined;
  return { ...ev, id: typeof msg.id === "string" ? msg.id : undefined };
}

/** Maps a raw GitHub event (as relayed by smee) to a scope, reading only ids. */
export function scopeFromGithubEvent(event: string, body: any): DoorbellEvent | undefined {
  switch (event) {
    case "discussion":
    case "discussion_comment": {
      const n = parseId(String(body?.discussion?.number ?? ""));
      return { scope: n ? `chat:${n}` : "all" };
    }
    case "workflow_run": {
      const id = parseId(String(body?.workflow_run?.id ?? ""));
      return { scope: id ? `run:${id}` : "runs" };
    }
    case "release":
      return { scope: "releases" };
    case "pull_request": {
      const n = parseId(String(body?.pull_request?.number ?? body?.number ?? ""));
      return { scope: n ? `pr:${n}` : "releases" };
    }
    case "member":
      return { scope: "members" };
    case "ping":
      return { ping: String(body?.hook_id ?? "ping") };
    default:
      return undefined;
  }
}

/** smee.io SSE: `data: {"x-github-event": "...", "body": {...}}`. */
export function parseSmeeData(data: string): DoorbellEvent | undefined {
  let msg: any;
  try {
    msg = JSON.parse(data);
  } catch {
    return undefined;
  }
  const event = msg?.["x-github-event"];
  return typeof event === "string" ? scopeFromGithubEvent(event, msg.body) : undefined;
}

/** Splits a text stream into lines across chunk boundaries. */
export class LineSplitter {
  private buf = "";

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r?\n/);
    this.buf = parts.pop() ?? "";
    return parts;
  }
}

/** Minimal SSE parser: yields the `data` of each event. */
export class SseParser {
  private lines = new LineSplitter();
  private data: string[] = [];

  push(chunk: string): string[] {
    const out: string[] = [];
    for (const line of this.lines.push(chunk)) {
      if (line === "") {
        if (this.data.length) out.push(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return out;
  }
}

/**
 * Too many pings in a minute means someone is spamming the (public) topic: ignore the doorbell and
 * rely on polling for a while.
 */
export class SpamGuard {
  private stamps: number[] = [];
  private mutedUntil = 0;

  constructor(
    private readonly maxPerMinute = 30,
    private readonly muteMs = 5 * 60_000,
  ) {}

  /** Records a ping; returns false when the doorbell should be ignored. */
  allow(now: number): boolean {
    if (now < this.mutedUntil) return false;
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    this.stamps.push(now);
    if (this.stamps.length > this.maxPerMinute) {
      this.mutedUntil = now + this.muteMs;
      this.stamps = [];
      return false;
    }
    return true;
  }

  muted(now: number): boolean {
    return now < this.mutedUntil;
  }
}

export function nextBackoff(current: number): number {
  return Math.min(Math.max(current * 2, 1000), 60_000);
}

export type DoorbellStatus = "connecting" | "live" | "muted" | "offline" | "stopped";

export interface DoorbellOptions {
  provider: DoorbellProvider;
  /** ntfy topic URL (https://ntfy.sh/<topic>) or smee channel URL. */
  url: string;
  onEvent(ev: DoorbellEvent): void;
  onStatus(status: DoorbellStatus, detail?: string): void;
  /** Called after (re)connecting: something may have been missed, refresh everything. */
  onReconnect(): void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Long-lived subscription with exponential reconnect backoff (1–60 s). */
export class Doorbell {
  private abort: AbortController | undefined;
  private stopped = true;
  private backoff = 1000;
  private lastId: string | undefined;
  private timer: unknown;
  private readonly guard = new SpamGuard();
  private connectedOnce = false;
  private failures = 0;

  constructor(private readonly opts: DoorbellOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    if (this.timer !== undefined) (this.opts.clearTimer ?? clearTimeout)(this.timer as NodeJS.Timeout);
    this.timer = undefined;
    this.opts.onStatus("stopped");
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private streamUrl(): string {
    if (this.opts.provider === "smee") return this.opts.url;
    const base = this.opts.url.replace(/\/+$/, "");
    return `${base}/json?since=${encodeURIComponent(this.lastId ?? "10m")}`;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.opts.onStatus("connecting");
    const abort = new AbortController();
    this.abort = abort;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.streamUrl(), {
        signal: abort.signal,
        headers: this.opts.provider === "smee" ? { accept: "text/event-stream" } : {},
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.failures = 0;
      this.opts.onStatus(this.guard.muted(this.now()) ? "muted" : "live");
      if (this.connectedOnce) this.opts.onReconnect();
      this.connectedOnce = true;
      this.backoff = 1000;
      const decoder = new TextDecoder();
      const lines = new LineSplitter();
      const sse = new SseParser();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const events = this.opts.provider === "smee" ? sse.push(text).map(parseSmeeData) : lines.push(text).map(parseNtfyLine);
        for (const ev of events) if (ev) this.deliver(ev);
      }
      throw new Error("stream ended");
    } catch (e) {
      if (this.stopped || abort.signal.aborted) return;
      this.failures++;
      this.opts.onStatus(this.failures >= 3 ? "offline" : "connecting", e instanceof Error ? e.message : String(e));
      const delay = this.backoff;
      this.backoff = nextBackoff(this.backoff);
      this.timer = (this.opts.setTimer ?? setTimeout)(() => void this.connect(), delay);
    }
  }

  private deliver(ev: DoorbellEvent): void {
    if (ev.id) this.lastId = ev.id;
    if (ev.ping) {
      this.opts.onEvent(ev);
      return;
    }
    const wasMuted = this.guard.muted(this.now());
    if (!this.guard.allow(this.now())) {
      if (!wasMuted) this.opts.onStatus("muted", "too many pings; polling for 5 minutes");
      return;
    }
    if (wasMuted) this.opts.onStatus("live");
    this.opts.onEvent(ev);
  }
}
