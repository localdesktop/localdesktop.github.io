import { graphql as baseGraphql } from "@octokit/graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import * as vscode from "vscode";
import { LdError } from "../core/errors";
import { originRepo } from "../core/gitRemote";
import type { GitHubAuth } from "./auth";
import { EtagCache } from "./etagCache";

const ThrottledOctokit = Octokit.plugin(throttling, retry);
export type RestClient = InstanceType<typeof ThrottledOctokit>;
export type GraphqlClient = typeof baseGraphql;

export type RepoPermission = "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" | "NONE";

export interface RepoInfo {
  owner: string;
  name: string;
  /** Canonical "owner/name" after redirects (the `origin` remote may use an old name). */
  fullName: string;
  nodeId: string;
  defaultBranch: string;
  hasDiscussions: boolean;
  viewerPermission: RepoPermission;
  viewerLogin: string;
  viewerAvatarUrl: string;
}

export interface GitHubClient {
  rest: RestClient;
  graphql: GraphqlClient;
  repo: RepoInfo;
  /** owner/repo params for REST calls. */
  params: { owner: string; repo: string };
}

/** The main Local Desktop repository. Chat and realtime always live here, even in a fork. */
export const UPSTREAM_REPO = "localdesktop/localdesktop.github.io";

/**
 * The repository the Releases & CI and Website views work on: the localdesktop.repository setting,
 * else the GitHub repo of the workspace's `origin` remote (so a fork uses its own repo).
 */
export async function workspaceRepo(root: string | undefined): Promise<string> {
  const setting = vscode.workspace.getConfiguration("localdesktop").get<string>("repository")?.trim();
  if (setting) return setting;
  return (root ? await originRepo(root) : undefined) ?? UPSTREAM_REPO;
}

export interface GitHubOptions {
  auth: GitHubAuth;
  /** "owner/name" of the repository this client works on. */
  repo: () => Promise<string>;
  /** Prefix of the signedIn / canWrite / canMaintain / isAdmin context keys. */
  contextPrefix: string;
  /** Re-resolve the repository when this setting changes. */
  repoSetting?: string;
}

const RANK: Record<RepoPermission, number> = { NONE: 0, READ: 1, TRIAGE: 2, WRITE: 3, MAINTAIN: 4, ADMIN: 5 };
export function atLeast(p: RepoPermission | undefined, min: RepoPermission): boolean {
  return RANK[p ?? "NONE"] >= RANK[min];
}

/**
 * Signed-in GitHub access for one repository. Resolves the canonical repo once per session, sets
 * the `<prefix>.signedIn / canWrite / canMaintain / isAdmin` context keys, and wraps REST GETs in an
 * ETag cache. The sign-in (auth) is shared between instances.
 */
export class GitHub implements vscode.Disposable {
  readonly auth: GitHubAuth;
  private clientPromise: Promise<GitHubClient | undefined> | undefined;
  private readonly etags = new EtagCache();
  private readonly changed = new vscode.EventEmitter<GitHubClient | undefined>();
  /** Fires after sign-in/out or a repository change, with the new client (or undefined). */
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly output: vscode.LogOutputChannel,
    private readonly opts: GitHubOptions,
  ) {
    this.auth = opts.auth;
    this.subs.push(
      this.auth.onDidChange(() => this.reset()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (opts.repoSetting && e.affectsConfiguration(opts.repoSetting)) this.reset();
      }),
    );
  }

  private reset(): void {
    this.clientPromise = undefined;
    this.etags.clear();
    void this.tryClient().then((c) => this.changed.fire(c));
  }

  /** The client if signed in, else undefined (never prompts). */
  tryClient(): Promise<GitHubClient | undefined> {
    this.clientPromise ??= this.create().catch((e) => {
      this.output.warn(`GitHub: ${e instanceof Error ? e.message : String(e)}`);
      this.clientPromise = undefined;
      void this.setContextKeys(undefined);
      return undefined;
    });
    return this.clientPromise;
  }

  /** The client, prompting to sign in when needed. Throws CANCELLED if the user declines. */
  async client(): Promise<GitHubClient> {
    const existing = await this.tryClient();
    if (existing) return existing;
    const session = await this.auth.signIn();
    if (!session) throw new LdError("CANCELLED", "Not signed in to GitHub.");
    this.clientPromise = undefined;
    const c = await this.tryClient();
    if (!c) throw new LdError("COMMAND_FAILED", "Couldn't connect to GitHub with that account.", "Check the Local Desktop output for details.");
    return c;
  }

  private async create(): Promise<GitHubClient | undefined> {
    const session = await this.auth.current();
    if (!session) {
      await this.setContextKeys(undefined);
      return undefined;
    }
    const output = this.output;
    const rest = new ThrottledOctokit({
      auth: session.token,
      userAgent: "localdesktop-vscode",
      throttle: {
        onRateLimit: (retryAfter, options, _o, retryCount) => {
          output.warn(`GitHub rate limit hit for ${options.method} ${options.url}; retry in ${retryAfter}s`);
          return retryCount < 1;
        },
        onSecondaryRateLimit: (retryAfter, options) => {
          output.warn(`GitHub secondary rate limit for ${options.method} ${options.url}; retry in ${retryAfter}s`);
          return false;
        },
      },
    });
    this.installEtagHook(rest);
    const graphql = baseGraphql.defaults({ headers: { authorization: `token ${session.token}` } });

    const slug = await this.opts.repo();
    const [owner, name] = slug.split("/");
    if (!owner || !name) throw new LdError("INVALID_ARGUMENT", `localdesktop.repository must be owner/name, got "${slug}"`);
    // REST follows renames (localdesktop/localdesktop → localdesktop.github.io); use the canonical name afterwards.
    const { data } = await rest.repos.get({ owner, repo: name });
    const viewer = await graphql<{ viewer: { login: string; avatarUrl: string }; repository: { viewerPermission: RepoPermission | null } }>(
      `query($owner: String!, $name: String!) { viewer { login avatarUrl } repository(owner: $owner, name: $name) { viewerPermission } }`,
      { owner: data.owner.login, name: data.name },
    );
    const repo: RepoInfo = {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      nodeId: data.node_id,
      defaultBranch: data.default_branch,
      hasDiscussions: Boolean(data.has_discussions),
      viewerPermission: viewer.repository.viewerPermission ?? "READ",
      viewerLogin: viewer.viewer.login,
      viewerAvatarUrl: viewer.viewer.avatarUrl,
    };
    await this.setContextKeys(repo);
    this.output.info(`GitHub: signed in as ${repo.viewerLogin} (${repo.viewerPermission} on ${repo.fullName})`);
    return { rest, graphql, repo, params: { owner: repo.owner, repo: repo.name } };
  }

  /** Re-reads repository metadata (e.g. after enabling Discussions). */
  async refreshRepo(): Promise<GitHubClient | undefined> {
    this.clientPromise = undefined;
    const c = await this.tryClient();
    this.changed.fire(c);
    return c;
  }

  private installEtagHook(rest: RestClient): void {
    const etags = this.etags;
    rest.hook.wrap("request", async (request, options) => {
      const url = rest.request.endpoint(options).url;
      const key = etags.key(options.method, url);
      const hit = key ? etags.get(key) : undefined;
      if (hit) options.headers = { ...options.headers, "if-none-match": hit.etag };
      try {
        const response = await request(options);
        const etag = response.headers.etag;
        if (key && etag) etags.set(key, etag, response);
        return response;
      } catch (e) {
        if (hit && (e as { status?: number }).status === 304) return hit.response as Awaited<ReturnType<typeof request>>;
        throw e;
      }
    });
  }

  private async setContextKeys(repo: RepoInfo | undefined): Promise<void> {
    const p = repo?.viewerPermission;
    await Promise.all([
      vscode.commands.executeCommand("setContext", `${this.opts.contextPrefix}.signedIn`, Boolean(repo)),
      vscode.commands.executeCommand("setContext", `${this.opts.contextPrefix}.canWrite`, atLeast(p, "WRITE")),
      vscode.commands.executeCommand("setContext", `${this.opts.contextPrefix}.canMaintain`, atLeast(p, "MAINTAIN")),
      vscode.commands.executeCommand("setContext", `${this.opts.contextPrefix}.isAdmin`, atLeast(p, "ADMIN")),
    ]);
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
