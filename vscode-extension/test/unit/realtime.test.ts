import { describe, expect, it, vi } from "vitest";
import { parseRepoConfig } from "../../src/realtime/config";
import { Doorbell, LineSplitter, nextBackoff, parseNtfyLine, parseSmeeData, scopeFromTag, SpamGuard, SseParser, type DoorbellStatus } from "../../src/realtime/doorbell";
import type { RefreshHint } from "../../src/realtime/hub";
import { Coalescer, PollScheduler, type Clock } from "../../src/realtime/scheduler";
import { hookTargets, ntfyAppLink, ntfyWebhookUrl, randomTopic } from "../../src/realtime/webhook";

class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now() {
    return this.t;
  }
  setTimer(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimer(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

describe("doorbell parsing", () => {
  it.each([
    ["New message in #general [ld:d:12]", { scope: "chat:12" }],
    ["Build APK & AAB completed success [ld:r:12345678901]", { scope: "run:12345678901" }],
    ["Build APK completed [ld:r:1.2345678901e+10]", { scope: "run:12345678901" }],
    ["Release v2.1.1 published [ld:rel:2.3e+08]", { scope: "releases" }],
    ["PR #317 closed [ld:pr:317]", { scope: "pr:317" }],
    ["Collaborator added [ld:m:]", { scope: "members" }],
    ["Ping [ld:ping:5.5e+08]", { ping: "5.5e+08" }],
    ["[ld:x:]", { scope: "all" }],
    ["Run [ld:r:%!f(string=x)]", { scope: "runs" }],
  ])("maps %s", (message, expected) => {
    expect(scopeFromTag(message)).toEqual(expected);
  });

  it("ignores untagged messages and non-message events", () => {
    expect(scopeFromTag("hello")).toBeUndefined();
    expect(parseNtfyLine('{"id":"a","event":"keepalive","time":1}')).toBeUndefined();
    expect(parseNtfyLine('{"id":"a","event":"open"}')).toBeUndefined();
    expect(parseNtfyLine("not json")).toBeUndefined();
    expect(parseNtfyLine('{"id":"abc","event":"message","message":"New message in x [ld:d:3]"}')).toEqual({ scope: "chat:3", id: "abc" });
  });

  it("reads GitHub events relayed by smee", () => {
    expect(parseSmeeData(JSON.stringify({ "x-github-event": "discussion_comment", body: { discussion: { number: 7 } } }))).toEqual({ scope: "chat:7" });
    expect(parseSmeeData(JSON.stringify({ "x-github-event": "workflow_run", body: { workflow_run: { id: 99 } } }))).toEqual({ scope: "run:99" });
    expect(parseSmeeData(JSON.stringify({ "x-github-event": "push", body: {} }))).toBeUndefined();
  });

  it("splits lines and SSE events across chunks", () => {
    const lines = new LineSplitter();
    expect(lines.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(lines.push(":2}\r\n")).toEqual(['{"b":2}']);
    const sse = new SseParser();
    expect(sse.push("event: ping\ndata: {\"x\"")).toEqual([]);
    expect(sse.push(":1}\n\ndata: a\ndata: b\n\n")).toEqual(['{"x":1}', "a\nb"]);
  });
});

describe("SpamGuard", () => {
  it("mutes for 5 minutes after more than 30 pings a minute", () => {
    const g = new SpamGuard();
    for (let i = 0; i < 30; i++) expect(g.allow(i * 100)).toBe(true);
    expect(g.allow(3100)).toBe(false);
    expect(g.muted(3100 + 4 * 60_000)).toBe(true);
    expect(g.allow(3100 + 5 * 60_000 + 1)).toBe(true);
  });

  it("forgets pings older than a minute", () => {
    const g = new SpamGuard();
    for (let i = 0; i < 30; i++) g.allow(0);
    expect(g.allow(61_000)).toBe(true);
  });
});

describe("backoff", () => {
  it("doubles from 1 s up to 60 s", () => {
    let b = 1000;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(b);
      b = nextBackoff(b);
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });
});

describe("Coalescer", () => {
  it("debounces a burst into one hint per scope and rate-limits", () => {
    const clock = new FakeClock();
    const out: RefreshHint[] = [];
    const c = new Coalescer((h) => out.push(h), clock, 750, 3000);
    c.push({ scope: "runs", source: "doorbell" });
    clock.advance(200);
    c.push({ scope: "runs", source: "timer" });
    c.push({ scope: "chat:1", source: "doorbell" });
    clock.advance(800);
    expect(out).toEqual([
      { scope: "runs", source: "doorbell" },
      { scope: "chat:1", source: "doorbell" },
    ]);
    // Another ping right away waits until 3 s after the last emit of that scope.
    c.push({ scope: "runs", source: "doorbell" });
    clock.advance(1000);
    expect(out).toHaveLength(2);
    clock.advance(2500);
    expect(out).toHaveLength(3);
  });
});

describe("PollScheduler", () => {
  it("polls at pollSeconds when not live, slowly when live or hidden, and on focus", () => {
    const clock = new FakeClock();
    const out: RefreshHint[] = [];
    const s = new PollScheduler((h) => out.push(h), { pollMs: () => 60_000, liveMs: 300_000, hiddenMs: 300_000 }, clock);
    s.start();
    clock.advance(60_000);
    expect(out).toEqual([{ scope: "all", source: "timer" }]);
    s.setLive(true);
    clock.advance(120_000);
    expect(out).toHaveLength(1);
    clock.advance(180_000);
    expect(out).toHaveLength(2);
    s.setLive(false);
    s.setFocused(false);
    clock.advance(200_000);
    expect(out).toHaveLength(2);
    s.setFocused(true);
    expect(out.at(-1)).toEqual({ scope: "all", source: "focus" });
    s.stop();
    clock.advance(1_000_000);
    expect(out).toHaveLength(3);
  });

  it("never polls faster than 15 s", () => {
    const clock = new FakeClock();
    const s = new PollScheduler(() => undefined, { pollMs: () => 1000 }, clock);
    expect(s.interval()).toBe(15_000);
  });
});

function streamResponse(chunks: string[], { keepOpen = false } = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!keepOpen) controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("Doorbell", () => {
  it("delivers ntfy hints, resumes with since=<last id> and reconnects with backoff", async () => {
    const urls: string[] = [];
    const statuses: DoorbellStatus[] = [];
    const events: unknown[] = [];
    let reconnects = 0;
    const timers: (() => void)[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return streamResponse(['{"id":"m1","event":"open"}\n{"id":"m2","event":"message","message":"New message [ld:d:4]"}\n']);
      }
      return streamResponse(['{"id":"m3","event":"message","message":"x [ld:rel:1]"}\n'], { keepOpen: true });
    });
    const bell = new Doorbell({
      provider: "ntfy",
      url: "https://ntfy.sh/localdesktop-abc/",
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      onReconnect: () => reconnects++,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    });
    bell.start();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(urls[0]).toBe("https://ntfy.sh/localdesktop-abc/json?since=10m");
    expect(events).toEqual([{ scope: "chat:4", id: "m2" }]);
    timers[0]!();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(urls[1]).toBe("https://ntfy.sh/localdesktop-abc/json?since=m2");
    expect(reconnects).toBe(1);
    expect(statuses).toContain("live");
    bell.stop();
    expect(statuses.at(-1)).toBe("stopped");
  });

  it("goes offline after repeated failures", async () => {
    const statuses: DoorbellStatus[] = [];
    const timers: (() => void)[] = [];
    const bell = new Doorbell({
      provider: "ntfy",
      url: "https://ntfy.sh/t",
      onEvent: () => undefined,
      onStatus: (s) => statuses.push(s),
      onReconnect: () => undefined,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    });
    bell.start();
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(timers.length).toBe(i + 1));
      if (i < 2) timers[i]!();
    }
    expect(statuses).toContain("offline");
    bell.stop();
  });
});

describe("webhook helpers", () => {
  it("builds a templated ntfy URL and recognises it again", () => {
    const topic = "https://ntfy.sh/localdesktop-abcdefghij";
    const url = ntfyWebhookUrl(topic);
    const u = new URL(url);
    expect(u.searchParams.get("template")).toBe("yes");
    const message = u.searchParams.get("message")!;
    expect(message).toContain('[ld:d:{{printf "%.0f" .discussion.number}}]');
    expect(message).toContain('[ld:r:{{printf "%.0f" .workflow_run.id}}]');
    // Every numeric id goes through printf: Go templates would print floats like 1.23e+08.
    expect(message).not.toMatch(/\{\{\.(workflow_run|release|discussion|pull_request)\.(id|number)\}\}|\{\{\.hook_id\}\}/);
    expect(u.searchParams.get("priority")).toBe("{{if .discussion}}3{{else}}1{{end}}");
    expect(hookTargets(url, topic)).toBe(true);
    expect(hookTargets("https://ntfy.sh/other?template=yes", topic)).toBe(false);
    expect(ntfyAppLink(topic)).toBe("ntfy://ntfy.sh/localdesktop-abcdefghij");
  });

  it("generates base32 topics", () => {
    expect(randomTopic(new Uint8Array([0, 1, 31, 32, 255, 2, 3, 4, 5, 6]))).toBe("localdesktop-ab7a7cdefg");
    expect(randomTopic()).toMatch(/^localdesktop-[a-z2-7]{10}$/);
  });

  it("parses the committed config defensively", () => {
    expect(parseRepoConfig('{"version":1,"realtime":{"provider":"ntfy","url":"https://ntfy.sh/x"},"chat":{"category":"maintainers","keysDiscussion":4}}')).toEqual({
      version: 1,
      realtime: { provider: "ntfy", url: "https://ntfy.sh/x" },
      chat: { category: "maintainers", keysDiscussion: 4 },
    });
    expect(parseRepoConfig('{"realtime":{"provider":"ntfy","url":"http://insecure"}}')).toEqual({ version: 1 });
    expect(parseRepoConfig("nope")).toBeUndefined();
  });
});
