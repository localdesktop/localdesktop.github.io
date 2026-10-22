import * as vscode from "vscode";
import { LdError } from "../core/errors";
import type { Services } from "../extension/services";
import { withProgress } from "../extension/ui";
import { atLeast, type GitHubClient } from "../github/client";
import { applyRealtimeConfig, realtimeConfig } from "../realtime";
import { loadRepoConfig, proposeRepoConfig } from "../realtime/config";
import { cryptoReady } from "./crypto";
import { DiscussionsApi, type DiscussionCategory, type DiscussionSummary } from "./discussionsApi";
import { KeyDirectory } from "./keyDirectory";
import { Keyring } from "./keyring";
import { permissionAtLeast } from "./keystate";
import { channelBody, keysBody, parseDiscussionMarker } from "./protocol";

const CATEGORY_NAME = "Chat";
const CATEGORY_SLUG = "chat";

async function enableDiscussions(s: Services, client: GitHubClient): Promise<GitHubClient> {
  if (client.repo.hasDiscussions) return client;
  const ok = await vscode.window.showWarningMessage(
    `Enable GitHub Discussions for ${client.repo.fullName}? The chat lives in a Discussions category of this public repository: channel names, who posted and when are visible to everyone, while private channels' messages are end-to-end encrypted. GitHub also creates default categories (General, Q&A, Ideas…) that the community can use; you can delete them on GitHub afterwards.`,
    { modal: true },
    "Enable Discussions",
  );
  if (!ok) throw new LdError("CANCELLED", "Setup cancelled.");
  await client.rest.repos.update({ ...client.params, has_discussions: true });
  const refreshed = await s.upstream.refreshRepo();
  if (!refreshed?.repo.hasDiscussions) throw new LdError("COMMAND_FAILED", "Discussions still look disabled; try again in a moment.");
  return refreshed;
}

/** There's no API to create discussion categories: guide the admin through the web UI and poll. */
async function ensureCategory(api: DiscussionsApi, client: GitHubClient, slug: string): Promise<DiscussionCategory> {
  const find = async () => (await api.categories()).find((c) => c.slug === slug || c.name.toLowerCase() === slug);
  const existing = await find();
  if (existing) return existing;
  const url = `https://github.com/${client.repo.fullName}/discussions/categories/new`;
  await vscode.env.clipboard.writeText(CATEGORY_NAME);
  await vscode.env.openExternal(vscode.Uri.parse(url));
  return withProgress("Waiting for the Chat discussion category", async (progress, token) => {
    progress.report({ message: `On GitHub: Name “${CATEGORY_NAME}” (copied), Format “Announcement”, then Create.` });
    let checkNow: () => void = () => undefined;
    void vscode.window
      .showInformationMessage(
        `Create a discussion category named “${CATEGORY_NAME}” with the “Announcement” format (only maintainers can start discussions there). The name is on your clipboard.`,
        "I've Created It",
        "Open Page Again",
      )
      .then((choice) => {
        if (choice === "Open Page Again") void vscode.env.openExternal(vscode.Uri.parse(url));
        checkNow();
      });
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (token.isCancellationRequested) throw new LdError("CANCELLED", "Setup cancelled.");
      const found = await find();
      if (found) return found;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
        checkNow = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    throw new LdError("TIMEOUT", "The Chat category didn't appear within 10 minutes.", "Create it on GitHub and run the setup again.");
  });
}

async function ensureDiscussion(
  api: DiscussionsApi,
  category: DiscussionCategory,
  match: (d: DiscussionSummary) => boolean,
  create: { title: string; body: string },
): Promise<DiscussionSummary> {
  const all = await api.discussions(category.id);
  for (const d of all) {
    if (match(d) && permissionAtLeast(await api.permission(d.author), "write")) {
      if (!d.locked) await api.lock(d.id);
      return d;
    }
  }
  const d = await api.createDiscussion(category.id, create.title, create.body);
  await api.lock(d.id);
  // GitHub would email the creator about every comment; the extension notifies instead.
  await api.setSubscribed(d.id, false).catch(() => undefined);
  return d;
}

/**
 * `Local Desktop: Set Up Maintainer Chat` (admins). Every step finds existing pieces by their
 * markers, so it's safe to re-run.
 */
export async function runChatSetup(s: Services, onDone: () => Promise<void>): Promise<void> {
  let client = await s.upstream.client();
  if (!atLeast(client.repo.viewerPermission, "ADMIN")) {
    throw new LdError("COMMAND_FAILED", "Only repository admins can set up the chat.", "Ask an admin to run Local Desktop: Set Up Maintainer Chat.");
  }
  client = await enableDiscussions(s, client);
  const api = new DiscussionsApi(client);
  const cfg = { ...(await loadRepoConfig(client, s.root)), ...(realtimeConfig().chat ? { chat: realtimeConfig().chat } : {}) };
  const slug = cfg.chat?.category ?? CATEGORY_SLUG;
  const category = await ensureCategory(api, client, slug);

  const { keysDiscussion, general } = await withProgress("Setting up the maintainer chat", async (progress) => {
    progress.report({ message: "Key directory…" });
    const keysDiscussion = await ensureDiscussion(api, category, (d) => parseDiscussionMarker(d.body)?.kind === "keys", { title: "🔑 Chat keys", body: keysBody() });
    progress.report({ message: "Registering this device and creating the first key…" });
    await cryptoReady();
    const directory = new KeyDirectory(api, new Keyring(s.context.secrets, client.repo.nodeId), keysDiscussion.id, s.output);
    try {
      await directory.initialize();
    } finally {
      directory.dispose();
    }
    progress.report({ message: "#general channel…" });
    const general = await ensureDiscussion(api, category, (d) => parseDiscussionMarker(d.body)?.kind === "channel", { title: "#general", body: channelBody("private") });
    return { keysDiscussion, general };
  });

  let prUrl: string | undefined;
  if (cfg.chat?.category !== category.slug || cfg.chat?.keysDiscussion !== keysDiscussion.number) {
    const chat = { category: category.slug, keysDiscussion: keysDiscussion.number };
    applyRealtimeConfig({ ...realtimeConfig(), version: 1, chat });
    const pr = await proposeRepoConfig(client, (c) => ({ ...c, version: 1, chat }), {
      branch: "localdesktop/chat-setup",
      title: "chore: configure the maintainer chat for the Local Desktop extension",
      body: `Points maintainers' editors at the chat in the **${category.name}** discussion category (key directory: #${keysDiscussion.number}).`,
    });
    prUrl = pr.url;
  }
  await onDone();
  const choice = await vscode.window.showInformationMessage(
    `The maintainer chat is ready (${general.title}). Other maintainers get access automatically when they open the chat.${prUrl ? " Merge the config pull request so everyone uses the same category." : ""}`,
    ...(prUrl ? ["Open Pull Request"] : []),
    "Open Chat",
    "Review Categories",
  );
  if (choice === "Open Pull Request" && prUrl) await vscode.env.openExternal(vscode.Uri.parse(prUrl));
  else if (choice === "Open Chat") await vscode.commands.executeCommand("localdesktop.chat.focus");
  else if (choice === "Review Categories") await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${client.repo.fullName}/discussions/categories`));
}
