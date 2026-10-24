import * as vscode from "vscode";
import { errorMessage, LdError } from "../core/errors";
import type { Services } from "../extension/services";
import { atLeast, type GitHubClient } from "../github/client";
import { loadRepoConfig } from "../realtime/config";
import { hintMatches, type RefreshHint } from "../realtime/hub";
import { realtimeConfig } from "../realtime";
import { REACTIONS, type ChatState, type ChannelView, type HostToWebview, type MessageView, type WebviewToHost } from "../shared/messages";
import { cryptoReady, decryptMessage, encryptMessage } from "./crypto";
import { DiscussionsApi, permissionAtLeast, type CommentNode, type DiscussionCategory } from "./discussionsApi";
import { channelBody, extractMentions, isEncryptedBody, parseDiscussionMarker, withPrivacy, type Privacy } from "./protocol";
import { renderMarkdown, undecryptableHtml } from "./render";
import { ChatStore, type Channel } from "./store";

export interface ChatSurface {
  post(message: HostToWebview): void;
  readonly visible: boolean;
}

const DETAIL_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_CATEGORY = "chat";

interface Session {
  client: GitHubClient;
  api: DiscussionsApi;
  store: ChatStore;
  category?: DiscussionCategory;
}

/**
 * Host side of the chat: talks to Discussions, decrypts/encrypts, tracks unread state, and pushes a
 * complete ChatState to every open chat surface (sidebar view and editor panel).
 */
export class ChatController implements vscode.Disposable {
  private session: Session | undefined;
  private readonly surfaces = new Set<ChatSurface>();
  private state: ChatState = emptyState();
  private refreshing: Promise<void> | undefined;
  private queued: RefreshHint | undefined;
  private readonly badgeEmitter = new vscode.EventEmitter<number>();
  /** Total unread count for the view badge. */
  readonly onDidChangeUnread = this.badgeEmitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly s: Services) {
    this.subs.push(
      s.hub.onHint((h) => {
        if (hintMatches(h, "chat:", "members", "all")) void this.refresh(h);
      }),
      s.upstream.onDidChange(() => {
        this.session = undefined;
        void this.refresh({ scope: "all", source: "manual" });
      }),
    );
  }

  attach(surface: ChatSurface): vscode.Disposable {
    this.surfaces.add(surface);
    surface.post({ type: "state", state: this.state });
    void this.refresh({ scope: "all", source: "manual" });
    return new vscode.Disposable(() => this.surfaces.delete(surface));
  }

  private get anyVisible(): boolean {
    return [...this.surfaces].some((v) => v.visible);
  }

  private publish(patch: Partial<ChatState> = {}): void {
    this.state = { ...this.state, ...patch };
    for (const v of this.surfaces) v.post({ type: "state", state: this.state });
    const unread = this.state.channels.reduce((n, c) => n + (c.id === this.state.activeChannel && this.anyVisible ? 0 : c.unread), 0);
    this.badgeEmitter.fire(unread);
  }

  /** Serializes refreshes; a hint arriving mid-refresh queues one more pass. */
  refresh(hint: RefreshHint = { scope: "all", source: "manual" }): Promise<void> {
    if (this.refreshing) {
      this.queued = this.queued && this.queued.scope === "all" ? this.queued : hint;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh(hint)
      .catch((e) => {
        this.s.output.warn(`chat: ${errorMessage(e)}`);
        this.publish({ loading: false, error: errorMessage(e) });
      })
      .finally(() => {
        this.refreshing = undefined;
        const next = this.queued;
        this.queued = undefined;
        if (next) void this.refresh(next);
      });
    return this.refreshing;
  }

  private async ensureSession(): Promise<Session | undefined> {
    const client = await this.s.upstream.tryClient();
    if (!client) {
      this.session = undefined;
      return undefined;
    }
    if (this.session?.client !== client) {
      await cryptoReady();
      this.session = {
        client,
        api: new DiscussionsApi(client),
        store: new ChatStore(this.s.context.globalState, client.repo.nodeId),
      };
    }
    return this.session;
  }

  private async doRefresh(hint: RefreshHint): Promise<void> {
    const session = await this.ensureSession();
    if (!session) {
      this.publish({ ...emptyState(), signedIn: false, setup: "ready", loading: false });
      return;
    }
    const { client, api, store } = session;
    const perm = client.repo.viewerPermission;
    const base: Partial<ChatState> = {
      signedIn: true,
      viewer: client.repo.viewerLogin,
      canWrite: true,
      canMaintain: atLeast(perm, "MAINTAIN"),
      isAdmin: atLeast(perm, "ADMIN"),
      ccDefault: vscode.workspace.getConfiguration("localdesktop").get<boolean>("chat.ccMentions", false),
      error: undefined,
    };
    if (!client.repo.hasDiscussions) {
      this.publish({ ...base, setup: "noDiscussions", channels: [], messages: [], loading: false });
      return;
    }
    if (hint.scope === "members") api.invalidatePermissions();

    const full = hint.scope === "all" || !session.category;
    if (full) {
      if (!this.state.channels.length) this.publish({ ...base, setup: "loading", loading: true });
      await this.loadChannels(session);
      if (!session.category) {
        this.publish({ ...base, setup: "noCategory", channels: [], messages: [], loading: false });
        return;
      }
    }
    const channels = store.channels;
    if (!channels.length) {
      this.publish({ ...base, setup: "noChannels", channels: [], messages: [], loading: false });
      return;
    }
    let active = channels.find((c) => c.discussion.id === (this.state.activeChannel ?? store.activeChannel)) ?? channels[0]!;

    const heads = await api.heads(channels.map((c) => c.discussion.id));
    const hinted = hint.scope.startsWith("chat:") ? Number(hint.scope.slice(5)) : undefined;
    for (const c of channels) {
      const head = heads.get(c.discussion.id);
      if (!head) continue;
      const cached = store.comments.get(c.discussion.id);
      const changed = !cached || cached.updatedAt !== head.updatedAt || cached.totalCount !== head.commentCount;
      const stale = cached && Date.now() - cached.fetchedAt > DETAIL_MAX_AGE_MS;
      c.discussion.commentCount = head.commentCount;
      const isActive = c === active;
      // Details for the open channel, and for hinted channels so notifications can be shown.
      if ((isActive && (changed || stale || hinted === c.discussion.number || hint.source === "manual")) || (!isActive && changed && hinted === c.discussion.number)) {
        store.setLatest(c.discussion.id, await api.comments(c.discussion.id), head.updatedAt);
        await this.notifyNew(session, c);
      }
      if (store.lastSeenCount(c.discussion.id) === undefined) await store.markSeen(c.discussion.id, head.commentCount);
    }
    active = channels.find((c) => c.discussion.id === active.discussion.id) ?? active;
    if (this.anyVisible) await store.markSeen(active.discussion.id, active.discussion.commentCount);
    this.publish({
      ...base,
      setup: "ready",
      loading: false,
      channels: channels.map((c) => this.channelView(store, c)),
      activeChannel: active.discussion.id,
      messages: this.messagesFor(session, active),
      hasOlder: Boolean(store.comments.get(active.discussion.id)?.olderCursor),
    });
  }

  private async loadChannels(session: Session): Promise<void> {
    const { api, client, store } = session;
    const cfg = { ...(await loadRepoConfig(client, this.s.root)), ...(realtimeConfig().chat ? { chat: realtimeConfig().chat } : {}) };
    const slug = cfg.chat?.category ?? DEFAULT_CATEGORY;
    session.category = (await api.categories()).find((c) => c.slug === slug || c.name.toLowerCase() === slug.toLowerCase());
    if (!session.category) {
      store.channels = [];
      return;
    }
    const discussions = await api.discussions(session.category.id);
    const channels: Channel[] = [];
    for (const d of discussions) {
      const meta = parseDiscussionMarker(d.body);
      if (!meta) continue;
      // Only discussions created by people with write access count (anyone else's are ignored).
      if (!permissionAtLeast(await api.permission(d.author), "write")) continue;
      let privacy: Privacy = meta.privacy;
      let privacyWarning: string | undefined;
      if (d.lastEditedAt && d.editor && !permissionAtLeast(await api.permission(d.editor), "write")) {
        privacy = "private";
        privacyWarning = `The channel settings were edited by @${d.editor}, who doesn't have write access; treating it as private.`;
      }
      channels.push({ discussion: d, privacy, privacyWarning });
    }
    store.channels = channels;
  }

  private channelView(store: ChatStore, c: Channel): ChannelView {
    return {
      id: c.discussion.id,
      number: c.discussion.number,
      title: c.discussion.title,
      privacy: c.privacy,
      unread: store.unread(c.discussion.id, c.discussion.commentCount),
      url: c.discussion.url,
      privacyWarning: c.privacyWarning,
    };
  }

  private messagesFor(session: Session, channel: Channel): MessageView[] {
    const cached = session.store.comments.get(channel.discussion.id);
    const seen = new Set<string>();
    const views: MessageView[] = [];
    for (const c of cached?.nodes ?? []) {
      const v = this.toView(session, channel, c, "", seen);
      if (v) views.push(v);
    }
    for (const p of session.store.pending.filter((p) => p.channelId === channel.discussion.id)) {
      const view: MessageView = {
        id: p.localId,
        localId: p.localId,
        author: { login: session.client.repo.viewerLogin },
        createdAt: p.createdAt,
        html: renderMarkdown(p.text),
        status: p.status,
        statusDetail: p.error,
        edited: false,
        reactions: [],
        canEdit: false,
        canDelete: false,
        replies: [],
      };
      const parent = p.replyTo ? views.find((v) => v.id === p.replyTo) : undefined;
      if (parent) parent.replies.push(view);
      else views.push(view);
    }
    return views;
  }

  /** Turns a comment into a view: decrypt + verify encrypted ones, badge plain ones. */
  private toView(session: Session, channel: Channel, c: CommentNode, parentId: string, seenMids: Set<string>): MessageView | undefined {
    const viewer = session.client.repo.viewerLogin.toLowerCase();
    const own = c.author.login.toLowerCase() === viewer;
    const view: MessageView = {
      id: c.id,
      author: c.author,
      createdAt: c.createdAt,
      html: c.bodyHTML,
      status: channel.privacy === "private" ? "unencrypted" : "plain",
      edited: Boolean(c.lastEditedAt),
      modifiedBy: c.editor && c.editor.toLowerCase() !== c.author.login.toLowerCase() ? c.editor : undefined,
      reactions: c.reactions.map((r) => ({ content: r.content, emoji: REACTIONS[r.content] ?? r.content, count: r.count, viewerHasReacted: r.viewerHasReacted })),
      canEdit: c.viewerCanUpdate && own,
      canDelete: c.viewerCanDelete,
      url: c.url,
      replies: [],
    };
    if (c.isMinimized) {
      view.html = '<p class="muted">Hidden by a moderator.</p>';
    } else if (isEncryptedBody(c.body)) {
      const res = decryptMessage(c.body, { repoNodeId: session.client.repo.nodeId, channelNodeId: channel.discussion.id, authorLogin: c.author.login, parentId });
      if (res.ok) {
        if (seenMids.has(res.header.mid)) return undefined; // same message posted twice: show it once
        seenMids.add(res.header.mid);
        const max = session.store.maxRev.get(res.header.mid) ?? 0;
        if (res.header.rev < max) {
          view.status = "invalid";
          view.statusDetail = "An older revision of this message was restored (possible replay).";
          view.html = undecryptableHtml("Replayed revision hidden.");
        } else {
          session.store.maxRev.set(res.header.mid, res.header.rev);
          view.status = "verified";
          view.html = renderMarkdown(res.plaintext.text);
          if (own) view.editableText = res.plaintext.text;
        }
      } else {
        view.status = "invalid";
        view.statusDetail = "The message couldn't be decrypted (tampered or moved).";
        view.html = undecryptableHtml("Couldn't decrypt this message.");
      }
    } else if (own && !c.isMinimized) {
      view.editableText = c.body;
    }
    for (const r of c.replies) {
      const rv = this.toView(session, channel, r, c.id, seenMids);
      if (rv) view.replies.push(rv);
    }
    return view;
  }

  private async notifyNew(session: Session, channel: Channel): Promise<void> {
    const mode = vscode.workspace.getConfiguration("localdesktop").get<string>("chat.notify", "mentions");
    const { store } = session;
    const nodes = (store.comments.get(channel.discussion.id)?.nodes ?? []).flatMap((n) => [n, ...n.replies]);
    const newest = nodes.reduce((m, n) => (n.createdAt > m ? n.createdAt : m), "");
    const last = store.lastNotified(channel.discussion.id);
    if (!newest) return;
    await store.setNotified(channel.discussion.id, newest);
    if (mode === "none" || !last) return; // first load: don't flood
    const viewer = session.client.repo.viewerLogin.toLowerCase();
    const fresh = nodes.filter((n) => n.createdAt > last && n.author.login.toLowerCase() !== viewer);
    if (!fresh.length) return;
    if (this.anyVisible && this.state.activeChannel === channel.discussion.id && vscode.window.state.focused) return;
    for (const n of fresh.slice(-3)) {
      let text = n.body;
      if (isEncryptedBody(n.body)) {
        const res = decryptMessage(n.body, { repoNodeId: session.client.repo.nodeId, channelNodeId: channel.discussion.id, authorLogin: n.author.login, parentId: n.replyToId ?? "" });
        text = res.ok ? res.plaintext.text : "🔒 encrypted message";
      }
      const mentioned = extractMentions(text).includes(viewer);
      if (mode === "mentions" && !mentioned) continue;
      const snippet = text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
      void vscode.window.showInformationMessage(`@${n.author.login} in ${channel.discussion.title}: ${snippet}`, "Open Chat").then(async (choice) => {
        if (!choice) return;
        this.publish({ activeChannel: channel.discussion.id });
        await vscode.commands.executeCommand("localdesktop.chat.focus");
        void this.refresh({ scope: `chat:${channel.discussion.number}`, source: "manual" });
      });
    }
  }

  // ---------- webview actions ----------

  async handle(msg: WebviewToHost): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          for (const v of this.surfaces) v.post({ type: "state", state: this.state });
          return;
        case "selectChannel": {
          this.publish({ activeChannel: msg.channelId, messages: [], loading: true });
          await this.session?.store.setActiveChannel(msg.channelId);
          await this.refresh({ scope: "all", source: "manual" });
          return;
        }
        case "markRead": {
          const ch = this.activeChannel();
          if (ch && this.session) {
            await this.session.store.markSeen(ch.discussion.id, ch.discussion.commentCount);
            this.publish({ channels: this.session.store.channels.map((c) => this.channelView(this.session!.store, c)) });
          }
          return;
        }
        case "send":
          return await this.send(msg.text, msg.replyTo, msg.notify, msg.localId);
        case "retry": {
          const p = this.session?.store.pending.find((x) => x.localId === msg.localId);
          if (p) {
            this.session!.store.pending = this.session!.store.pending.filter((x) => x !== p);
            await this.send(p.text, p.replyTo, p.notify, p.localId);
          }
          return;
        }
        case "loadOlder":
          return await this.loadOlder();
        case "react":
          await this.requireSession().api.react(msg.commentId, msg.content, msg.remove);
          return await this.refresh({ scope: `chat:${this.activeChannel()?.discussion.number ?? 0}`, source: "manual" });
        case "edit":
          return await this.edit(msg.commentId, msg.text);
        case "delete": {
          const ok = await vscode.window.showWarningMessage("Delete this message for everyone?", { modal: true }, "Delete");
          if (!ok) return;
          await this.requireSession().api.deleteComment(msg.commentId);
          return await this.refresh({ scope: `chat:${this.activeChannel()?.discussion.number ?? 0}`, source: "manual" });
        }
        case "openLink": {
          const uri = vscode.Uri.parse(msg.href, true);
          if (["http", "https", "mailto"].includes(uri.scheme)) await vscode.env.openExternal(uri);
          return;
        }
        case "command":
          return await this.command(msg.command);
      }
    } catch (e) {
      if (e instanceof LdError && e.code === "CANCELLED") return;
      void vscode.window.showErrorMessage(`Chat: ${errorMessage(e)}`);
    }
  }

  private requireSession(): Session {
    if (!this.session) throw new LdError("COMMAND_FAILED", "Sign in with GitHub to use the chat.");
    return this.session;
  }

  private activeChannel(): Channel | undefined {
    return this.session?.store.channels.find((c) => c.discussion.id === this.state.activeChannel);
  }

  private async send(text: string, replyTo: string | undefined, notify: boolean, localId: string): Promise<void> {
    const session = this.requireSession();
    const channel = this.activeChannel();
    if (!channel || !text.trim()) return;
    let body = text;
    if (channel.privacy === "private") {
      body = encryptMessage({
        text,
        repoNodeId: session.client.repo.nodeId,
        channelNodeId: channel.discussion.id,
        authorLogin: session.client.repo.viewerLogin,
        parentId: replyTo ?? "",
        cc: notify ? extractMentions(text) : [],
      }).body;
    }
    const pending = { localId, channelId: channel.discussion.id, text, replyTo, notify, status: "pending" as const, createdAt: new Date().toISOString() };
    session.store.pending.push(pending);
    this.publish({ messages: this.messagesFor(session, channel) });
    try {
      await session.api.addComment(channel.discussion.id, body, replyTo);
      session.store.pending = session.store.pending.filter((p) => p.localId !== localId);
      await this.refresh({ scope: `chat:${channel.discussion.number}`, source: "manual" });
    } catch (e) {
      const p = session.store.pending.find((x) => x.localId === localId);
      if (p) Object.assign(p, { status: "failed", error: errorMessage(e) });
      this.publish({ messages: this.messagesFor(session, channel) });
    }
  }

  private async edit(commentId: string, text: string): Promise<void> {
    const session = this.requireSession();
    const channel = this.activeChannel();
    if (!channel) return;
    const all = (session.store.comments.get(channel.discussion.id)?.nodes ?? []).flatMap((n) => [n, ...n.replies.map((r) => ({ ...r, replyToId: n.id }))]);
    const node = all.find((n) => n.id === commentId);
    if (!node) return;
    let body = text;
    if (isEncryptedBody(node.body)) {
      const parentId = node.replyToId ?? "";
      const res = decryptMessage(node.body, { repoNodeId: session.client.repo.nodeId, channelNodeId: channel.discussion.id, authorLogin: node.author.login, parentId });
      if (!res.ok) throw new LdError("COMMAND_FAILED", "That message couldn't be decrypted, so it can't be edited.");
      body = encryptMessage({
        text,
        repoNodeId: session.client.repo.nodeId,
        channelNodeId: channel.discussion.id,
        authorLogin: session.client.repo.viewerLogin,
        parentId,
        mid: res.header.mid,
        rev: res.header.rev + 1,
      }).body;
    } else {
      const ok = await vscode.window.showWarningMessage(
        "GitHub keeps earlier versions of edited comments in a public edit history. To remove text sent by mistake, delete the message instead.",
        "Edit Anyway",
      );
      if (!ok) return;
    }
    await session.api.updateComment(commentId, body);
    await this.refresh({ scope: `chat:${channel.discussion.number}`, source: "manual" });
  }

  private async loadOlder(): Promise<void> {
    const session = this.requireSession();
    const channel = this.activeChannel();
    const cached = channel && session.store.comments.get(channel.discussion.id);
    if (!channel || !cached?.olderCursor) return;
    session.store.addOlder(channel.discussion.id, await session.api.comments(channel.discussion.id, cached.olderCursor));
    this.publish({ messages: this.messagesFor(session, channel), hasOlder: Boolean(session.store.comments.get(channel.discussion.id)?.olderCursor) });
  }

  async command(command: string): Promise<void> {
    switch (command) {
      case "newChannel":
        return this.newChannel();
      case "setPrivacy":
        return this.setPrivacy();
      case "openOnGitHub": {
        const url = this.activeChannel()?.discussion.url;
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      case "signIn":
        await this.s.upstream.client();
        return;
      case "setup":
        await vscode.commands.executeCommand("localdesktop.chat.setup");
        return;
      case "refresh":
        return this.refresh({ scope: "all", source: "manual" });
    }
  }

  private async newChannel(): Promise<void> {
    const session = this.requireSession();
    if (!atLeast(session.client.repo.viewerPermission, "MAINTAIN")) throw new LdError("COMMAND_FAILED", "Only maintainers can create channels.");
    if (!session.category) throw new LdError("COMMAND_FAILED", "The chat isn't set up yet.");
    const name = await vscode.window.showInputBox({
      title: "New channel",
      prompt: "Channel name",
      placeHolder: "releases",
      validateInput: (v) => (/^#?[\w-]{1,40}$/.test(v.trim()) ? undefined : "Letters, digits, - and _ only"),
    });
    if (!name) return;
    const privacy = await pickPrivacy();
    if (!privacy) return;
    const d = await session.api.createDiscussion(session.category.id, `#${name.trim().replace(/^#/, "")}`, channelBody(privacy));
    await session.api.setSubscribed(d.id, false).catch(() => undefined);
    this.publish({ activeChannel: d.id });
    await session.store.setActiveChannel(d.id);
    await this.refresh({ scope: "all", source: "manual" });
  }

  private async setPrivacy(): Promise<void> {
    const session = this.requireSession();
    const channel = this.activeChannel();
    if (!channel) return;
    const privacy = await pickPrivacy(channel.privacy);
    if (!privacy || privacy === channel.privacy) return;
    if (privacy === "public") {
      const ok = await vscode.window.showWarningMessage(
        `New messages in ${channel.discussion.title} will be readable by everyone. Existing encrypted messages stay encrypted.`,
        { modal: true },
        "Make Public",
      );
      if (!ok) return;
    }
    await session.api.updateDiscussionBody(channel.discussion.id, withPrivacy(channel.discussion.body, privacy));
    await this.refresh({ scope: "all", source: "manual" });
  }

  /** For the setup flow: reset and reload everything. */
  async reload(): Promise<void> {
    this.session = undefined;
    await this.refresh({ scope: "all", source: "manual" });
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
    this.badgeEmitter.dispose();
  }
}

async function pickPrivacy(current?: Privacy): Promise<Privacy | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "🔒 Private", description: current === "private" ? "current" : undefined, detail: "Encrypted on GitHub; readable with the Local Desktop extension.", value: "private" as const },
      { label: "🌐 Public", description: current === "public" ? "current" : undefined, detail: "Plain GitHub Discussions comments, readable by everyone.", value: "public" as const },
    ],
    { title: "Channel privacy" },
  );
  return pick?.value;
}

function emptyState(): ChatState {
  return {
    signedIn: false,
    setup: "loading",
    canWrite: false,
    canMaintain: false,
    isAdmin: false,
    channels: [],
    messages: [],
    hasOlder: false,
    loading: true,
    ccDefault: false,
  };
}
