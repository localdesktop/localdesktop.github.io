import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import { parseWebviewMessage, type ChatState, type MessageView, type WebviewToHost } from "../../src/shared/messages";
import { createChatUi, dayLabel, resetSanitizerHooks, sanitizeHtml } from "../../src/webview/chat/ui";

// jsdom rather than happy-dom: DOMPurify mis-sanitizes under happy-dom 21 (keeps on* handlers and
// style attributes), which would make these security tests meaningless.
function setup() {
  const window = new JSDOM("<!doctype html><html><body></body></html>").window;
  const document = window.document;
  const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  const root = document.createElement("div");
  document.body.append(root);
  const posted: WebviewToHost[] = [];
  const ui = createChatUi(root, { post: (m) => posted.push(m), purify });
  return { window, document, purify, root, posted, ui };
}

function message(over: Partial<MessageView> = {}): MessageView {
  return {
    id: "DC_1",
    author: { login: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
    createdAt: new Date().toISOString(),
    html: "<p>hello</p>",
    status: "verified",
    edited: false,
    reactions: [],
    canEdit: false,
    canDelete: false,
    replies: [],
    ...over,
  };
}

function state(over: Partial<ChatState> = {}): ChatState {
  return {
    signedIn: true,
    setup: "ready",
    viewer: "bob",
    canWrite: true,
    canMaintain: false,
    isAdmin: false,
    channels: [
      { id: "D_1", number: 1, title: "#general", privacy: "private", unread: 0, url: "https://github.com/x/y/discussions/1" },
      { id: "D_2", number: 2, title: "#public", privacy: "public", unread: 3, url: "https://github.com/x/y/discussions/2" },
    ],
    activeChannel: "D_1",
    messages: [message()],
    hasOlder: false,
    loading: false,
    encryption: { status: "ready", recipients: 3, devices: 5 },
    ccDefault: false,
    ...over,
  };
}

beforeEach(() => resetSanitizerHooks());

describe("sanitizeHtml", () => {
  it("removes javascript: links, event handlers and scripts", () => {
    const { purify } = setup();
    const out = sanitizeHtml(purify, `<a href="javascript:alert(1)">x</a><img src="https://evil.example/x.png" onerror="alert(1)"><script>alert(1)</script><p onclick="x()">ok</p>`);
    expect(out).not.toMatch(/javascript:|onerror|onclick|<script/i);
    expect(out).toContain("<p>ok</p>");
    expect(out).not.toContain("evil.example");
  });

  it("keeps safe links and GitHub images, drops styles and forms", () => {
    const { purify } = setup();
    const out = sanitizeHtml(purify, `<a href="https://github.com" target="_blank">gh</a><img src="https://avatars.githubusercontent.com/u/1"><p style="color:red">s</p><form><input></form>`);
    expect(out).toContain('href="https://github.com"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).not.toContain("target=");
    expect(out).toContain("avatars.githubusercontent.com");
    expect(out).not.toMatch(/style=|<form|<input/);
  });
});

describe("chat webview", () => {
  it("renders channels, badges and the encryption line from a state message", () => {
    const { root, ui } = setup();
    ui.receive({
      type: "state",
      state: state({
        messages: [
          message({ id: "a", html: "<p>secret</p>" }),
          message({ id: "b", status: "unencrypted", html: "<p>plain</p>" }),
          message({ id: "c", status: "invalid", html: '<p class="muted">bad</p>', modifiedBy: "mallory", edited: true }),
        ],
      }),
    });
    const tabs = [...root.querySelectorAll(".channel")].map((t) => t.textContent);
    expect(tabs).toEqual(["🔒 #general", "🌐 #public3"]);
    const text = root.textContent!;
    expect(text).toContain("Unencrypted — visible to everyone");
    expect(text).toContain("⛔ Invalid");
    expect(text).toContain("modified by @mallory");
    expect(text).toContain("edited");
    expect(text).toContain("Encrypted for 3 maintainers / 5 devices");
    expect(root.querySelector(".day")?.textContent).toBe("Today");
  });

  it("sanitizes message HTML from the host", () => {
    const { root, ui } = setup();
    ui.receive({ type: "state", state: state({ messages: [message({ html: '<img src=x onerror="alert(1)"><a href="javascript:alert(2)">x</a>' })] }) });
    const body = root.querySelector(".body")!.innerHTML;
    expect(body).not.toMatch(/onerror|javascript:/);
  });

  it("posts intents: channel switch, send on Enter, link clicks, reactions", () => {
    const { root, ui, posted, window } = setup();
    ui.receive({ type: "state", state: state({ messages: [message({ html: '<p><a href="https://example.com/x">link</a></p>', reactions: [{ content: "HEART", emoji: "❤️", count: 2, viewerHasReacted: true }] })] }) });

    (root.querySelectorAll(".channel")[1] as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "selectChannel", channelId: "D_2" });

    (root.querySelector(".body a") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "openLink", href: "https://example.com/x" });

    (root.querySelector(".reaction") as HTMLElement).click();
    expect(posted.at(-1)).toEqual({ type: "react", commentId: "DC_1", content: "HEART", remove: true });

    const input = root.querySelector("textarea.input") as HTMLTextAreaElement;
    input.value = "hi @alice";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true }) as unknown as Event);
    expect(posted.some((m) => m.type === "send")).toBe(false);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event);
    const send = posted.at(-1)!;
    expect(send).toMatchObject({ type: "send", text: "hi @alice", notify: false });
    expect(input.value).toBe("");
    // Whatever the webview posts must survive the host's validation.
    for (const m of posted) expect(parseWebviewMessage(JSON.parse(JSON.stringify(m)))).toEqual(JSON.parse(JSON.stringify(m)));
  });

  it("shows setup and sign-in states", () => {
    const { root, ui } = setup();
    ui.receive({ type: "state", state: state({ signedIn: false, channels: [], messages: [] }) });
    expect(root.textContent).toContain("Sign in with GitHub");
    ui.receive({ type: "state", state: state({ setup: "noCategory", isAdmin: true, channels: [], messages: [] }) });
    expect(root.querySelector('[data-command="setup"]')).not.toBeNull();
    ui.receive({ type: "state", state: state({ setup: "noDiscussions", isAdmin: false, channels: [], messages: [] }) });
    expect(root.textContent).toContain("Ask a repository admin");
  });

  it("shows the waiting banner and an unencrypted warning when the device has no key", () => {
    const { root, ui } = setup();
    ui.receive({ type: "state", state: state({ encryption: { status: "waiting", recipients: 2, devices: 2, fingerprint: "aaaa bbbb" } }) });
    expect(root.textContent).toContain("Waiting for a maintainer to share the chat key");
    expect(root.textContent).toContain("aaaa bbbb");
    expect(root.querySelector(".enc-line")!.textContent).toContain("can't encrypt yet");
  });
});

describe("host message validation", () => {
  it("rejects malformed or unknown messages", () => {
    expect(parseWebviewMessage({ type: "openLink" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "command", command: "rm -rf" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "react", commentId: "x", content: "NOPE" })).toBeUndefined();
    expect(parseWebviewMessage("hi")).toBeUndefined();
    expect(parseWebviewMessage({ type: "send", text: "x".repeat(60_001), localId: "l" })).toBeUndefined();
  });
});

describe("dayLabel", () => {
  it("labels today and yesterday", () => {
    const now = new Date(2026, 9, 20, 12);
    expect(dayLabel(new Date(2026, 9, 20, 1).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 19, 23).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 1).toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });
});
