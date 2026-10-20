import * as vscode from "vscode";
import type { Services } from "../extension/services";
import { registerCommand } from "../extension/ui";
import { loadRepoConfig, type RepoDevConfig } from "./config";
import { Doorbell, type DoorbellStatus } from "./doorbell";
import { hintMatches, type RealtimeStatus } from "./hub";
import { Coalescer, PollScheduler } from "./scheduler";
import { runRealtimeSetup } from "./setup";
import { ntfyAppLink } from "./webhook";

/**
 * Keeps the doorbell subscription, the fallback poll timer and the status bar in sync with the
 * committed config, and funnels everything through a coalescer into `services.hub`.
 */
class RealtimeService implements vscode.Disposable {
  private config: RepoDevConfig = { version: 1 };
  private doorbell: Doorbell | undefined;
  private doorbellStatus: DoorbellStatus = "stopped";
  private detail: string | undefined;
  private lastEventAt: number | undefined;
  private readonly coalescer: Coalescer;
  private readonly scheduler: PollScheduler;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly s: Services) {
    this.coalescer = new Coalescer((hint) => s.hub.fire(hint));
    this.scheduler = new PollScheduler((hint) => this.coalescer.push(hint), {
      pollMs: () => vscode.workspace.getConfiguration("localdesktop").get<number>("realtime.pollSeconds", 60) * 1000,
    });
    this.statusItem = vscode.window.createStatusBarItem("localdesktop.realtime", vscode.StatusBarAlignment.Left, 49);
    this.statusItem.name = "Local Desktop Realtime";
    this.statusItem.command = "localdesktop.realtime.status";
    this.subs.push(
      vscode.window.onDidChangeWindowState((e) => this.scheduler.setFocused(e.focused)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("localdesktop.realtime")) void this.reload();
      }),
      s.upstream.onDidChange(() => void this.reload()),
      // Pick up a merged config change during routine refreshes (ETag-cached, so nearly free).
      s.hub.onHint((h) => {
        if (h.source === "timer" && hintMatches(h, "all")) void this.reload(true);
      }),
    );
    this.scheduler.setFocused(vscode.window.state.focused);
    this.scheduler.start();
  }

  get current(): RepoDevConfig {
    return this.config;
  }

  async reload(quiet = false): Promise<void> {
    const client = await this.s.upstream.tryClient();
    let cfg: RepoDevConfig;
    try {
      cfg = await loadRepoConfig(client, this.s.root);
    } catch (e) {
      if (!quiet) this.s.output.warn(`Realtime: couldn't read the config: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.apply(cfg, client !== undefined);
  }

  /** Applies a config immediately (also used by setup before its PR merges). */
  apply(cfg: RepoDevConfig, signedIn = true): void {
    const before = JSON.stringify(this.config.realtime);
    this.config = cfg;
    const enabled = vscode.workspace.getConfiguration("localdesktop").get<boolean>("realtime.enabled", true);
    const wanted = enabled && signedIn ? cfg.realtime : undefined;
    if (JSON.stringify(wanted) === before && this.doorbell && wanted) return;
    this.doorbell?.stop();
    this.doorbell = undefined;
    if (wanted) {
      this.doorbell = new Doorbell({
        provider: wanted.provider,
        url: wanted.url,
        onEvent: (ev) => {
          this.lastEventAt = Date.now();
          if (ev.scope) this.coalescer.push({ scope: ev.scope, source: "doorbell" });
        },
        onStatus: (status, detail) => {
          this.doorbellStatus = status;
          this.detail = detail;
          this.render();
        },
        onReconnect: () => this.coalescer.push({ scope: "all", source: "doorbell" }),
      });
      this.doorbell.start();
    } else {
      this.doorbellStatus = "stopped";
    }
    this.render();
  }

  private hubStatus(): RealtimeStatus {
    switch (this.doorbellStatus) {
      case "live":
        return "live";
      case "offline":
        return "offline";
      default:
        return "polling";
    }
  }

  private render(): void {
    const status = this.hubStatus();
    this.s.hub.setStatus(status);
    this.scheduler.setLive(status === "live");
    if (!this.config.realtime) {
      this.statusItem.hide();
      return;
    }
    const icon = { live: "$(radio-tower)", polling: "$(sync)", offline: "$(cloud-offline)" }[status];
    const label = { live: "Live", polling: "Polling", offline: "Offline" }[status];
    this.statusItem.text = `${icon} ${label}`;
    this.statusItem.tooltip = `Local Desktop realtime updates: ${label}${this.detail ? ` (${this.detail})` : ""}`;
    this.statusItem.show();
  }

  async showStatus(): Promise<void> {
    const cfg = this.config.realtime;
    const status = this.hubStatus();
    const last = this.lastEventAt ? `last ping ${Math.round((Date.now() - this.lastEventAt) / 1000)} s ago` : "no pings yet";
    const message = cfg
      ? `Realtime: ${status} via ${cfg.provider} (${last})${this.detail ? ` — ${this.detail}` : ""}.`
      : "Realtime updates aren't configured for this repository; views refresh by polling.";
    const actions = [cfg?.provider === "ntfy" ? "Copy Phone Link" : undefined, "Set Up…", "Refresh Now"].filter((x): x is string => Boolean(x));
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (choice === "Refresh Now") this.s.hub.fire({ scope: "all", source: "manual" });
    else if (choice === "Set Up…") await vscode.commands.executeCommand("localdesktop.realtime.setup");
    else if (choice === "Copy Phone Link" && cfg) {
      await vscode.env.clipboard.writeText(ntfyAppLink(cfg.url));
      void vscode.window.showInformationMessage(`Copied. Open it in the ntfy app, or subscribe to ${cfg.url}.`);
    }
  }

  dispose(): void {
    this.doorbell?.stop();
    this.scheduler.stop();
    this.coalescer.dispose();
    this.statusItem.dispose();
    this.subs.forEach((d) => d.dispose());
  }
}

let service: RealtimeService | undefined;

/** The committed config as last loaded (chat setup reads the category/keys discussion from it). */
export function realtimeConfig(): RepoDevConfig {
  return service?.current ?? { version: 1 };
}

/** Applies a config locally before its pull request merges. */
export function applyRealtimeConfig(cfg: RepoDevConfig): void {
  service?.apply(cfg);
}

/** Realtime doorbell (ntfy/smee) + refresh scheduler feeding the RealtimeHub. */
export function activateRealtime(s: Services): void {
  service = new RealtimeService(s);
  s.context.subscriptions.push(service);
  registerCommand(s.context, "localdesktop.realtime.status", () => service?.showStatus(), s.output);
  registerCommand(s.context, "localdesktop.realtime.setup", () => runRealtimeSetup(s, service?.current ?? { version: 1 }, (cfg) => service?.apply(cfg)), s.output);
  void service.reload();
}
