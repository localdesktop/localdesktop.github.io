import sodium from "libsodium-wrappers";
import {
  b64u,
  buildAad,
  concatBytes,
  decodeKeyRecord,
  extractMentions,
  formatKeyRecordBody,
  formatMessageBody,
  fromB64u,
  fromUtf8,
  keySigPayload,
  messageSigPayload,
  parseMessageBody,
  utf8,
  type AadContext,
  type DeviceRecord,
  type GrantReason,
  type GrantRecord,
  type KeyRecord,
  type KeyRecordType,
  type MessageEnvelope,
  type MessageHeader,
  type Plaintext,
  type RawKeyRecord,
  type RevokeRecord,
} from "./protocol";

/** Must be awaited once before any other function here. */
export async function cryptoReady(): Promise<void> {
  await sodium.ready;
}

const PAD_BLOCK = 256;
const NONCE_BYTES = 24;

// ---------- device keys ----------

export interface DeviceKeys {
  deviceId: string;
  encPk: Uint8Array;
  encSk: Uint8Array;
  signPk: Uint8Array;
  signSk: Uint8Array;
}

export interface DeviceSeeds {
  deviceId?: Uint8Array;
  encSeed?: Uint8Array;
  signSeed?: Uint8Array;
}

/** New device identity; seeds are injectable for test vectors. */
export function generateDeviceKeys(seeds: DeviceSeeds = {}): DeviceKeys {
  const enc = seeds.encSeed ? sodium.crypto_box_seed_keypair(seeds.encSeed) : sodium.crypto_box_keypair();
  const sig = seeds.signSeed ? sodium.crypto_sign_seed_keypair(seeds.signSeed) : sodium.crypto_sign_keypair();
  return {
    deviceId: b64u(seeds.deviceId ?? sodium.randombytes_buf(16)),
    encPk: enc.publicKey,
    encSk: enc.privateKey,
    signPk: sig.publicKey,
    signSk: sig.privateKey,
  };
}

export function serializeDeviceKeys(k: DeviceKeys): string {
  return JSON.stringify({ deviceId: k.deviceId, encPk: b64u(k.encPk), encSk: b64u(k.encSk), signPk: b64u(k.signPk), signSk: b64u(k.signSk) });
}

export function deserializeDeviceKeys(text: string): DeviceKeys | undefined {
  try {
    const j = JSON.parse(text) as Record<string, string>;
    return { deviceId: j.deviceId!, encPk: fromB64u(j.encPk!), encSk: fromB64u(j.encSk!), signPk: fromB64u(j.signPk!), signSk: fromB64u(j.signSk!) };
  } catch {
    return undefined;
  }
}

/** BLAKE2b-160 of signPk‖encPk, shown as 5 groups of 8 hex digits for comparing out of band. */
export function fingerprint(signPk: Uint8Array, encPk: Uint8Array): string {
  const hex = sodium.to_hex(sodium.crypto_generichash(20, concatBytes(signPk, encPk), null));
  return hex.match(/.{8}/g)!.join(" ");
}

// ---------- epoch and channel keys ----------

export function newEpochKey(): Uint8Array {
  return sodium.randombytes_buf(32);
}

export function kidOf(epochKey: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_generichash(8, epochKey, utf8("ld-chat/kid")));
}

/** Per-channel key: a ciphertext copied into another channel can't be decrypted there. */
export function channelKey(epochKey: Uint8Array, channelNodeId: string): Uint8Array {
  return sodium.crypto_generichash(32, utf8(`ld-chat/v1/channel/${channelNodeId}`), epochKey);
}

export function sealKey(epochKey: Uint8Array, recipientEncPk: Uint8Array): Uint8Array {
  return sodium.crypto_box_seal(epochKey, recipientEncPk);
}

export function openSealedKey(box: Uint8Array, me: DeviceKeys): Uint8Array | undefined {
  try {
    return sodium.crypto_box_seal_open(box, me.encPk, me.encSk);
  } catch {
    return undefined;
  }
}

/** Seals the previous epoch key with the new one (the "link" that keeps history readable). */
export function linkKey(prevKey: Uint8Array, newKey: Uint8Array, nonce?: Uint8Array): { kid: string; n: string; box: string } {
  const n = nonce ?? sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return { kid: kidOf(prevKey), n: b64u(n), box: b64u(sodium.crypto_secretbox_easy(prevKey, n, newKey)) };
}

export function unlinkKey(link: { kid: string; n: string; box: string }, newKey: Uint8Array): Uint8Array | undefined {
  try {
    const prev = sodium.crypto_secretbox_open_easy(fromB64u(link.box), fromB64u(link.n), newKey);
    return kidOf(prev) === link.kid ? prev : undefined;
  } catch {
    return undefined;
  }
}

// ---------- messages ----------

export interface EncryptInput extends AadContext {
  text: string;
  epochKey: Uint8Array;
  ep: number;
  device: DeviceKeys;
  /** Keep the mid and bump rev when editing. */
  mid?: string;
  rev?: number;
  ts?: number;
  cc?: string[];
  /** Test vectors only. */
  nonce?: Uint8Array;
}

export interface EncryptedMessage {
  body: string;
  header: MessageHeader;
}

export function encryptMessage(input: EncryptInput): EncryptedMessage {
  const header: MessageHeader = {
    v: 1,
    kid: kidOf(input.epochKey),
    ep: input.ep,
    dev: input.device.deviceId,
    mid: input.mid ?? b64u(sodium.randombytes_buf(12)),
    rev: input.rev ?? 1,
  };
  const headerBytes = utf8(JSON.stringify(header));
  const aad = buildAad(input, headerBytes);
  const plaintext: Plaintext = { text: input.text, ts: input.ts ?? Date.now(), mentions: extractMentions(input.text) };
  const padded = sodium.pad(utf8(JSON.stringify(plaintext)), PAD_BLOCK);
  const nonce = input.nonce ?? sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(padded, aad, null, nonce, channelKey(input.epochKey, input.channelNodeId));
  const nonceCt = concatBytes(nonce, ct);
  const sig = sodium.crypto_sign_detached(messageSigPayload(aad, nonceCt), input.device.signSk);
  return { body: formatMessageBody(headerBytes, nonceCt, sig, input.cc), header };
}

export type DecryptResult =
  | { ok: true; header: MessageHeader; plaintext: Plaintext }
  | { ok: false; header?: MessageHeader; reason: "notEncrypted" | "noKey" | "unknownDevice" | "badSignature" | "invalid" };

export interface DecryptContext extends AadContext {
  /** Epoch keys by kid. */
  keyFor(kid: string): Uint8Array | undefined;
  /** Ed25519 key of an accepted, unrevoked device of `login`. */
  signPkFor(login: string, deviceId: string): Uint8Array | undefined;
}

export function decryptMessage(body: string, ctx: DecryptContext): DecryptResult {
  const env: MessageEnvelope | undefined = parseMessageBody(body);
  if (!env) return { ok: false, reason: "notEncrypted" };
  const { header } = env;
  const signPk = ctx.signPkFor(ctx.authorLogin, header.dev);
  if (!signPk) return { ok: false, header, reason: "unknownDevice" };
  const aad = buildAad(ctx, env.headerBytes);
  let sigOk = false;
  try {
    sigOk = sodium.crypto_sign_verify_detached(env.sig, messageSigPayload(aad, env.nonceCt), signPk);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, header, reason: "badSignature" };
  const key = ctx.keyFor(header.kid);
  if (!key) return { ok: false, header, reason: "noKey" };
  if (env.nonceCt.length <= NONCE_BYTES) return { ok: false, header, reason: "invalid" };
  try {
    const nonce = env.nonceCt.subarray(0, NONCE_BYTES);
    const ct = env.nonceCt.subarray(NONCE_BYTES);
    const padded = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, channelKey(key, ctx.channelNodeId));
    const json = JSON.parse(fromUtf8(sodium.unpad(padded, PAD_BLOCK))) as Plaintext;
    if (typeof json.text !== "string" || typeof json.ts !== "number") return { ok: false, header, reason: "invalid" };
    return { ok: true, header, plaintext: { text: json.text, ts: json.ts, mentions: Array.isArray(json.mentions) ? json.mentions.map(String) : [] } };
  } catch {
    return { ok: false, header, reason: "invalid" };
  }
}

// ---------- key records ----------

export function signKeyRecord(type: KeyRecordType, record: object, signSk: Uint8Array, readable: string): string {
  const jsonBytes = utf8(JSON.stringify(record));
  const sig = sodium.crypto_sign_detached(keySigPayload(type, jsonBytes), signSk);
  return formatKeyRecordBody(type, jsonBytes, sig, readable);
}

export function verifyKeyRecord(raw: RawKeyRecord, signPk: Uint8Array): boolean {
  try {
    return sodium.crypto_sign_verify_detached(raw.sig, keySigPayload(raw.type, raw.jsonBytes), signPk);
  } catch {
    return false;
  }
}

export function deviceRecordBody(me: DeviceKeys, login: string, repoNodeId: string, name: string, ts = Date.now()): string {
  const record: DeviceRecord = { v: 1, dev: me.deviceId, name, login, repo: repoNodeId, enc: b64u(me.encPk), sig: b64u(me.signPk), ts };
  return signKeyRecord("device", record, me.signSk, `🔑 New chat device for @${login}: **${name}** (fingerprint \`${fingerprint(me.signPk, me.encPk)}\`)`);
}

export interface GrantTarget {
  login: string;
  dev: string;
  encPk: Uint8Array;
}

export function grantRecordBody(input: {
  me: DeviceKeys;
  login: string;
  repoNodeId: string;
  ep: number;
  epochKey: Uint8Array;
  reason: GrantReason;
  to: GrantTarget[];
  prevKey?: Uint8Array;
  ts?: number;
}): { body: string; record: GrantRecord } {
  const record: GrantRecord = {
    v: 1,
    repo: input.repoNodeId,
    ep: input.ep,
    kid: kidOf(input.epochKey),
    reason: input.reason,
    by: { login: input.login, dev: input.me.deviceId },
    to: input.to.map((t) => ({ login: t.login, dev: t.dev, box: b64u(sealKey(input.epochKey, t.encPk)) })),
    ts: input.ts ?? Date.now(),
  };
  if (input.prevKey) record.link = linkKey(input.prevKey, input.epochKey);
  const who = [...new Set(input.to.map((t) => `@${t.login}`))].join(", ");
  const readable = {
    init: `🔐 Chat encryption initialized (epoch ${input.ep}).`,
    join: `🔓 Shared the chat key with ${input.to.length} new device(s) of ${who}.`,
    rotate: `♻️ Rotated the chat key (epoch ${input.ep}) for ${input.to.length} device(s).`,
    reinit: `⚠️ Re-initialized the chat key (epoch ${input.ep}); older messages can't be decrypted by new devices.`,
  }[input.reason];
  return { body: signKeyRecord("grant", record, input.me.signSk, readable), record };
}

export function revokeRecordBody(me: DeviceKeys, login: string, repoNodeId: string, dev: string, reason?: string): string {
  const record: RevokeRecord = { v: 1, repo: repoNodeId, dev, by: { login, dev: me.deviceId }, reason, ts: Date.now() };
  return signKeyRecord("revoke", record, me.signSk, `🚫 Revoked chat device \`${dev}\`${reason ? `: ${reason}` : ""}`);
}

export type { KeyRecord };
export { decodeKeyRecord };
