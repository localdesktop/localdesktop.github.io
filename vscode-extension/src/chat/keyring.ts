import type * as vscode from "vscode";
import { deserializeDeviceKeys, generateDeviceKeys, serializeDeviceKeys, type DeviceKeys } from "./crypto";
import { b64u, fromB64u } from "./protocol";
import type { UnwrappedKey } from "./keystate";

/**
 * This editor's chat identity and unwrapped epoch keys, kept in SecretStorage (OS keychain) per
 * repository. Keys never leave the extension host.
 */
export class Keyring {
  private device: DeviceKeys | undefined;
  private keys: Map<string, UnwrappedKey> | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly repoNodeId: string,
  ) {}

  private get deviceKey(): string {
    return `ld.chat.${this.repoNodeId}.device`;
  }

  private get keyringKey(): string {
    return `ld.chat.${this.repoNodeId}.keyring`;
  }

  async getDevice(): Promise<DeviceKeys | undefined> {
    if (this.device) return this.device;
    const text = await this.secrets.get(this.deviceKey);
    this.device = text ? deserializeDeviceKeys(text) : undefined;
    return this.device;
  }

  async getOrCreateDevice(): Promise<{ device: DeviceKeys; created: boolean }> {
    const existing = await this.getDevice();
    if (existing) return { device: existing, created: false };
    const device = generateDeviceKeys();
    await this.secrets.store(this.deviceKey, serializeDeviceKeys(device));
    this.device = device;
    return { device, created: true };
  }

  async getKeys(): Promise<UnwrappedKey[]> {
    if (!this.keys) {
      this.keys = new Map();
      const text = await this.secrets.get(this.keyringKey);
      if (text) {
        try {
          for (const k of JSON.parse(text) as { kid: string; ep: number; key: string }[]) {
            this.keys.set(k.kid, { kid: k.kid, ep: k.ep, key: fromB64u(k.key) });
          }
        } catch {
          // corrupt keyring: start over, grants will be re-read from the keys discussion
        }
      }
    }
    return [...this.keys.values()];
  }

  async key(kid: string): Promise<Uint8Array | undefined> {
    await this.getKeys();
    return this.keys!.get(kid)?.key;
  }

  keySync(kid: string): Uint8Array | undefined {
    return this.keys?.get(kid)?.key;
  }

  /** Adds keys; returns how many were new. */
  async addKeys(entries: UnwrappedKey[]): Promise<number> {
    await this.getKeys();
    let added = 0;
    for (const e of entries) {
      if (!this.keys!.has(e.kid)) {
        this.keys!.set(e.kid, e);
        added++;
      }
    }
    if (added) {
      await this.secrets.store(this.keyringKey, JSON.stringify([...this.keys!.values()].map((k) => ({ kid: k.kid, ep: k.ep, key: b64u(k.key) }))));
    }
    return added;
  }

  /** Forget this device (e.g. after revoking it). */
  async reset(): Promise<void> {
    this.device = undefined;
    this.keys = new Map();
    await this.secrets.delete(this.deviceKey);
    await this.secrets.delete(this.keyringKey);
  }
}
