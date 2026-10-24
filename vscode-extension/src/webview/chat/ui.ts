import type { DOMPurify } from "dompurify";
import { REACTIONS, type ChatState, type HostToWebview, type MessageView, type WebviewCommand, type WebviewToHost } from "../../shared/messages";

/**
 * Chat renderer. Pure view: no network and no crypto — it draws the ChatState the host sends and
 * posts user intents back. Every HTML string goes through DOMPurify before it touches the DOM.
 */

/** Per-webview UI state that survives reloads (vscode.setState). */
export interface LocalState {
  draft: string;
  replyTo?: string;
  notify?: boolean;
}

export interface ChatUiOptions {
  post(message: WebviewToHost): void;
  purify: DOMPurify;
  initial?: unknown;
  save?(state: LocalState): void;
}

const IMG_HOSTS = /^https:\/\/(avatars\.githubusercontent\.com|camo\.githubusercontent\.com|github\.com|[a-z0-9-]+\.githubusercontent\.com)\//i;
const LINK_SCHEMES = /^(https?:|mailto:)/i;
let hooked = new WeakSet<DOMPurify>();

/** Sanitizes host HTML: no scripts/handlers/styles/forms, links only http(s)/mailto, images only from GitHub. */
export function sanitizeHtml(purify: DOMPurify, html: string): string {
  if (!hooked.has(purify)) {
    purify.addHook("afterSanitizeAttributes", (node) => {
      const el = node as Element;
      if (el.tagName === "A") {
        const href = el.getAttribute("href") ?? "";
        if (!LINK_SCHEMES.test(href)) el.removeAttribute("href");
        el.removeAttribute("target");
        el.setAttribute("rel", "noreferrer noopener");
      }
      if (el.tagName === "IMG") {
        const src = el.getAttribute("src") ?? "";
        if (!IMG_HOSTS.test(src) && !/^data:image\/(png|gif|jpeg|webp);/i.test(src)) el.removeAttribute("src");
        el.removeAttribute("srcset");
      }
    });
    hooked.add(purify);
  }
  return purify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "svg", "math", "video", "audio", "source"],
    FORBID_ATTR: ["style", "srcset", "formaction"],
    ALLOW_DATA_ATTR: false,
  });
}

/** Test hook: forget hook registrations (each happy-dom window gets a fresh purifier). */
export function resetSanitizerHooks(): void {
  hooked = new WeakSet();
}

type Child = Node | string | false | null | undefined;

function h(doc: Document, tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) {
    if (c === false || c === null || c === undefined) continue;
    el.append(typeof c === "string" ? doc.createTextNode(c) : c);
  }
  return el;
}

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (key(d) === key(now)) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (key(d) === key(y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const BADGES: Partial<Record<MessageView["status"], { text: string; cls: string; title: string }>> = {
  verified: { text: "🔒", cls: "badge ok", title: "Encrypted on GitHub" },
  unencrypted: { text: "⚠ Unencrypted, visible to everyone", cls: "badge warn", title: "Posted without encryption (e.g. from github.com)" },
  invalid: { text: "⛔ Invalid", cls: "badge error", title: "Failed verification" },
  pending: { text: "Sending…", cls: "badge muted", title: "" },
  failed: { text: "Not sent", cls: "badge error", title: "" },
};

export interface ChatUi {
  receive(message: HostToWebview): void;
  readonly state: ChatState | undefined;
}

export function createChatUi(root: HTMLElement, opts: ChatUiOptions): ChatUi {
  const doc = root.ownerDocument;
  const initial = (opts.initial ?? {}) as Partial<LocalState>;
  const local: LocalState = { draft: typeof initial.draft === "string" ? initial.draft : "", replyTo: initial.replyTo, notify: initial.notify };
  let state: ChatState | undefined;
  let editing: { id: string; text: string } | undefined;
  let reacting: string | undefined;
  let menuOpen = false;
  let seq = 0;

  const save = () => opts.save?.({ ...local });
  const post = (m: WebviewToHost) => opts.post(m);
  const command = (c: WebviewCommand) => post({ type: "command", command: c });

  root.textContent = "";
  root.classList.add("app");
  const header = h(doc, "header", { class: "header" });
  const banners = h(doc, "div", { class: "banners" });
  const timeline = h(doc, "main", { class: "timeline", "aria-live": "polite" });
  const composer = h(doc, "footer", { class: "composer" });
  root.append(header, banners, timeline, composer);

  // ----- composer (created once so typing isn't interrupted by re-renders) -----
  const replyBar = h(doc, "div", { class: "reply-bar", hidden: true });
  const input = h(doc, "textarea", { class: "input", rows: "2", "aria-label": "Message" }) as HTMLTextAreaElement;
  input.value = local.draft;
  const sendButton = h(doc, "button", { class: "send", title: "Send (Enter)" }, "Send") as HTMLButtonElement;
  const notifyBox = h(doc, "input", { type: "checkbox", class: "notify" }) as HTMLInputElement;
  const notifyLabel = h(doc, "label", { class: "notify-label", title: "Adds a plain-text “cc @user” line so GitHub notifies the people you mention (reveals who was mentioned, not the message)" }, notifyBox, " Notify on GitHub");
  const encLine = h(doc, "span", { class: "enc-line" });
  composer.append(replyBar, h(doc, "div", { class: "row" }, input, sendButton), h(doc, "div", { class: "meta" }, encLine, notifyLabel));

  const send = () => {
    const text = input.value;
    if (!text.trim() || !state?.canWrite) return;
    const localId = `local-${Date.now()}-${++seq}`;
    post({ type: "send", text, localId, replyTo: local.replyTo, notify: notifyBox.checked });
    input.value = "";
    local.draft = "";
    local.replyTo = undefined;
    save();
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    local.draft = input.value;
    save();
  });
  sendButton.addEventListener("click", send);
  notifyBox.addEventListener("change", () => {
    local.notify = notifyBox.checked;
    save();
  });

  // ----- event delegation for everything rendered -----
  root.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (!target) return;
    const link = target.closest("a[href]");
    if (link && !link.closest("[data-action]")) {
      e.preventDefault();
      post({ type: "openLink", href: link.getAttribute("href")! });
      return;
    }
    const actionEl = target.closest("[data-action]") as HTMLElement | null;
    if (!actionEl) {
      if (menuOpen && !target.closest(".menu")) {
        menuOpen = false;
        render();
      }
      return;
    }
    e.preventDefault();
    const a = actionEl.dataset;
    switch (a.action) {
      case "channel":
        menuOpen = false;
        post({ type: "selectChannel", channelId: a.id! });
        break;
      case "command":
        menuOpen = false;
        command(a.command as WebviewCommand);
        break;
      case "menu":
        menuOpen = !menuOpen;
        render();
        break;
      case "older":
        post({ type: "loadOlder" });
        break;
      case "reply":
        local.replyTo = a.id;
        save();
        render();
        input.focus();
        break;
      case "cancel-reply":
        local.replyTo = undefined;
        save();
        render();
        break;
      case "react-open":
        reacting = reacting === a.id ? undefined : a.id;
        render();
        break;
      case "react":
        reacting = undefined;
        post({ type: "react", commentId: a.id!, content: a.content!, remove: a.remove === "true" });
        break;
      case "edit": {
        const m = findMessage(a.id!);
        if (m?.editableText !== undefined) editing = { id: m.id, text: m.editableText };
        render();
        break;
      }
      case "edit-save": {
        const box = root.querySelector<HTMLTextAreaElement>(".edit-box");
        if (editing && box) post({ type: "edit", commentId: editing.id, text: box.value });
        editing = undefined;
        render();
        break;
      }
      case "edit-cancel":
        editing = undefined;
        render();
        break;
      case "delete":
        post({ type: "delete", commentId: a.id! });
        break;
      case "retry":
        post({ type: "retry", localId: a.id! });
        break;
      case "open":
        post({ type: "openLink", href: a.href! });
        break;
    }
  });
  root.addEventListener("keydown", (e) => {
    const t = e.target as Element | null;
    if (!t?.classList.contains("edit-box")) return;
    if (e.key === "Escape") {
      editing = undefined;
      render();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      (root.querySelector('[data-action="edit-save"]') as HTMLElement | null)?.click();
    }
  });

  function findMessage(id: string): MessageView | undefined {
    for (const m of state?.messages ?? []) {
      if (m.id === id) return m;
      const r = m.replies.find((x) => x.id === id);
      if (r) return r;
    }
    return undefined;
  }

  const clean = (html: string) => sanitizeHtml(opts.purify, html);

  function renderHeader(s: ChatState): void {
    header.textContent = "";
    if (!s.signedIn || s.setup !== "ready") return;
    const tabs = h(doc, "nav", { class: "channels", role: "tablist" });
    for (const c of s.channels) {
      const active = c.id === s.activeChannel;
      tabs.append(
        h(
          doc,
          "button",
          { class: `channel${active ? " active" : ""}`, role: "tab", "aria-selected": active ? "true" : "false", "data-action": "channel", "data-id": c.id, title: c.privacy === "private" ? "Private: end-to-end encrypted" : "Public: visible to everyone" },
          `${c.privacy === "private" ? "🔒" : "🌐"} ${c.title}`,
          c.unread > 0 && !active ? h(doc, "span", { class: "unread" }, String(c.unread)) : undefined,
        ),
      );
    }
    const tools = h(doc, "div", { class: "tools" });
    if (s.canMaintain) tools.append(h(doc, "button", { class: "icon", title: "New channel", "data-action": "command", "data-command": "newChannel" }, "+"));
    tools.append(h(doc, "button", { class: "icon", title: "More", "aria-haspopup": "menu", "data-action": "menu" }, "⋯"));
    header.append(tabs, tools);
    if (menuOpen) {
      const item = (cmd: WebviewCommand, label: string) => h(doc, "button", { class: "menu-item", role: "menuitem", "data-action": "command", "data-command": cmd }, label);
      header.append(
        h(
          doc,
          "div",
          { class: "menu", role: "menu" },
          s.canMaintain && item("setPrivacy", "Channel privacy…"),
          item("openOnGitHub", "Open channel on GitHub"),
          item("refresh", "Refresh"),
        ),
      );
    }
  }

  function renderBanners(s: ChatState): void {
    banners.textContent = "";
    const banner = (cls: string, ...children: Child[]) => banners.append(h(doc, "div", { class: `banner ${cls}` }, ...children));
    if (s.error) banner("error", `⚠ ${s.error} `, h(doc, "button", { class: "link", "data-action": "command", "data-command": "refresh" }, "Retry"));
    const channel = s.channels.find((c) => c.id === s.activeChannel);
    if (channel?.privacyWarning) banner("warn", `⚠ ${channel.privacyWarning}`);
  }

  function renderMessage(m: MessageView, s: ChatState, isReply: boolean): HTMLElement {
    const badge = BADGES[m.status];
    const actions = h(doc, "div", { class: "actions" });
    if (m.status !== "pending" && m.status !== "failed") {
      if (!isReply && s.canWrite) actions.append(h(doc, "button", { class: "icon", title: "Reply", "data-action": "reply", "data-id": m.id }, "↩"));
      actions.append(h(doc, "button", { class: "icon", title: "React", "data-action": "react-open", "data-id": m.id }, "☺"));
      if (m.canEdit && m.editableText !== undefined) actions.append(h(doc, "button", { class: "icon", title: "Edit", "data-action": "edit", "data-id": m.id }, "✎"));
      if (m.canDelete) actions.append(h(doc, "button", { class: "icon", title: "Delete", "data-action": "delete", "data-id": m.id }, "🗑"));
      if (m.url) actions.append(h(doc, "button", { class: "icon", title: "Open on GitHub", "data-action": "open", "data-href": m.url }, "↗"));
    }
    const avatar = m.author.avatarUrl && IMG_HOSTS.test(m.author.avatarUrl) ? h(doc, "img", { class: "avatar", src: m.author.avatarUrl, alt: "" }) : h(doc, "span", { class: "avatar placeholder" }, m.author.login.charAt(0).toUpperCase());
    const meta = h(
      doc,
      "div",
      { class: "msg-meta" },
      h(doc, "strong", { class: "author" }, m.author.login),
      h(doc, "time", { datetime: m.createdAt, title: new Date(m.createdAt).toLocaleString() }, timeLabel(m.createdAt)),
      badge && h(doc, "span", { class: badge.cls, title: m.statusDetail ?? badge.title }, badge.text),
      m.edited && h(doc, "span", { class: "badge muted" }, "edited"),
      m.modifiedBy && h(doc, "span", { class: "badge warn", title: "Edited by someone other than the author" }, `⚠ modified by @${m.modifiedBy}`),
      m.status === "failed" && h(doc, "button", { class: "link", "data-action": "retry", "data-id": m.localId ?? m.id }, "Retry"),
      actions,
    );
    let body: HTMLElement;
    if (editing?.id === m.id) {
      const box = h(doc, "textarea", { class: "edit-box", rows: "3" }) as HTMLTextAreaElement;
      box.value = editing.text;
      body = h(
        doc,
        "div",
        { class: "body editing" },
        box,
        h(doc, "div", { class: "edit-actions" }, h(doc, "button", { "data-action": "edit-save" }, "Save"), h(doc, "button", { class: "secondary", "data-action": "edit-cancel" }, "Cancel")),
      );
    } else {
      body = h(doc, "div", { class: "body" });
      body.innerHTML = clean(m.html);
    }
    const reactions = h(doc, "div", { class: "reactions" });
    for (const r of m.reactions) {
      reactions.append(
        h(doc, "button", { class: `reaction${r.viewerHasReacted ? " mine" : ""}`, "data-action": "react", "data-id": m.id, "data-content": r.content, "data-remove": String(r.viewerHasReacted) }, `${r.emoji} ${r.count}`),
      );
    }
    if (reacting === m.id) {
      const picker = h(doc, "div", { class: "picker" });
      for (const [content, emoji] of Object.entries(REACTIONS)) {
        const mine = m.reactions.some((r) => r.content === content && r.viewerHasReacted);
        picker.append(h(doc, "button", { class: "icon", "data-action": "react", "data-id": m.id, "data-content": content, "data-remove": String(mine) }, emoji));
      }
      reactions.append(picker);
    }
    const replies = m.replies.length ? h(doc, "div", { class: "replies" }, ...m.replies.map((r) => renderMessage(r, s, true))) : undefined;
    return h(doc, "article", { class: `msg status-${m.status}${isReply ? " reply" : ""}`, "data-id": m.id }, avatar, h(doc, "div", { class: "msg-main" }, meta, body, reactions.childNodes.length ? reactions : undefined, replies));
  }

  function renderTimeline(s: ChatState): void {
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
    const prevTop = timeline.scrollTop;
    timeline.textContent = "";
    if (!s.signedIn) {
      timeline.append(h(doc, "div", { class: "empty" }, h(doc, "p", {}, "Sign in with GitHub to chat with the other maintainers."), h(doc, "button", { "data-action": "command", "data-command": "signIn" }, "Sign in with GitHub")));
      return;
    }
    if (s.setup === "loading" || (s.loading && !s.messages.length && s.setup === "ready" && !s.channels.length)) {
      timeline.append(h(doc, "p", { class: "muted center" }, "Loading chat…"));
      return;
    }
    if (s.setup !== "ready") {
      const why = {
        noDiscussions: "GitHub Discussions are turned off for this repository.",
        noCategory: "The Chat discussion category doesn't exist yet.",
        noChannels: "There are no chat channels yet.",
      }[s.setup];
      timeline.append(
        h(
          doc,
          "div",
          { class: "empty" },
          h(doc, "p", {}, why),
          s.isAdmin
            ? h(doc, "button", { "data-action": "command", "data-command": "setup" }, "Set up the maintainer chat")
            : h(doc, "p", { class: "muted" }, "Ask a repository admin to run “Local Desktop: Set Up Maintainer Chat”."),
        ),
      );
      return;
    }
    if (s.hasOlder) timeline.append(h(doc, "button", { class: "older link", "data-action": "older" }, "Load older messages"));
    if (!s.messages.length && !s.loading) timeline.append(h(doc, "p", { class: "muted center" }, "No messages yet. Say hi 👋"));
    let lastDay = "";
    for (const m of s.messages) {
      const day = dayLabel(m.createdAt);
      if (day !== lastDay) {
        timeline.append(h(doc, "div", { class: "day", role: "separator" }, h(doc, "span", {}, day)));
        lastDay = day;
      }
      timeline.append(renderMessage(m, s, false));
    }
    timeline.scrollTop = atBottom ? timeline.scrollHeight : prevTop;
  }

  function renderComposer(s: ChatState): void {
    const channel = s.channels.find((c) => c.id === s.activeChannel);
    const usable = s.signedIn && s.setup === "ready" && Boolean(channel);
    composer.hidden = !usable;
    if (!usable || !channel) return;
    const canSend = s.canWrite;
    input.disabled = !canSend;
    sendButton.disabled = !canSend;
    input.placeholder = canSend ? `Message ${channel.title} (Enter to send, Shift+Enter for a new line)` : "You need write access to post here";
    const reply = local.replyTo ? findMessage(local.replyTo) : undefined;
    replyBar.hidden = !reply;
    replyBar.textContent = "";
    if (reply) replyBar.append(`↩ Replying to @${reply.author.login} `, h(doc, "button", { class: "link", "data-action": "cancel-reply" }, "Cancel"));
    if (channel.privacy === "private") {
      encLine.textContent = "🔒 Encrypted on GitHub";
      encLine.className = "enc-line ok";
      notifyLabel.hidden = false;
      notifyBox.checked = local.notify ?? s.ccDefault;
    } else {
      encLine.textContent = "🌐 Public channel, visible to everyone";
      encLine.className = "enc-line";
      notifyLabel.hidden = true;
    }
  }

  function render(): void {
    if (!state) return;
    renderHeader(state);
    renderBanners(state);
    renderTimeline(state);
    renderComposer(state);
  }

  return {
    receive(message: HostToWebview) {
      if (!message || typeof message !== "object") return;
      if (message.type === "state") {
        const changedChannel = state?.activeChannel !== message.state.activeChannel;
        state = message.state;
        if (changedChannel) {
          editing = undefined;
          reacting = undefined;
          if (local.replyTo && !findMessage(local.replyTo)) local.replyTo = undefined;
        }
        render();
      } else if (message.type === "focusComposer") {
        input.focus();
      }
    },
    get state() {
      return state;
    },
  };
}
