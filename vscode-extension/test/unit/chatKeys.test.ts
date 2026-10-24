import { beforeAll, describe, expect, it } from "vitest";
import { cryptoReady, deviceRecordBody, generateDeviceKeys, grantRecordBody, kidOf, revokeRecordBody, type DeviceKeys } from "../../src/chat/crypto";
import {
  currentEpoch,
  grantJitterMs,
  pendingDevices,
  processKeyComments,
  staleHolders,
  unwrapKeys,
  type KeyComment,
  type Permission,
} from "../../src/chat/keystate";

const REPO = "R_repo";
const seed = (n: number, len = 32) => new Uint8Array(len).fill(n);
let alice: DeviceKeys;
let bob: DeviceKeys;
let mallory: DeviceKeys;

let seq = 0;
function comment(author: string, body: string, over: Partial<KeyComment> = {}): KeyComment {
  seq++;
  return { id: `DC_${seq}`, databaseId: seq, createdAt: `2026-10-20T10:00:${String(seq).padStart(2, "0")}Z`, author, body, ...over };
}

const perms: Record<string, Permission> = { alice: "admin", bob: "write", mallory: "read", carol: "maintain" };
const permission = async (login: string): Promise<Permission> => perms[login.toLowerCase()] ?? "none";

beforeAll(async () => {
  await cryptoReady();
  alice = generateDeviceKeys({ deviceId: seed(1, 16), encSeed: seed(2), signSeed: seed(3) });
  bob = generateDeviceKeys({ deviceId: seed(4, 16), encSeed: seed(5), signSeed: seed(6) });
  mallory = generateDeviceKeys({ deviceId: seed(7, 16), encSeed: seed(8), signSeed: seed(9) });
});

const target = (login: string, k: DeviceKeys) => ({ login, dev: k.deviceId, encPk: k.encPk });

describe("device records", () => {
  it.each<[string, () => KeyComment, string | undefined]>([
    ["self-signed by a writer", () => comment("alice", deviceRecordBody(alice, "alice", REPO, "VS Code on macOS")), undefined],
    ["posted by someone else", () => comment("bob", deviceRecordBody(alice, "alice", REPO, "x")), "login doesn't match comment author"],
    ["for another repository", () => comment("alice", deviceRecordBody(alice, "alice", "R_other", "x")), "wrong repository"],
    ["from a reader", () => comment("mallory", deviceRecordBody(mallory, "mallory", REPO, "x")), "author lacks write access"],
    ["edited after posting", () => comment("alice", deviceRecordBody(alice, "alice", REPO, "x"), { lastEditedAt: "2026-10-21T00:00:00Z" }), "edited"],
    [
      "with a forged signature",
      () => {
        const body = deviceRecordBody(alice, "alice", REPO, "x");
        const forged = deviceRecordBody(bob, "alice", REPO, "x");
        // splice alice's JSON with bob's signature
        const sig = /\.([A-Za-z0-9_-]+) -->/.exec(forged)![1]!;
        return comment("alice", body.replace(/\.([A-Za-z0-9_-]+) -->/, `.${sig} -->`));
      },
      "bad signature",
    ],
  ])("device %s", async (_name, make, rejection) => {
    const state = await processKeyComments([make()], { repoNodeId: REPO, permission });
    if (rejection) {
      expect(state.devices.size).toBe(0);
      expect(state.rejected[0]?.reason).toBe(rejection);
    } else {
      expect(state.devices.get(alice.deviceId)).toMatchObject({ login: "alice", name: "VS Code on macOS", revoked: false });
    }
  });
});

describe("grants and epochs", () => {
  it("unwraps keys sealed to this device and follows links back", async () => {
    const k1 = seed(21);
    const k2 = seed(22);
    const comments = [
      comment("alice", deviceRecordBody(alice, "alice", REPO, "a")),
      comment("alice", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 1, epochKey: k1, reason: "init", to: [target("alice", alice)] }).body),
      comment("bob", deviceRecordBody(bob, "bob", REPO, "b")),
      comment("alice", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 2, epochKey: k2, reason: "rotate", to: [target("alice", alice), target("bob", bob)], prevKey: k1 }).body),
    ];
    const state = await processKeyComments(comments, { repoNodeId: REPO, permission });
    expect(state.rejected).toEqual([]);
    expect(currentEpoch(state)).toEqual({ ep: 2, kid: kidOf(k2) });
    // Bob only received epoch 2 directly, but the link gives him epoch 1 history.
    const bobKeys = unwrapKeys(state, bob);
    expect(bobKeys.map((k) => k.kid).sort()).toEqual([kidOf(k1), kidOf(k2)].sort());
    expect(bobKeys.find((k) => k.kid === kidOf(k1))?.ep).toBe(1);
    expect(unwrapKeys(state, mallory)).toEqual([]);
  });

  it("lets the earliest grant win between two grants of the same epoch", async () => {
    const kA = seed(31);
    const kB = seed(32);
    const comments = [
      comment("alice", deviceRecordBody(alice, "alice", REPO, "a")),
      comment("bob", deviceRecordBody(bob, "bob", REPO, "b")),
      comment("alice", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 1, epochKey: seed(30), reason: "init", to: [target("alice", alice), target("bob", bob)] }).body),
      comment("bob", grantRecordBody({ me: bob, login: "bob", repoNodeId: REPO, ep: 2, epochKey: kB, reason: "rotate", to: [target("bob", bob)] }).body, { createdAt: "2026-10-20T11:00:05Z" }),
      comment("alice", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 2, epochKey: kA, reason: "rotate", to: [target("alice", alice)] }).body, { createdAt: "2026-10-20T11:00:01Z" }),
    ];
    const state = await processKeyComments(comments, { repoNodeId: REPO, permission });
    expect(currentEpoch(state)?.kid).toBe(kidOf(kA));
  });

  it.each<[string, () => KeyComment[], string]>([
    [
      "grant from an unregistered device",
      () => [comment("alice", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 1, epochKey: seed(40), reason: "init", to: [] }).body)],
      "unknown granting device",
    ],
    [
      "grant posted by another account",
      () => [
        comment("alice", deviceRecordBody(alice, "alice", REPO, "a")),
        comment("bob", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 1, epochKey: seed(41), reason: "init", to: [] }).body),
      ],
      "unknown granting device",
    ],
  ])("rejects a %s", async (_name, make, reason) => {
    const state = await processKeyComments(make(), { repoNodeId: REPO, permission });
    expect(state.grants).toEqual([]);
    expect(state.rejected.at(-1)?.reason).toBe(reason);
  });

  it("finds pending devices, revocations and stale holders", async () => {
    const k1 = seed(51);
    const comments = [
      comment("alice", deviceRecordBody(alice, "alice", REPO, "a")),
      comment("bob", deviceRecordBody(bob, "bob", REPO, "b")),
      comment("alice", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 1, epochKey: k1, reason: "init", to: [target("alice", alice)] }).body),
    ];
    let state = await processKeyComments(comments, { repoNodeId: REPO, permission });
    expect(pendingDevices(state, kidOf(k1)).map((d) => d.login)).toEqual(["bob"]);

    state = await processKeyComments([comment("alice", grantRecordBody({ me: alice, login: "alice", repoNodeId: REPO, ep: 1, epochKey: k1, reason: "join", to: [target("bob", bob)] }).body)], { repoNodeId: REPO, permission }, state);
    expect(pendingDevices(state, kidOf(k1))).toEqual([]);
    expect(currentEpoch(state)?.ep).toBe(1);

    // Bob loses write access: he's a stale holder until the key is rotated.
    const demoted = async (login: string): Promise<Permission> => (login === "bob" ? "read" : permission(login));
    expect((await staleHolders(state, kidOf(k1), demoted)).map((d) => d.login)).toEqual(["bob"]);

    // A reader can't revoke; the owner can.
    state = await processKeyComments([comment("mallory", revokeRecordBody(mallory, "mallory", REPO, bob.deviceId))], { repoNodeId: REPO, permission }, state);
    expect(state.devices.get(bob.deviceId)?.revoked).toBe(false);
    state = await processKeyComments([comment("bob", revokeRecordBody(bob, "bob", REPO, bob.deviceId, "lost laptop"))], { repoNodeId: REPO, permission }, state);
    expect(state.devices.get(bob.deviceId)?.revoked).toBe(true);
  });

  it("spreads grant jitter deterministically within 20s", () => {
    expect(grantJitterMs("a", "b")).toBe(grantJitterMs("a", "b"));
    for (const p of ["x", "y", "z", "w"]) {
      const j = grantJitterMs("dev", p);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(20_000);
    }
  });
});
