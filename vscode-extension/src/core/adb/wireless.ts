import { randomBytes } from "node:crypto";
import { LdError } from "../errors";
import type { Adb } from "./adb";

export type MdnsServiceType = "pairing" | "connect" | "adb";

export interface MdnsService {
  name: string;
  type: MdnsServiceType;
  /** host:port */
  address: string;
  host: string;
  port: number;
}

function serviceType(raw: string): MdnsServiceType | undefined {
  const t = raw.replace(/\.$/, "");
  if (t === "_adb-tls-pairing._tcp") return "pairing";
  if (t === "_adb-tls-connect._tcp") return "connect";
  if (t === "_adb._tcp") return "adb";
  return undefined;
}

/** Parses `adb mdns services` (tab- or space-separated: name, type, address). */
export function parseMdnsServices(output: string): MdnsService[] {
  const services: MdnsService[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const type = serviceType(parts[1]!);
    const m = /^\[?([0-9a-fA-F.:]+?)\]?:(\d+)$/.exec(parts[2]!);
    if (!type || !m) continue;
    services.push({ name: parts[0]!, type, address: parts[2]!, host: m[1]!, port: parseInt(m[2]!, 10) });
  }
  return services;
}

/** `adb mdns check` prints "mdns daemon version …" when discovery works. */
export function parseMdnsCheck(output: string): boolean {
  return /mdns daemon version/i.test(output) && !/unavailable/i.test(output);
}

export interface PairResult {
  ok: boolean;
  message: string;
  guid?: string;
}

/** Parses `adb pair host:port code`. */
export function parsePairResult(output: string): PairResult {
  const text = output.trim();
  const ok = /Successfully paired/i.test(text);
  return { ok, message: text, guid: /\[guid=([^\]]+)\]/.exec(text)?.[1] };
}

export interface ConnectResult {
  ok: boolean;
  already: boolean;
  message: string;
}

/** Parses `adb connect host:port` (exit status is 0 even on failure). */
export function parseConnectResult(output: string): ConnectResult {
  const text = output.trim();
  const already = /already connected to/i.test(text);
  const ok = already || (/^connected to/im.test(text) && !/failed|cannot|unable/i.test(text));
  return { ok, already, message: text };
}

/** `adb forward tcp:0 …` prints the allocated local port. */
export function parseForwardPort(output: string): number | undefined {
  const m = /^\s*(\d{1,5})\s*$/m.exec(output);
  const port = m ? parseInt(m[1]!, 10) : NaN;
  return port > 0 && port < 65536 ? port : undefined;
}

/** First IPv4 address in `ip -f inet addr show wlan0`. */
export function parseWlanIp(output: string): string | undefined {
  return /\binet\s+(\d+\.\d+\.\d+\.\d+)\//.exec(output)?.[1];
}

export function isHostPort(s: string): boolean {
  return /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(s.trim());
}

export function randomPairingName(): string {
  return `localdesktop-${randomBytes(3).toString("hex")}`;
}

/** Pairing password for the QR flow (alphanumeric; adb accepts any string). */
export function randomPairingPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join("");
}

/** Payload Android's "Pair device with QR code" scanner expects. */
export function pairingQrPayload(name: string, password: string): string {
  return `WIFI:T:ADB;S:${name};P:${password};;`;
}

export async function mdnsAvailable(adb: Adb): Promise<boolean> {
  const out = await adb.run(["mdns", "check"], { allowFailure: true, timeoutMs: 10_000 });
  return parseMdnsCheck(out);
}

export async function mdnsServices(adb: Adb): Promise<MdnsService[]> {
  return parseMdnsServices(await adb.run(["mdns", "services"], { allowFailure: true, timeoutMs: 10_000 }));
}

export async function pairDevice(adb: Adb, address: string, code: string): Promise<PairResult> {
  const res = await adb.exec(["pair", address, code], { allowFailure: true, timeoutMs: 60_000 });
  const result = parsePairResult(`${res.stdout.toString("utf8")}\n${res.stderr}`);
  if (!result.ok) {
    throw new LdError("COMMAND_FAILED", `Pairing with ${address} failed: ${result.message || "no response"}`, "Check the code and that both devices are on the same network.");
  }
  return result;
}

export async function connectDevice(adb: Adb, address: string): Promise<ConnectResult> {
  const res = await adb.exec(["connect", address], { allowFailure: true, timeoutMs: 30_000 });
  const result = parseConnectResult(`${res.stdout.toString("utf8")}\n${res.stderr}`);
  if (!result.ok) {
    throw new LdError("COMMAND_FAILED", `Couldn't connect to ${address}: ${result.message}`, "Is Wireless debugging still on? The port changes each time it's toggled.");
  }
  return result;
}

export async function disconnectDevice(adb: Adb, serial: string): Promise<void> {
  await adb.run(["disconnect", serial], { allowFailure: true, timeoutMs: 15_000 });
}
