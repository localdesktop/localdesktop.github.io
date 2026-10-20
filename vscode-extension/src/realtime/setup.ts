import * as vscode from "vscode";
import { LdError } from "../core/errors";
import type { Services } from "../extension/services";
import { withProgress } from "../extension/ui";
import { atLeast, type GitHubClient } from "../github/client";
import { proposeRepoConfig, type RepoDevConfig } from "./config";
import { Doorbell, type DoorbellProvider } from "./doorbell";
import { hookTargets, ntfyAppLink, ntfyWebhookUrl, randomTopic, WEBHOOK_EVENTS } from "./webhook";

/** Waits for a webhook ping to come back through the doorbell. */
function waitForPing(provider: DoorbellProvider, url: string, trigger: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let triggered = false;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bell.stop();
      resolve(ok);
    };
    const bell = new Doorbell({
      provider,
      url,
      onEvent: (ev) => {
        if (ev.ping && triggered) finish(true);
      },
      onStatus: (status) => {
        if (status === "live" && !triggered) {
          triggered = true;
          trigger().catch(() => finish(false));
        }
      },
      onReconnect: () => undefined,
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    bell.start();
  });
}

async function createSmeeChannel(): Promise<string> {
  const res = await fetch("https://smee.io/new", { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location || !/^https:\/\/smee\.io\/[A-Za-z0-9]+$/.test(location)) throw new LdError("COMMAND_FAILED", "Couldn't create a smee.io channel.");
  return location;
}

async function chooseTopicUrl(current: RepoDevConfig): Promise<{ provider: DoorbellProvider; url: string } | undefined> {
  const items: (vscode.QuickPickItem & { id: string })[] = [];
  if (current.realtime) {
    items.push({ id: "keep", label: "$(check) Keep the current doorbell", description: current.realtime.url, detail: "Re-create or repair the webhook for it." });
  }
  items.push(
    { id: "ntfy", label: "$(broadcast) ntfy.sh (recommended)", detail: "Free public relay. Many listeners per topic, and maintainers can subscribe on their phones." },
    { id: "custom", label: "$(server) Self-hosted ntfy server…", detail: "Your own ntfy instance (no shared quota)." },
    { id: "smee", label: "$(plug) smee.io", detail: "GitHub's webhook proxy for development; no phone notifications." },
  );
  const pick = await vscode.window.showQuickPick(items, { title: "Realtime relay for webhook pings", ignoreFocusOut: true });
  if (!pick) return undefined;
  switch (pick.id) {
    case "keep":
      return current.realtime;
    case "ntfy":
      return { provider: "ntfy", url: `https://ntfy.sh/${randomTopic()}` };
    case "custom": {
      const base = await vscode.window.showInputBox({
        title: "ntfy server URL",
        placeHolder: "https://ntfy.example.org",
        ignoreFocusOut: true,
        validateInput: (v) => (/^https:\/\/[^/\s]+\/?$/.test(v.trim()) ? undefined : "An https:// server URL without a path"),
      });
      return base ? { provider: "ntfy", url: `${base.trim().replace(/\/+$/, "")}/${randomTopic()}` } : undefined;
    }
    case "smee":
      return { provider: "smee", url: await createSmeeChannel() };
  }
  return undefined;
}

async function upsertHook(client: GitHubClient, target: { provider: DoorbellProvider; url: string }, previousUrl?: string): Promise<number> {
  const { rest, params } = client;
  const hookUrl = target.provider === "ntfy" ? ntfyWebhookUrl(target.url) : target.url;
  const hooks = await rest.paginate(rest.repos.listWebhooks, { ...params, per_page: 100 });
  const existing = hooks.find((h) => hookTargets(h.config.url, target.url) || (previousUrl && hookTargets(h.config.url, previousUrl)));
  // ntfy can't verify GitHub's HMAC, and the payload is only a doorbell, so no secret.
  const config = { url: hookUrl, content_type: "json" as const, insecure_ssl: "0" as const };
  if (existing) {
    await rest.repos.updateWebhook({ ...params, hook_id: existing.id, config, events: WEBHOOK_EVENTS, active: true });
    return existing.id;
  }
  const { data } = await rest.repos.createWebhook({ ...params, config, events: WEBHOOK_EVENTS, active: true });
  return data.id;
}

/**
 * `Local Desktop: Set Up Realtime Updates` (admins): creates or repairs the repository webhook,
 * verifies a ping arrives through the relay, and proposes the shared config in a pull request.
 */
export async function runRealtimeSetup(s: Services, current: RepoDevConfig, apply: (cfg: RepoDevConfig) => void): Promise<void> {
  const client = await s.upstream.client();
  if (!atLeast(client.repo.viewerPermission, "ADMIN")) {
    throw new LdError("COMMAND_FAILED", "Only repository admins can create webhooks.", "Ask an admin to run Local Desktop: Set Up Realtime Updates.");
  }
  const target = await chooseTopicUrl(current);
  if (!target) return;

  const result = await withProgress("Setting up realtime updates", async (progress) => {
    progress.report({ message: "Creating the repository webhook…" });
    const hookId = await upsertHook(client, target, current.realtime?.url);
    progress.report({ message: "Waiting for a test ping through the relay…" });
    const ok = await waitForPing(
      target.provider,
      target.url,
      async () => {
        await client.rest.repos.pingWebhook({ ...client.params, hook_id: hookId });
      },
      15_000,
    );
    let deliveries = "";
    if (!ok) {
      try {
        const { data } = await client.rest.repos.listWebhookDeliveries({ ...client.params, hook_id: hookId, per_page: 5 });
        deliveries = data.map((d) => `${d.event}: ${d.status_code} ${d.status}`).join("; ");
      } catch {
        // deliveries API unavailable
      }
    }
    return { ok, deliveries, hookId };
  });

  const next: RepoDevConfig = { ...current, version: 1, realtime: target };
  apply(next);
  if (!result.ok) {
    void vscode.window.showWarningMessage(
      `The webhook was saved, but no test ping arrived within 15 s.${result.deliveries ? ` Recent deliveries: ${result.deliveries}.` : ""} A 429 means the relay rate-limited GitHub; a 400 usually means a template error.`,
    );
  }

  const changed = current.realtime?.url !== target.url || current.realtime?.provider !== target.provider;
  let prUrl: string | undefined;
  if (changed) {
    const pr = await withProgress("Proposing the shared realtime config", () =>
      proposeRepoConfig(client, (cfg) => ({ ...cfg, version: 1, realtime: target }), {
        branch: "localdesktop/realtime-setup",
        title: "chore: configure realtime updates for the Local Desktop extension",
        body: [
          "Points maintainers' editors at the realtime doorbell for instant CI, release and chat updates.",
          "",
          `- Provider: ${target.provider}`,
          `- Topic: ${target.url}`,
          "",
          "The topic only carries public event metadata (which run/PR/discussion changed); chat messages stay end-to-end encrypted.",
        ].join("\n"),
      }),
    );
    prUrl = pr.url;
  }

  const actions = [...(prUrl ? ["Open Pull Request"] : []), ...(target.provider === "ntfy" ? ["Copy Phone Link"] : [])];
  const choice = await vscode.window.showInformationMessage(
    `Realtime updates ${result.ok ? "are live" : "are configured"}${prUrl ? ". Merge the pull request so every maintainer picks them up." : "."}`,
    ...actions,
  );
  if (choice === "Open Pull Request" && prUrl) await vscode.env.openExternal(vscode.Uri.parse(prUrl));
  if (choice === "Copy Phone Link") {
    await vscode.env.clipboard.writeText(ntfyAppLink(target.url));
    void vscode.window.showInformationMessage(`Copied ${ntfyAppLink(target.url)} — open it in the ntfy app (or subscribe to ${target.url}).`);
  }
}
