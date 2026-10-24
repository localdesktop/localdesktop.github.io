import { beforeAll, describe, expect, it } from "vitest";
import {
  cryptoReady,
  decryptMessage,
  encryptMessage,
  fingerprint,
  generateDeviceKeys,
  kidOf,
  linkKey,
  unlinkKey,
  type DecryptContext,
  type DeviceKeys,
} from "../../src/chat/crypto";
import { b64u, extractMentions, fromB64u, parseMessageBody } from "../../src/chat/protocol";

const seed = (n: number, len = 32) => new Uint8Array(len).fill(n);

let alice: DeviceKeys;
let bob: DeviceKeys;
const K = seed(7);
const ctxBase = { repoNodeId: "R_repo", channelNodeId: "D_general", authorLogin: "Alice", parentId: "" };

function decryptCtx(over: Partial<DecryptContext> = {}): DecryptContext {
  return {
    ...ctxBase,
    keyFor: (kid) => (kid === kidOf(K) ? K : undefined),
    signPkFor: (login, dev) => (login.toLowerCase() === "alice" && dev === alice.deviceId ? alice.signPk : undefined),
    ...over,
  };
}

beforeAll(async () => {
  await cryptoReady();
  alice = generateDeviceKeys({ deviceId: seed(1, 16), encSeed: seed(2), signSeed: seed(3) });
  bob = generateDeviceKeys({ deviceId: seed(4, 16), encSeed: seed(5), signSeed: seed(6) });
});

describe("message encryption", () => {
  it("round-trips and extracts mentions", () => {
    const { body, header } = encryptMessage({ ...ctxBase, text: "hi @bob, see `@notme`", epochKey: K, ep: 1, device: alice, ts: 1000 });
    expect(header).toMatchObject({ v: 1, kid: kidOf(K), ep: 1, dev: alice.deviceId, rev: 1 });
    expect(body).toContain("<!-- ldc1.");
    expect(body).not.toContain("hi @bob");
    const r = decryptMessage(body, decryptCtx());
    expect(r).toMatchObject({ ok: true, plaintext: { text: "hi @bob, see `@notme`", ts: 1000, mentions: ["bob"] } });
  });

  it("pads ciphertext to 256-byte blocks", () => {
    const short = parseMessageBody(encryptMessage({ ...ctxBase, text: "a", epochKey: K, ep: 1, device: alice }).body)!;
    const longer = parseMessageBody(encryptMessage({ ...ctxBase, text: "a".repeat(100), epochKey: K, ep: 1, device: alice }).body)!;
    expect(short.nonceCt.length).toBe(longer.nonceCt.length);
    expect((short.nonceCt.length - 24 - 16) % 256).toBe(0);
  });

  it("adds a plain-text cc line only when asked", () => {
    const { body } = encryptMessage({ ...ctxBase, text: "x", epochKey: K, ep: 1, device: alice, cc: ["bob"] });
    expect(body).toMatch(/\ncc @bob\n$/);
  });

  it.each([
    ["another channel", { channelNodeId: "D_other" }],
    ["another author", { authorLogin: "mallory", signPkFor: () => alice.signPk }],
    ["another thread parent", { parentId: "DC_parent" }],
    ["another repo", { repoNodeId: "R_other" }],
  ])("rejects a ciphertext moved to %s", (_name, over) => {
    const { body } = encryptMessage({ ...ctxBase, text: "secret", epochKey: K, ep: 1, device: alice });
    const r = decryptMessage(body, decryptCtx(over as Partial<DecryptContext>));
    expect(r.ok).toBe(false);
  });

  it("reports unknown devices, missing keys and tampering", () => {
    const { body } = encryptMessage({ ...ctxBase, text: "secret", epochKey: K, ep: 1, device: alice });
    expect(decryptMessage(body, decryptCtx({ signPkFor: () => undefined }))).toMatchObject({ ok: false, reason: "unknownDevice" });
    expect(decryptMessage(body, decryptCtx({ keyFor: () => undefined }))).toMatchObject({ ok: false, reason: "noKey" });
    expect(decryptMessage(body, decryptCtx({ signPkFor: () => bob.signPk }))).toMatchObject({ ok: false, reason: "badSignature" });

    // Flip one ciphertext byte: the signature no longer matches.
    const env = parseMessageBody(body)!;
    const flipped = new Uint8Array(env.nonceCt);
    flipped[30]! ^= 1;
    const tampered = body.replace(b64u(env.nonceCt), b64u(flipped));
    expect(decryptMessage(tampered, decryptCtx())).toMatchObject({ ok: false, reason: "badSignature" });
  });

  it("rejects a header claiming a different kid", () => {
    const { body } = encryptMessage({ ...ctxBase, text: "secret", epochKey: K, ep: 1, device: alice });
    const other = seed(9);
    // A reader holding a different key under the claimed kid must fail authentication.
    expect(decryptMessage(body, decryptCtx({ keyFor: () => other }))).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("keeps mid and bumps rev on edit", () => {
    const first = encryptMessage({ ...ctxBase, text: "v1", epochKey: K, ep: 1, device: alice });
    const second = encryptMessage({ ...ctxBase, text: "v2", epochKey: K, ep: 1, device: alice, mid: first.header.mid, rev: first.header.rev + 1 });
    expect(second.header.mid).toBe(first.header.mid);
    expect(second.header.rev).toBe(2);
  });

  it("produces a fixed wire format with injected nonce and keys", () => {
    const { body } = encryptMessage({ ...ctxBase, text: "vector", epochKey: K, ep: 3, device: alice, mid: "bWlk", rev: 1, ts: 1700000000000, nonce: seed(8, 24) });
    const again = encryptMessage({ ...ctxBase, text: "vector", epochKey: K, ep: 3, device: alice, mid: "bWlk", rev: 1, ts: 1700000000000, nonce: seed(8, 24) });
    expect(again.body).toBe(body);
    const env = parseMessageBody(body)!;
    expect(env.header).toEqual({ v: 1, kid: kidOf(K), ep: 3, dev: b64u(seed(1, 16)), mid: "bWlk", rev: 1 });
    expect(Array.from(env.nonceCt.subarray(0, 24))).toEqual(Array.from(seed(8, 24)));
    expect(kidOf(K)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(alice.signPk, alice.encPk)).toMatch(/^([0-9a-f]{8} ){4}[0-9a-f]{8}$/);
  });
});

describe("key links", () => {
  it("unwraps the previous epoch key and checks its kid", () => {
    const prev = seed(11);
    const next = seed(12);
    const link = linkKey(prev, next, seed(13, 24));
    expect(link.kid).toBe(kidOf(prev));
    expect(Array.from(unlinkKey(link, next)!)).toEqual(Array.from(prev));
    expect(unlinkKey(link, seed(14))).toBeUndefined();
    expect(unlinkKey({ ...link, kid: "0000000000000000" }, next)).toBeUndefined();
  });
});

describe("protocol helpers", () => {
  it("extracts mentions but not emails or code", () => {
    expect(extractMentions("ping @Alice and @bob-2, mail a@b.c, `@code`")).toEqual(["alice", "bob-2"]);
  });
  it("rejects invalid base64url", () => {
    expect(() => fromB64u("a+b/")).toThrow();
  });
});
