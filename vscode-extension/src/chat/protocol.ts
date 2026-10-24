/**
 * Wire formats of the maintainer chat, stored as GitHub Discussions comments. Pure functions only:
 * no editor APIs and no crypto (see crypto.ts), so they can be tested and reused anywhere.
 *
 * Discussion markers (first line of a discussion body):
 *   <!-- ld-chat:v1 {"kind":"channel","privacy":"private"} -->
 *   <!-- ld-chat:v1 {"kind":"keys"} -->
 * Encrypted message comment:
 *   <!-- ldc1.<b64u(header)>.<b64u(nonce||ct)>.<b64u(sig)> -->
 *   🔒 *Encrypted maintainer message — …*
 *   cc @alice                                  (optional, plain text)
 * Key record comment (keys discussion):
 *   <!-- ldk1.<type>.<b64u(json)>.<b64u(sig)> -->
 *   readable line
 */

export type Privacy = "private" | "public";

export const EXTENSION_URL = "https://open-vsx.org/extension/mister-teddy/localdesktop-dev";

// ---------- base64url ----------

export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

export function fromUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- discussion markers ----------

export interface DiscussionMeta {
  kind: "channel" | "keys";
  privacy?: Privacy;
}

const DISCUSSION_MARKER = /^\s*<!--\s*ld-chat:v1\s+(\{[^\n]*?\})\s*-->/;

export function parseDiscussionMarker(body: string): DiscussionMeta | undefined {
  const m = DISCUSSION_MARKER.exec(body);
  if (!m) return undefined;
  try {
    const meta = JSON.parse(m[1]!) as { kind?: unknown; privacy?: unknown };
    if (meta.kind === "keys") return { kind: "keys" };
    if (meta.kind === "channel") return { kind: "channel", privacy: meta.privacy === "public" ? "public" : "private" };
  } catch {
    // malformed marker
  }
  return undefined;
}

export function channelBody(privacy: Privacy, description = ""): string {
  const marker = `<!-- ld-chat:v1 ${JSON.stringify({ kind: "channel", privacy })} -->`;
  const human =
    privacy === "private"
      ? `Maintainer channel. Messages here are end-to-end encrypted; read them in the [Local Desktop VS Code extension](${EXTENSION_URL}).`
      : `Maintainer channel (public). Chat here from GitHub or the [Local Desktop VS Code extension](${EXTENSION_URL}).`;
  return `${marker}\n${human}${description ? `\n\n${description}` : ""}\n`;
}

/** Replaces the marker of an existing channel body, keeping the rest. */
export function withPrivacy(body: string, privacy: Privacy): string {
  const marker = `<!-- ld-chat:v1 ${JSON.stringify({ kind: "channel", privacy })} -->`;
  return DISCUSSION_MARKER.test(body) ? body.replace(DISCUSSION_MARKER, marker) : `${marker}\n${body}`;
}

export function keysBody(): string {
  return `<!-- ld-chat:v1 {"kind":"keys"} -->\nKey directory for the maintainer chat: device public keys and encrypted key grants, managed by the [Local Desktop VS Code extension](${EXTENSION_URL}). Please don't comment here.\n`;
}

// ---------- encrypted messages ----------

export interface MessageHeader {
  v: 1;
  /** Epoch key id (hex). */
  kid: string;
  /** Epoch number. */
  ep: number;
  /** Sending device id. */
  dev: string;
  /** Message id: stays the same across edits. */
  mid: string;
  /** Revision, incremented on every edit. */
  rev: number;
}

export interface Plaintext {
  text: string;
  /** Milliseconds since the epoch, set by the sender. */
  ts: number;
  mentions: string[];
}

export interface MessageEnvelope {
  header: MessageHeader;
  headerBytes: Uint8Array;
  /** 24-byte nonce followed by the ciphertext. */
  nonceCt: Uint8Array;
  sig: Uint8Array;
}

const MESSAGE_MARKER = /<!--\s*ldc1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*-->/;

export function parseMessageBody(body: string): MessageEnvelope | undefined {
  const m = MESSAGE_MARKER.exec(body);
  if (!m) return undefined;
  try {
    const headerBytes = fromB64u(m[1]!);
    const h = JSON.parse(fromUtf8(headerBytes)) as Partial<MessageHeader>;
    if (h.v !== 1 || typeof h.kid !== "string" || typeof h.ep !== "number" || typeof h.dev !== "string" || typeof h.mid !== "string" || typeof h.rev !== "number") {
      return undefined;
    }
    return { header: h as MessageHeader, headerBytes, nonceCt: fromB64u(m[2]!), sig: fromB64u(m[3]!) };
  } catch {
    return undefined;
  }
}

export function isEncryptedBody(body: string): boolean {
  return MESSAGE_MARKER.test(body);
}

export function formatMessageBody(headerBytes: Uint8Array, nonceCt: Uint8Array, sig: Uint8Array, cc: string[] = []): string {
  const lines = [
    `<!-- ldc1.${b64u(headerBytes)}.${b64u(nonceCt)}.${b64u(sig)} -->`,
    `🔒 *Encrypted maintainer message: read it in the [Local Desktop VS Code extension](${EXTENSION_URL}).*`,
  ];
  if (cc.length) lines.push("", `cc ${cc.map((u) => `@${u}`).join(" ")}`);
  return lines.join("\n") + "\n";
}

export interface AadContext {
  repoNodeId: string;
  channelNodeId: string;
  authorLogin: string;
  /** Node id of the top-level comment this one replies to ("" for top-level comments). */
  parentId?: string;
}

/** Binds a ciphertext to its repo, channel, author and thread position, plus its header. */
export function buildAad(ctx: AadContext, headerBytes: Uint8Array): Uint8Array {
  const prefix = `ldc1\n${ctx.repoNodeId}\n${ctx.channelNodeId}\n${ctx.authorLogin.toLowerCase()}\n${ctx.parentId ?? ""}\n`;
  return concatBytes(utf8(prefix), headerBytes);
}

export function messageSigPayload(aad: Uint8Array, nonceCt: Uint8Array): Uint8Array {
  return concatBytes(utf8("ldc1-sig"), aad, nonceCt);
}

const MENTION = /(^|[^\w`])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\b/g;

export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) out.add(m[2]!.toLowerCase());
  return [...out];
}

// ---------- key records ----------

export type KeyRecordType = "device" | "grant" | "revoke";

export interface DeviceRecord {
  v: 1;
  dev: string;
  name: string;
  login: string;
  /** Repository node id: records can't be replayed into another repo. */
  repo: string;
  /** X25519 public key (b64u). */
  enc: string;
  /** Ed25519 public key (b64u); the record is signed with it. */
  sig: string;
  ts: number;
}

export type GrantReason = "init" | "join" | "rotate" | "reinit";

export interface GrantRecipient {
  login: string;
  dev: string;
  /** crypto_box_seal(K_e, recipient encPk), b64u. */
  box: string;
}

export interface GrantRecord {
  v: 1;
  repo: string;
  ep: number;
  kid: string;
  reason: GrantReason;
  by: { login: string; dev: string };
  to: GrantRecipient[];
  /** The previous epoch key, sealed with this one, so holders can read older history. */
  link?: { kid: string; n: string; box: string };
  ts: number;
}

export interface RevokeRecord {
  v: 1;
  repo: string;
  dev: string;
  by: { login: string; dev?: string };
  reason?: string;
  ts: number;
}

export type KeyRecord = { type: "device"; record: DeviceRecord } | { type: "grant"; record: GrantRecord } | { type: "revoke"; record: RevokeRecord };

export interface RawKeyRecord {
  type: KeyRecordType;
  jsonBytes: Uint8Array;
  sig: Uint8Array;
}

const KEY_MARKER = /<!--\s*ldk1\.(device|grant|revoke)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*-->/;

export function parseKeyRecordBody(body: string): RawKeyRecord | undefined {
  const m = KEY_MARKER.exec(body);
  if (!m) return undefined;
  try {
    return { type: m[1] as KeyRecordType, jsonBytes: fromB64u(m[2]!), sig: fromB64u(m[3]!) };
  } catch {
    return undefined;
  }
}

/** Decodes and shape-checks the JSON of a record (signatures are checked in crypto.ts). */
export function decodeKeyRecord(raw: RawKeyRecord): KeyRecord | undefined {
  let json: any;
  try {
    json = JSON.parse(fromUtf8(raw.jsonBytes));
  } catch {
    return undefined;
  }
  if (!json || json.v !== 1 || typeof json.repo !== "string") return undefined;
  const str = (x: unknown) => typeof x === "string" && x.length > 0;
  switch (raw.type) {
    case "device":
      if (str(json.dev) && str(json.login) && str(json.enc) && str(json.sig) && typeof json.name === "string" && typeof json.ts === "number") {
        return { type: "device", record: json as DeviceRecord };
      }
      return undefined;
    case "grant":
      if (
        typeof json.ep === "number" &&
        json.ep >= 1 &&
        str(json.kid) &&
        ["init", "join", "rotate", "reinit"].includes(json.reason) &&
        json.by &&
        str(json.by.login) &&
        str(json.by.dev) &&
        Array.isArray(json.to) &&
        json.to.every((t: any) => t && str(t.login) && str(t.dev) && str(t.box)) &&
        (json.link === undefined || (json.link && str(json.link.kid) && str(json.link.n) && str(json.link.box)))
      ) {
        return { type: "grant", record: json as GrantRecord };
      }
      return undefined;
    case "revoke":
      if (str(json.dev) && json.by && str(json.by.login)) return { type: "revoke", record: json as RevokeRecord };
      return undefined;
  }
}

export function keySigPayload(type: KeyRecordType, jsonBytes: Uint8Array): Uint8Array {
  return concatBytes(utf8(`ldk1-sig\n${type}\n`), jsonBytes);
}

export function formatKeyRecordBody(type: KeyRecordType, jsonBytes: Uint8Array, sig: Uint8Array, readable: string): string {
  return `<!-- ldk1.${type}.${b64u(jsonBytes)}.${b64u(sig)} -->\n${readable}\n`;
}
