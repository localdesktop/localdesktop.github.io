/**
 * Wire formats of the maintainer chat, stored as GitHub Discussions comments.
 *
 * Channel marker (first line of a discussion body):
 *   <!-- ld-chat:v1 {"kind":"channel","privacy":"private"} -->
 * Encrypted message comment:
 *   <!-- ldc2.<b64u(header)>.<b64u(nonce||ct)> -->
 *   🔒 *Encrypted message: …*
 *   cc @alice                                  (optional, plain text)
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
  kind: "channel";
  privacy: Privacy;
}

const DISCUSSION_MARKER = /^\s*<!--\s*ld-chat:v1\s+(\{[^\n]*?\})\s*-->/;

export function parseDiscussionMarker(body: string): DiscussionMeta | undefined {
  const m = DISCUSSION_MARKER.exec(body);
  if (!m) return undefined;
  try {
    const meta = JSON.parse(m[1]!) as { kind?: unknown; privacy?: unknown };
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
      ? `Chat channel. Messages here are encrypted; read and post them with the [Local Desktop VS Code extension](${EXTENSION_URL}).`
      : `Chat channel (public). Chat here from GitHub or the [Local Desktop VS Code extension](${EXTENSION_URL}).`;
  return `${marker}\n${human}${description ? `\n\n${description}` : ""}\n`;
}

/** Replaces the marker of an existing channel body, keeping the rest. */
export function withPrivacy(body: string, privacy: Privacy): string {
  const marker = `<!-- ld-chat:v1 ${JSON.stringify({ kind: "channel", privacy })} -->`;
  return DISCUSSION_MARKER.test(body) ? body.replace(DISCUSSION_MARKER, marker) : `${marker}\n${body}`;
}

// ---------- encrypted messages ----------

export interface MessageHeader {
  v: 2;
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
}

const MESSAGE_MARKER = /<!--\s*ldc2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*-->/;

export function parseMessageBody(body: string): MessageEnvelope | undefined {
  const m = MESSAGE_MARKER.exec(body);
  if (!m) return undefined;
  try {
    const headerBytes = fromB64u(m[1]!);
    const h = JSON.parse(fromUtf8(headerBytes)) as Partial<MessageHeader>;
    if (h.v !== 2 || typeof h.mid !== "string" || typeof h.rev !== "number") return undefined;
    return { header: h as MessageHeader, headerBytes, nonceCt: fromB64u(m[2]!) };
  } catch {
    return undefined;
  }
}

export function isEncryptedBody(body: string): boolean {
  return MESSAGE_MARKER.test(body);
}

export function formatMessageBody(headerBytes: Uint8Array, nonceCt: Uint8Array, cc: string[] = []): string {
  const lines = [
    `<!-- ldc2.${b64u(headerBytes)}.${b64u(nonceCt)} -->`,
    `🔒 *Encrypted message: read it with the [Local Desktop VS Code extension](${EXTENSION_URL}).*`,
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
  const prefix = `ldc2\n${ctx.repoNodeId}\n${ctx.channelNodeId}\n${ctx.authorLogin.toLowerCase()}\n${ctx.parentId ?? ""}\n`;
  return concatBytes(utf8(prefix), headerBytes);
}

const MENTION = /(^|[^\w`])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\b/g;

export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) out.add(m[2]!.toLowerCase());
  return [...out];
}
