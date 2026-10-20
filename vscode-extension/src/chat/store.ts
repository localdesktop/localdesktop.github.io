import type * as vscode from "vscode";
import type { Privacy } from "./protocol";
import type { CommentNode, CommentPage, DiscussionSummary } from "./discussionsApi";

export interface Channel {
  discussion: DiscussionSummary;
  privacy: Privacy;
  privacyWarning?: string;
}

export interface ChannelComments {
  nodes: CommentNode[];
  olderCursor: string | null;
  totalCount: number;
  updatedAt?: string;
  fetchedAt: number;
}

export interface PendingMessage {
  localId: string;
  channelId: string;
  text: string;
  replyTo?: string;
  notify: boolean;
  status: "pending" | "failed";
  createdAt: string;
  error?: string;
}

/**
 * Chat data held by the host: channels, fetched comments, local echoes, read markers (persisted per
 * repository in globalState) and anti-rollback revisions of encrypted messages.
 */
export class ChatStore {
  channels: Channel[] = [];
  readonly comments = new Map<string, ChannelComments>();
  pending: PendingMessage[] = [];
  /** Highest revision seen per message id (edits may only move forward). */
  readonly maxRev = new Map<string, number>();

  constructor(
    private readonly memento: vscode.Memento,
    private readonly repoNodeId: string,
  ) {}

  private key(kind: string): string {
    return `ld.chat.${kind}.${this.repoNodeId}`;
  }

  /** Replaces the newest page, keeping older comments the user already loaded. */
  setLatest(channelId: string, page: CommentPage, updatedAt?: string): void {
    const existing = this.comments.get(channelId);
    const byId = new Map<string, CommentNode>();
    const newestFirst = page.comments[0]?.createdAt;
    if (existing && newestFirst) {
      for (const n of existing.nodes) if (n.createdAt < newestFirst) byId.set(n.id, n);
    }
    for (const n of page.comments) byId.set(n.id, n);
    const nodes = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    this.comments.set(channelId, {
      nodes,
      olderCursor: existing && existing.nodes.length > page.comments.length ? existing.olderCursor : page.olderCursor,
      totalCount: page.totalCount,
      updatedAt,
      fetchedAt: Date.now(),
    });
  }

  addOlder(channelId: string, page: CommentPage): void {
    const existing = this.comments.get(channelId);
    if (!existing) return this.setLatest(channelId, page);
    const ids = new Set(existing.nodes.map((n) => n.id));
    existing.nodes = [...page.comments.filter((n) => !ids.has(n.id)), ...existing.nodes];
    existing.olderCursor = page.olderCursor;
  }

  lastSeenCount(channelId: string): number | undefined {
    return this.memento.get<Record<string, number>>(this.key("seen"))?.[channelId];
  }

  async markSeen(channelId: string, count: number): Promise<void> {
    const all = { ...(this.memento.get<Record<string, number>>(this.key("seen")) ?? {}) };
    if (all[channelId] === count) return;
    all[channelId] = count;
    await this.memento.update(this.key("seen"), all);
  }

  /** Top-level comments added since the channel was last read (replies aren't counted). */
  unread(channelId: string, totalCount: number): number {
    const seen = this.lastSeenCount(channelId);
    return seen === undefined ? 0 : Math.max(0, totalCount - seen);
  }

  lastNotified(channelId: string): string | undefined {
    return this.memento.get<Record<string, string>>(this.key("notified"))?.[channelId];
  }

  async setNotified(channelId: string, iso: string): Promise<void> {
    const all = { ...(this.memento.get<Record<string, string>>(this.key("notified")) ?? {}) };
    all[channelId] = iso;
    await this.memento.update(this.key("notified"), all);
  }

  get activeChannel(): string | undefined {
    return this.memento.get<string>(this.key("active"));
  }

  async setActiveChannel(id: string): Promise<void> {
    await this.memento.update(this.key("active"), id);
  }
}
