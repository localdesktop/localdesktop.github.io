import * as fs from "node:fs";
import * as path from "node:path";
import type { GitHubClient } from "../github/client";
import type { DoorbellProvider } from "./doorbell";

/** Committed maintainer-tooling config, read from the default branch. */
export const CONFIG_PATH = ".github/localdesktop-dev.json";

export interface RepoDevConfig {
  version: 1;
  realtime?: { provider: DoorbellProvider; url: string };
  chat?: { category: string; keysDiscussion?: number };
}

export function parseRepoConfig(text: string): RepoDevConfig | undefined {
  try {
    const j = JSON.parse(text) as any;
    if (!j || typeof j !== "object") return undefined;
    const cfg: RepoDevConfig = { version: 1 };
    if (j.realtime && (j.realtime.provider === "ntfy" || j.realtime.provider === "smee") && typeof j.realtime.url === "string" && /^https:\/\//.test(j.realtime.url)) {
      cfg.realtime = { provider: j.realtime.provider, url: j.realtime.url };
    }
    if (j.chat && typeof j.chat.category === "string") {
      cfg.chat = { category: j.chat.category, keysDiscussion: typeof j.chat.keysDiscussion === "number" ? j.chat.keysDiscussion : undefined };
    }
    return cfg;
  } catch {
    return undefined;
  }
}

/** Default branch first (what everyone shares), then the local checkout. */
export async function loadRepoConfig(client: GitHubClient | undefined, root: string | undefined): Promise<RepoDevConfig> {
  if (client) {
    try {
      const { data } = await client.rest.repos.getContent({ ...client.params, path: CONFIG_PATH, ref: client.repo.defaultBranch });
      if (!Array.isArray(data) && data.type === "file" && "content" in data) {
        const cfg = parseRepoConfig(Buffer.from(data.content, "base64").toString("utf8"));
        if (cfg) return cfg;
      }
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }
  if (root) {
    try {
      const cfg = parseRepoConfig(fs.readFileSync(path.join(root, CONFIG_PATH), "utf8"));
      if (cfg) return cfg;
    } catch {
      // no local file
    }
  }
  return { version: 1 };
}

export function serializeRepoConfig(cfg: RepoDevConfig): string {
  return JSON.stringify(cfg, null, 2) + "\n";
}

/**
 * Commits an updated config file on a new branch through the Git Data API (the working tree and
 * current branch are never touched) and opens a pull request. Tooling-only PRs need no release label.
 */
export async function proposeRepoConfig(
  client: GitHubClient,
  mutate: (cfg: RepoDevConfig) => RepoDevConfig,
  opts: { branch: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  const { rest, params, repo } = client;
  const base = repo.defaultBranch;
  const current = await loadRepoConfig(client, undefined);
  const next = mutate(structuredClone(current));
  const { data: ref } = await rest.git.getRef({ ...params, ref: `heads/${base}` });
  const { data: baseCommit } = await rest.git.getCommit({ ...params, commit_sha: ref.object.sha });
  const { data: blob } = await rest.git.createBlob({ ...params, content: serializeRepoConfig(next), encoding: "utf-8" });
  const { data: tree } = await rest.git.createTree({
    ...params,
    base_tree: baseCommit.tree.sha,
    tree: [{ path: CONFIG_PATH, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const { data: commit } = await rest.git.createCommit({ ...params, message: opts.title, tree: tree.sha, parents: [ref.object.sha] });
  let branch = opts.branch;
  for (let i = 2; ; i++) {
    try {
      await rest.git.createRef({ ...params, ref: `refs/heads/${branch}`, sha: commit.sha });
      break;
    } catch (e) {
      if ((e as { status?: number }).status !== 422 || i > 20) throw e;
      branch = `${opts.branch}-${i}`;
    }
  }
  const { data: pr } = await rest.pulls.create({ ...params, head: branch, base, title: opts.title, body: opts.body });
  return { number: pr.number, url: pr.html_url };
}
