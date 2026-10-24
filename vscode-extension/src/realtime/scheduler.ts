import type { RefreshHint } from "./hub";

/** Injectable clock and timers (fake timers in tests). */
export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Merges bursts of hints per scope: waits `debounceMs` after the last hint of a scope, and emits a
 * scope at most once per `minIntervalMs` so a busy CI run can't trigger a refetch storm.
 */
export class Coalescer {
  private readonly pending = new Map<string, { hint: RefreshHint; timer: unknown }>();
  private readonly lastEmit = new Map<string, number>();

  constructor(
    private readonly emit: (hint: RefreshHint) => void,
    private readonly clock: Clock = systemClock,
    private readonly debounceMs = 750,
    private readonly minIntervalMs = 3000,
  ) {}

  push(hint: RefreshHint): void {
    const existing = this.pending.get(hint.scope);
    if (existing) this.clock.clearTimer(existing.timer);
    const since = this.clock.now() - (this.lastEmit.get(hint.scope) ?? -Infinity);
    const delay = Math.max(this.debounceMs, this.minIntervalMs - since);
    // Keep the most specific source: a doorbell ping beats a timer.
    const merged = existing && existing.hint.source === "doorbell" ? existing.hint : hint;
    const timer = this.clock.setTimer(() => {
      this.pending.delete(hint.scope);
      this.lastEmit.set(hint.scope, this.clock.now());
      this.emit(merged);
    }, delay);
    this.pending.set(hint.scope, { hint: merged, timer });
  }

  dispose(): void {
    for (const p of this.pending.values()) this.clock.clearTimer(p.timer);
    this.pending.clear();
  }
}

export interface PollOptions {
  /** Interval while the doorbell isn't live and the window is focused. */
  pollMs: () => number;
  /** Interval while the window is in the background. */
  hiddenMs?: number;
  /** Safety-net interval while the doorbell is live (catches missed pings and edits). */
  liveMs?: number;
}

/**
 * Fallback refresh timer: frequent when realtime is unavailable, slow when it's live or the window
 * is hidden; regaining focus triggers an immediate refresh if the last one is stale.
 */
export class PollScheduler {
  private live = false;
  private focused = true;
  private timer: unknown;
  private lastFire: number;
  private running = false;

  constructor(
    private readonly emit: (hint: RefreshHint) => void,
    private readonly opts: PollOptions,
    private readonly clock: Clock = systemClock,
  ) {
    this.lastFire = clock.now();
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  interval(): number {
    if (!this.focused) return this.opts.hiddenMs ?? 5 * 60_000;
    if (this.live) return this.opts.liveMs ?? 5 * 60_000;
    return Math.max(15_000, this.opts.pollMs());
  }

  setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    this.schedule();
  }

  setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    if (focused && this.clock.now() - this.lastFire > 30_000) this.fire("focus");
    else this.schedule();
  }

  private fire(source: RefreshHint["source"]): void {
    this.lastFire = this.clock.now();
    this.emit({ scope: "all", source });
    this.schedule();
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    const due = Math.max(0, this.lastFire + this.interval() - this.clock.now());
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined;
      this.fire("timer");
    }, due);
  }
}
