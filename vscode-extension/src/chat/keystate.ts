import { fingerprint, openSealedKey, unlinkKey, kidOf, verifyKeyRecord, type DeviceKeys } from "./crypto";
import { decodeKeyRecord, fromB64u, parseKeyRecordBody, type GrantRecord } from "./protocol";

/**
 * Pure state of the key directory (the locked "keys" discussion): which devices are accepted,
 * which grants are valid, which epoch is current, and which keys this device can unwrap.
 */

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";
export type PermissionLookup = (login: string) => Promise<Permission>;

const RANK: Record<Permission, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };
export function permissionAtLeast(p: Permission, min: Permission): boolean {
  return RANK[p] >= RANK[min];
}

export interface KeyComment {
  id: string;
  databaseId: number;
  createdAt: string;
  author: string;
  /** Set when the comment was edited; records are immutable, so edited ones are rejected. */
  lastEditedAt?: string | null;
  body: string;
}

export interface AcceptedDevice {
  dev: string;
  login: string;
  name: string;
  encPk: Uint8Array;
  signPk: Uint8Array;
  fingerprint: string;
  ts: number;
  commentId: string;
  revoked: boolean;
}

export interface AcceptedGrant {
  record: GrantRecord;
  commentId: string;
  createdAt: string;
  databaseId: number;
}

export interface DirectoryState {
  /** By device id. */
  devices: Map<string, AcceptedDevice>;
  /** In comment order. */
  grants: AcceptedGrant[];
  rejected: { commentId: string; reason: string }[];
}

export function emptyDirectory(): DirectoryState {
  return { devices: new Map(), grants: [], rejected: [] };
}

function commentOrder(a: { createdAt: string; databaseId: number }, b: { createdAt: string; databaseId: number }): number {
  return a.createdAt === b.createdAt ? a.databaseId - b.databaseId : a.createdAt < b.createdAt ? -1 : 1;
}

/**
 * Processes key-record comments in order. Trust anchors: GitHub's comment author (who posted it)
 * and the author's current repository permission (write or above).
 */
export async function processKeyComments(comments: KeyComment[], ctx: { repoNodeId: string; permission: PermissionLookup }, state: DirectoryState = emptyDirectory()): Promise<DirectoryState> {
  const sorted = [...comments].sort(commentOrder);
  for (const c of sorted) {
    const reject = (reason: string) => state.rejected.push({ commentId: c.id, reason });
    const raw = parseKeyRecordBody(c.body);
    if (!raw) continue; // ordinary comment
    if (c.lastEditedAt) {
      reject("edited");
      continue;
    }
    const rec = decodeKeyRecord(raw);
    if (!rec) {
      reject("malformed");
      continue;
    }
    if (rec.record.repo !== ctx.repoNodeId) {
      reject("wrong repository");
      continue;
    }
    const author = c.author.toLowerCase();
    switch (rec.type) {
      case "device": {
        const r = rec.record;
        if (r.login.toLowerCase() !== author) {
          reject("login doesn't match comment author");
          break;
        }
        if (state.devices.has(r.dev)) {
          reject("duplicate device id");
          break;
        }
        let signPk: Uint8Array;
        let encPk: Uint8Array;
        try {
          signPk = fromB64u(r.sig);
          encPk = fromB64u(r.enc);
        } catch {
          reject("bad keys");
          break;
        }
        if (signPk.length !== 32 || encPk.length !== 32 || !verifyKeyRecord(raw, signPk)) {
          reject("bad signature");
          break;
        }
        if (!permissionAtLeast(await ctx.permission(r.login), "write")) {
          reject("author lacks write access");
          break;
        }
        state.devices.set(r.dev, {
          dev: r.dev,
          login: r.login,
          name: r.name,
          encPk,
          signPk,
          fingerprint: fingerprint(signPk, encPk),
          ts: r.ts,
          commentId: c.id,
          revoked: false,
        });
        break;
      }
      case "grant": {
        const r = rec.record;
        const granter = state.devices.get(r.by.dev);
        if (!granter || granter.revoked || granter.login.toLowerCase() !== author || r.by.login.toLowerCase() !== author) {
          reject("unknown granting device");
          break;
        }
        if (!verifyKeyRecord(raw, granter.signPk)) {
          reject("bad signature");
          break;
        }
        if (!permissionAtLeast(await ctx.permission(granter.login), "write")) {
          reject("granter lacks write access");
          break;
        }
        state.grants.push({ record: r, commentId: c.id, createdAt: c.createdAt, databaseId: c.databaseId });
        break;
      }
      case "revoke": {
        const r = rec.record;
        const target = state.devices.get(r.dev);
        if (!target) {
          reject("unknown device");
          break;
        }
        const byOwner = target.login.toLowerCase() === author;
        const byMaintainer = permissionAtLeast(await ctx.permission(c.author), "maintain");
        if (!byOwner && !byMaintainer) {
          reject("not allowed to revoke");
          break;
        }
        const signer = r.by.dev ? state.devices.get(r.by.dev) : undefined;
        if (!signer || signer.login.toLowerCase() !== author || !verifyKeyRecord(raw, signer.signPk)) {
          reject("bad signature");
          break;
        }
        target.revoked = true;
        break;
      }
    }
  }
  return state;
}

/** Highest epoch wins; between grants of the same epoch number, the earliest comment wins. */
export function currentEpoch(state: DirectoryState): { ep: number; kid: string } | undefined {
  let best: AcceptedGrant | undefined;
  for (const g of state.grants) {
    if (g.record.reason === "join") continue; // joins re-share an existing epoch
    if (!best || g.record.ep > best.record.ep || (g.record.ep === best.record.ep && commentOrder(g, best) < 0)) best = g;
  }
  if (!best) {
    // Only join grants (shouldn't happen) — fall back to the highest of those.
    for (const g of state.grants) if (!best || g.record.ep > best.record.ep) best = g;
  }
  return best ? { ep: best.record.ep, kid: best.record.kid } : undefined;
}

export interface UnwrappedKey {
  kid: string;
  ep: number;
  key: Uint8Array;
}

/** Keys this device can read: sealed directly to it, plus everything reachable through links. */
export function unwrapKeys(state: DirectoryState, me: DeviceKeys, known: UnwrappedKey[] = []): UnwrappedKey[] {
  const keys = new Map<string, UnwrappedKey>();
  for (const k of known) keys.set(k.kid, k);
  for (const g of state.grants) {
    const mine = g.record.to.find((t) => t.dev === me.deviceId);
    if (!mine || keys.has(g.record.kid)) continue;
    let box: Uint8Array;
    try {
      box = fromB64u(mine.box);
    } catch {
      continue;
    }
    const key = openSealedKey(box, me);
    if (key && kidOf(key) === g.record.kid) keys.set(g.record.kid, { kid: g.record.kid, ep: g.record.ep, key });
  }
  // Walk the link chain until nothing new appears.
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of state.grants) {
      const link = g.record.link;
      const holder = keys.get(g.record.kid);
      if (!link || !holder || keys.has(link.kid)) continue;
      const prev = unlinkKey(link, holder.key);
      if (prev) {
        const prevEp = state.grants.find((x) => x.record.kid === link.kid)?.record.ep ?? g.record.ep - 1;
        keys.set(link.kid, { kid: link.kid, ep: prevEp, key: prev });
        changed = true;
      }
    }
  }
  return [...keys.values()];
}

/** Accepted, unrevoked devices that haven't received `kid` yet. */
export function pendingDevices(state: DirectoryState, kid: string): AcceptedDevice[] {
  const granted = new Set<string>();
  for (const g of state.grants) if (g.record.kid === kid) for (const t of g.record.to) granted.add(t.dev);
  return [...state.devices.values()].filter((d) => !d.revoked && !granted.has(d.dev));
}

/** Devices that hold `kid` (a grant sealed it to them). */
export function holders(state: DirectoryState, kid: string): AcceptedDevice[] {
  const out = new Map<string, AcceptedDevice>();
  for (const g of state.grants) {
    if (g.record.kid !== kid) continue;
    for (const t of g.record.to) {
      const d = state.devices.get(t.dev);
      if (d) out.set(d.dev, d);
    }
  }
  return [...out.values()];
}

/**
 * Logins holding the current key that have lost write access (or devices that were revoked):
 * the key must be rotated so they can't read new messages.
 */
export async function staleHolders(state: DirectoryState, kid: string, permission: PermissionLookup): Promise<AcceptedDevice[]> {
  const out: AcceptedDevice[] = [];
  for (const d of holders(state, kid)) {
    if (d.revoked || !permissionAtLeast(await permission(d.login), "write")) out.push(d);
  }
  return out;
}

/** Deterministic 0..19s jitter so concurrent members don't all post the same join grant. */
export function grantJitterMs(myDev: string, pendingDev: string): number {
  let h = 2166136261;
  for (const ch of `${myDev}\u0000${pendingDev}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 20) * 1000;
}
