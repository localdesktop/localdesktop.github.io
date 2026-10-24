import sodium from "libsodium-wrappers";
import {
  b64u,
  buildAad,
  concatBytes,
  extractMentions,
  formatMessageBody,
  fromUtf8,
  parseMessageBody,
  utf8,
  type AadContext,
  type MessageHeader,
  type Plaintext,
} from "./protocol";

export async function cryptoReady(): Promise<void> {
  await sodium.ready;
}

const PAD_BLOCK = 256;
const NONCE_BYTES = 24;
const CHAT_SEED = utf8("localdesktop-chat-v2");

export function channelKey(channelNodeId: string): Uint8Array {
  return sodium.crypto_generichash(32, utf8(`ld-chat/v2/channel/${channelNodeId}`), CHAT_SEED);
}

export interface EncryptInput extends AadContext {
  text: string;
  /** Keep the mid and bump rev when editing. */
  mid?: string;
  rev?: number;
  ts?: number;
  cc?: string[];
  nonce?: Uint8Array;
}

export function encryptMessage(input: EncryptInput): { body: string; header: MessageHeader } {
  const header: MessageHeader = { v: 2, mid: input.mid ?? b64u(sodium.randombytes_buf(12)), rev: input.rev ?? 1 };
  const headerBytes = utf8(JSON.stringify(header));
  const aad = buildAad(input, headerBytes);
  const plaintext: Plaintext = { text: input.text, ts: input.ts ?? Date.now(), mentions: extractMentions(input.text) };
  const padded = sodium.pad(utf8(JSON.stringify(plaintext)), PAD_BLOCK);
  const nonce = input.nonce ?? sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(padded, aad, null, nonce, channelKey(input.channelNodeId));
  return { body: formatMessageBody(headerBytes, concatBytes(nonce, ct), input.cc), header };
}

export type DecryptResult = { ok: true; header: MessageHeader; plaintext: Plaintext } | { ok: false; header?: MessageHeader; reason: "notEncrypted" | "invalid" };

export function decryptMessage(body: string, ctx: AadContext): DecryptResult {
  const env = parseMessageBody(body);
  if (!env) return { ok: false, reason: "notEncrypted" };
  const { header } = env;
  if (env.nonceCt.length <= NONCE_BYTES) return { ok: false, header, reason: "invalid" };
  try {
    const nonce = env.nonceCt.subarray(0, NONCE_BYTES);
    const ct = env.nonceCt.subarray(NONCE_BYTES);
    const padded = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, buildAad(ctx, env.headerBytes), nonce, channelKey(ctx.channelNodeId));
    const json = JSON.parse(fromUtf8(sodium.unpad(padded, PAD_BLOCK))) as Plaintext;
    if (typeof json.text !== "string" || typeof json.ts !== "number") return { ok: false, header, reason: "invalid" };
    return { ok: true, header, plaintext: { text: json.text, ts: json.ts, mentions: Array.isArray(json.mentions) ? json.mentions.map(String) : [] } };
  } catch {
    return { ok: false, header, reason: "invalid" };
  }
}
