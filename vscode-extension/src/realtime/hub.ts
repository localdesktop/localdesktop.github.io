import * as vscode from "vscode";

/** What to refetch. Doorbell pings, timers, focus changes and git/file events all become hints. */
export type RefreshScope =
  | "all"
  | "releases"
  | "runs"
  | `run:${number}`
  | `pr:${number}`
  | `chat:${number}`
  | "keys"
  | "members"
  | "website";

export interface RefreshHint {
  scope: RefreshScope;
  source: "doorbell" | "timer" | "focus" | "manual" | "git" | "fs";
}

export type RealtimeStatus = "live" | "polling" | "offline";

/**
 * Fan-out point between refresh sources (the realtime doorbell, timers) and the views that refetch
 * (Releases & CI, Website, Chat). Views never trust a hint's payload; they only refetch.
 */
export class RealtimeHub implements vscode.Disposable {
  private readonly hintEmitter = new vscode.EventEmitter<RefreshHint>();
  private readonly statusEmitter = new vscode.EventEmitter<RealtimeStatus>();
  readonly onHint = this.hintEmitter.event;
  readonly onDidChangeStatus = this.statusEmitter.event;
  private currentStatus: RealtimeStatus = "polling";

  get status(): RealtimeStatus {
    return this.currentStatus;
  }

  setStatus(status: RealtimeStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  fire(hint: RefreshHint): void {
    this.hintEmitter.fire(hint);
  }

  dispose(): void {
    this.hintEmitter.dispose();
    this.statusEmitter.dispose();
  }
}

/** True when a hint should refresh something scoped to `prefix` (e.g. "run:" or "chat:"). */
export function hintMatches(hint: RefreshHint, ...scopes: string[]): boolean {
  if (hint.scope === "all") return true;
  return scopes.some((s) => (s.endsWith(":") ? hint.scope.startsWith(s) : hint.scope === s));
}
