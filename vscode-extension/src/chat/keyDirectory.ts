import * as vscode from "vscode";
import { LdError } from "../core/errors";
import { deviceRecordBody, fingerprint, grantRecordBody, kidOf, newEpochKey, revokeRecordBody, type GrantTarget } from "./crypto";
import type { DiscussionsApi } from "./discussionsApi";
import type { Keyring } from "./keyring";
import {
  currentEpoch,
  grantJitterMs,
  pendingDevices,
  permissionAtLeast,
  processKeyComments,
  staleHolders,
  unwrapKeys,
  type AcceptedDevice,
  type DirectoryState,
} from "./keystate";
import type { EncryptionInfo } from "../shared/messages";


const STALE_CHECK_MS = 6 * 60 * 60_000;

export function deviceName(): string {
  const os = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return `${vscode.env.appName} on ${os}`;
}

/**
 * The locked "keys" discussion as seen by this editor: registers this device, unwraps keys granted
 * to it, shares the key with new maintainer devices, and rotates when someone loses access.
 */
export class KeyDirectory implements vscode.Disposable {
  private state: DirectoryState | undefined;
  private postedOwnDevice = false;
  private grantTimer: NodeJS.Timeout | undefined;
  private stale: AcceptedDevice[] = [];
  private staleCheckedAt = 0;
  private syncing: Promise<void> | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly api: DiscussionsApi,
    private readonly keyring: Keyring,
    private readonly keysDiscussionId: string,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  private get repoNodeId(): string {
    return this.api.client.repo.nodeId;
  }

  private get viewer(): string {
    return this.api.client.repo.viewerLogin;
  }

  sync(opts: { checkStale?: boolean } = {}): Promise<void> {
    this.syncing ??= this.doSync(opts).finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async doSync(opts: { checkStale?: boolean }): Promise<void> {
    const comments = await this.api.keyComments(this.keysDiscussionId);
    this.state = await processKeyComments(comments, { repoNodeId: this.repoNodeId, permission: (l) => this.api.permission(l) });
    for (const r of this.state.rejected) this.output.debug(`chat keys: ignored record ${r.commentId}: ${r.reason}`);

    const device = await this.keyring.getDevice();
    if (device) {
      const added = await this.keyring.addKeys(unwrapKeys(this.state, device, await this.keyring.getKeys()));
      if (added) this.output.info(`chat: unlocked ${added} key epoch(s)`);
    }
    const epoch = currentEpoch(this.state);
    if (epoch && (opts.checkStale || Date.now() - this.staleCheckedAt > STALE_CHECK_MS)) {
      this.staleCheckedAt = Date.now();
      this.stale = await staleHolders(this.state, epoch.kid, (l) => this.api.permission(l));
    }
    this.scheduleAutoGrant();
    this.changed.fire();
  }

  get directory(): DirectoryState | undefined {
    return this.state;
  }

  /** Ed25519 key of an accepted, unrevoked device belonging to `login`. */
  signPkFor(login: string, deviceId: string): Uint8Array | undefined {
    const d = this.state?.devices.get(deviceId);
    return d && !d.revoked && d.login.toLowerCase() === login.toLowerCase() ? d.signPk : undefined;
  }

  /** The current epoch and its key, if this device holds it. */
  currentKey(): { ep: number; kid: string; key: Uint8Array } | undefined {
    const epoch = this.state ? currentEpoch(this.state) : undefined;
    if (!epoch) return undefined;
    const key = this.keyring.keySync(epoch.kid);
    return key ? { ...epoch, key } : undefined;
  }

  async info(): Promise<EncryptionInfo> {
    const canWrite = permissionAtLeast(await this.api.permission(this.viewer), "write");
    const device = await this.keyring.getDevice();
    const epoch = this.state ? currentEpoch(this.state) : undefined;
    const devices = this.state ? [...this.state.devices.values()].filter((d) => !d.revoked) : [];
    const base = {
      recipients: new Set(devices.map((d) => d.login.toLowerCase())).size,
      devices: devices.length,
      fingerprint: device ? fingerprint(device.signPk, device.encPk) : undefined,
      rotateNeeded: this.stale.length ? [...new Set(this.stale.map((d) => d.login))] : undefined,
    };
    if (!canWrite) return { ...base, status: "notMember" };
    if (!epoch) return { ...base, status: "noKey" };
    if (this.currentKey()) return { ...base, status: "ready" };
    return { ...base, status: device ? "waiting" : "noKey" };
  }

  /** Posts this device's public keys if it isn't registered yet (needs write access). */
  async ensureRegistered(): Promise<boolean> {
    if (!this.state) await this.sync();
    if (!permissionAtLeast(await this.api.permission(this.viewer), "write")) return false;
    const { device, created } = await this.keyring.getOrCreateDevice();
    const registered = this.state!.devices.get(device.deviceId);
    if (registered) return !registered.revoked;
    if (this.postedOwnDevice && !created) return true;
    await this.api.addComment(this.keysDiscussionId, deviceRecordBody(device, this.viewer, this.repoNodeId, deviceName()));
    this.postedOwnDevice = true;
    this.output.info(`chat: registered this device (${fingerprint(device.signPk, device.encPk)})`);
    await this.sync();
    return true;
  }

  /** Setup only: creates epoch 1 and grants it to this device. */
  async initialize(): Promise<void> {
    await this.sync();
    await this.ensureRegistered();
    if (this.state && currentEpoch(this.state)) return;
    const device = (await this.keyring.getDevice())!;
    const key = newEpochKey();
    const { body } = grantRecordBody({
      me: device,
      login: this.viewer,
      repoNodeId: this.repoNodeId,
      ep: 1,
      epochKey: key,
      reason: "init",
      to: [{ login: this.viewer, dev: device.deviceId, encPk: device.encPk }],
    });
    await this.api.addComment(this.keysDiscussionId, body);
    await this.keyring.addKeys([{ kid: kidOf(key), ep: 1, key }]);
    await this.sync();
  }

  private eligible(): Promise<AcceptedDevice[]> {
    const devices = [...(this.state?.devices.values() ?? [])].filter((d) => !d.revoked);
    return Promise.all(devices.map(async (d) => ((await permissionAtLeast(await this.api.permission(d.login), "write")) ? d : undefined))).then((xs) =>
      xs.filter((d): d is AcceptedDevice => Boolean(d)),
    );
  }

  /**
   * When this device holds the current key and others are waiting, post one batched "join" grant
   * after a per-pair jitter (so several online maintainers don't all answer at once).
   */
  private scheduleAutoGrant(): void {
    if (this.grantTimer) return;
    const current = this.currentKey();
    if (!current || !this.state) return;
    void this.keyring.getDevice().then((me) => {
      if (!me || !this.state) return;
      const pending = pendingDevices(this.state, current.kid).filter((d) => d.dev !== me.deviceId);
      if (!pending.length) return;
      const delay = Math.min(...pending.map((d) => grantJitterMs(me.deviceId, d.dev)));
      this.grantTimer = setTimeout(() => {
        this.grantTimer = undefined;
        void this.grantPending().catch((e) => this.output.warn(`chat: auto-grant failed: ${e instanceof Error ? e.message : String(e)}`));
      }, delay);
    });
  }

  private async grantPending(): Promise<void> {
    await this.sync();
    const current = this.currentKey();
    const me = await this.keyring.getDevice();
    if (!current || !me || !this.state) return;
    const eligible = new Set((await this.eligible()).map((d) => d.dev));
    let pending = pendingDevices(this.state, current.kid).filter((d) => d.dev !== me.deviceId && eligible.has(d.dev));
    if (!pending.length) return;
    const mode = vscode.workspace.getConfiguration("localdesktop").get<string>("chat.autoGrant", "members");
    if (mode === "prompt") {
      const picks = await vscode.window.showQuickPick(
        pending.map((d) => ({ label: `@${d.login}`, description: d.name, detail: `Fingerprint ${d.fingerprint}`, picked: true, device: d })),
        { title: "Share the chat key with these maintainer devices?", canPickMany: true, ignoreFocusOut: true },
      );
      if (!picks?.length) return;
      pending = picks.map((p) => p.device);
    }
    const { body } = grantRecordBody({
      me,
      login: this.viewer,
      repoNodeId: this.repoNodeId,
      ep: current.ep,
      epochKey: current.key,
      reason: "join",
      to: pending.map((d): GrantTarget => ({ login: d.login, dev: d.dev, encPk: d.encPk })),
    });
    await this.api.addComment(this.keysDiscussionId, body);
    void vscode.window.showInformationMessage(
      `Shared the chat key with ${pending.map((d) => `@${d.login} (${d.name}, ${d.fingerprint.slice(0, 17)}…)`).join(", ")}.`,
    );
    await this.sync();
  }

  /** New epoch for all current maintainers' devices, linked to the previous one (or not, for reinit). */
  async rotate(reason: "rotate" | "reinit" = "rotate"): Promise<void> {
    await this.sync({ checkStale: true });
    const me = await this.keyring.getDevice();
    if (!me || !this.state) throw new LdError("COMMAND_FAILED", "This device isn't registered for chat yet.");
    const current = this.currentKey();
    if (reason === "rotate" && !current) {
      throw new LdError("COMMAND_FAILED", "This device doesn't hold the current chat key, so it can't rotate it.", "Ask a maintainer who can read the chat, or (admins) re-initialize.");
    }
    const epoch = currentEpoch(this.state);
    const key = newEpochKey();
    const recipients = await this.eligible();
    const { body } = grantRecordBody({
      me,
      login: this.viewer,
      repoNodeId: this.repoNodeId,
      ep: (epoch?.ep ?? 0) + 1,
      epochKey: key,
      reason,
      to: recipients.map((d) => ({ login: d.login, dev: d.dev, encPk: d.encPk })),
      prevKey: reason === "rotate" ? current!.key : undefined,
    });
    await this.api.addComment(this.keysDiscussionId, body);
    await this.keyring.addKeys([{ kid: kidOf(key), ep: (epoch?.ep ?? 0) + 1, key }]);
    this.stale = [];
    await this.sync();
  }

  async revoke(device: AcceptedDevice, reason?: string): Promise<void> {
    const me = await this.keyring.getDevice();
    if (!me) throw new LdError("COMMAND_FAILED", "This device isn't registered for chat.");
    await this.api.addComment(this.keysDiscussionId, revokeRecordBody(me, this.viewer, this.repoNodeId, device.dev, reason));
    await this.sync({ checkStale: true });
  }

  /** `Local Desktop: Manage Chat Devices`. */
  async manage(): Promise<void> {
    await this.sync();
    const me = await this.keyring.getDevice();
    const canMaintain = permissionAtLeast(await this.api.permission(this.viewer), "maintain");
    const devices = [...(this.state?.devices.values() ?? [])];
    const pick = await vscode.window.showQuickPick(
      devices.map((d) => ({
        label: `${d.revoked ? "$(circle-slash)" : "$(key)"} @${d.login} — ${d.name}${me?.deviceId === d.dev ? " (this device)" : ""}`,
        description: d.revoked ? "revoked" : new Date(d.ts).toLocaleDateString(),
        detail: `Fingerprint ${d.fingerprint}`,
        device: d,
      })),
      { title: "Chat devices (compare fingerprints with their owners)", matchOnDetail: true },
    );
    if (!pick || pick.device.revoked) return;
    const own = pick.device.login.toLowerCase() === this.viewer.toLowerCase();
    if (!own && !canMaintain) return;
    const ok = await vscode.window.showWarningMessage(
      `Revoke ${pick.device.name} of @${pick.device.login}? It will stop receiving new keys; rotate the key afterwards so it can't read new messages.`,
      { modal: true },
      "Revoke and Rotate",
      "Revoke Only",
    );
    if (!ok) return;
    await this.revoke(pick.device, own ? "revoked by owner" : "revoked by maintainer");
    if (ok === "Revoke and Rotate") await this.rotate();
    if (me && pick.device.dev === me.deviceId) await this.keyring.reset();
  }

  dispose(): void {
    if (this.grantTimer) clearTimeout(this.grantTimer);
    this.changed.dispose();
  }
}
