import * as vscode from "vscode";
import type { GitHubClient } from "../github/client";
import { gitRepository, type GitRepository } from "../extension/git";
import type { Services } from "../extension/services";
import { hintMatches } from "../realtime/hub";
import { isNonAppOnly } from "./exemptPaths";
import { cargoVersion, formatVersion, isAppReleaseTag, predictVersion, releaseLabelsOf, type Version } from "./versioning";
import { isRunActive, workflowFile, type Artifact, type PullRequest, type Release, type WorkflowRun } from "./types";

export interface PrState {
  pr: PullRequest;
  nonAppOnly: boolean;
  releaseLabels: string[];
  /** bump(max(main, latest tag), level); undefined for release:docs / no label. */
  predicted?: string;
  /** Version in the PR branch's Cargo.toml (the bot syncs it to `predicted`). */
  branchVersion?: string;
  runs: WorkflowRun[];
  artifacts: Artifact[];
}

export interface TrackedRun {
  id: number;
  branch: string;
  dispatchedAt: string;
  options: { debugApk?: boolean; aab?: boolean };
  run?: WorkflowRun;
  artifacts?: Artifact[];
  notified?: boolean;
}

export interface BranchState {
  name?: string;
  ahead?: number;
  hasUpstream: boolean;
  dirty: boolean;
}

export interface ReleasesSnapshot {
  latest?: Release;
  releases: Release[];
  playRuns: WorkflowRun[];
  /** False when the repository has no Google Play workflow (e.g. a fork). */
  hasPlayWorkflow?: boolean;
  mainVersion?: Version;
  tags: string[];
  branch?: BranchState;
  pr?: PrState;
  recentRuns: WorkflowRun[];
  tracked: TrackedRun[];
  error?: string;
  loadedAt?: number;
}

const TRACKED_KEY = "localdesktop.trackedRuns";
const MAX_TRACKED = 10;

type Part = "releases" | "pr" | "runs" | "tracked";

/**
 * Fetches and caches everything the Releases & CI view shows. Refreshes are debounced, merged by
 * part, and scheduled adaptively (fast while a tracked run is in progress, slow when unfocused).
 * REST GETs go through the client's ETag cache, so unchanged polls cost no rate limit.
 */
export class ReleasesStore implements vscode.Disposable {
  private snap: ReleasesSnapshot = { releases: [], playRuns: [], tags: [], recentRuns: [], tracked: [] };
  private readonly changed = new vscode.EventEmitter<ReleasesSnapshot>();
  readonly onDidChange = this.changed.event;
  private readonly runFinished = new vscode.EventEmitter<TrackedRun>();
  /** Fires once per tracked (dispatched) run when it completes. */
  readonly onDidFinishTrackedRun = this.runFinished.event;
  private readonly subs: vscode.Disposable[] = [];
  private pending = new Set<Part>();
  private debounce: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private lastFetch = 0;
  private git: GitRepository | undefined;
  private disposed = false;

  constructor(private readonly s: Services) {
    this.snap.tracked = s.context.workspaceState.get<TrackedRun[]>(TRACKED_KEY, []);
    this.subs.push(
      s.github.onDidChange(() => this.refresh("releases", "pr", "runs", "tracked")),
      s.hub.onHint((hint) => {
        if (hintMatches(hint, "releases")) this.refresh("releases");
        if (hintMatches(hint, "runs", "run:")) this.refresh("runs", "tracked", "pr");
        if (hintMatches(hint, "pr:")) this.refresh("pr");
      }),
      vscode.window.onDidChangeWindowState((st) => {
        if (st.focused && Date.now() - this.lastFetch > 30_000) this.refresh("releases", "pr", "runs", "tracked");
        this.schedule();
      }),
    );
    void gitRepository(s.root).then((repo) => {
      if (!repo || this.disposed) return;
      this.git = repo;
      let head = repo.state.HEAD?.name;
      this.subs.push(
        repo.state.onDidChange(() => {
          const next = repo.state.HEAD?.name;
          this.snap.branch = this.branchState();
          if (next !== head) {
            head = next;
            this.refresh("pr");
          } else this.changed.fire(this.snap);
        }),
      );
      this.refresh("pr");
    });
  }

  get snapshot(): ReleasesSnapshot {
    return this.snap;
  }

  get gitRepo(): GitRepository | undefined {
    return this.git;
  }

  branchState(): BranchState | undefined {
    const head = this.git?.state.HEAD;
    if (!this.git || !head) return undefined;
    const st = this.git.state;
    return {
      name: head.name,
      ahead: head.ahead,
      hasUpstream: Boolean(head.upstream),
      dirty: st.workingTreeChanges.length + st.indexChanges.length > 0,
    };
  }

  /** Requests a refresh of some parts; merged and debounced (750 ms), at most every 3 s. */
  refresh(...parts: Part[]): void {
    for (const p of parts.length ? parts : (["releases", "pr", "runs", "tracked"] as Part[])) this.pending.add(p);
    if (this.debounce) return;
    const wait = Math.max(750, 3000 - (Date.now() - this.lastFetch));
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.flush();
    }, wait);
  }

  /** Refreshes now and resolves when done (manual refresh button). */
  async refreshNow(): Promise<void> {
    this.pending = new Set(["releases", "pr", "runs", "tracked"]);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      if (this.pending.size) return this.flush();
      return;
    }
    const parts = this.pending;
    this.pending = new Set();
    this.inFlight = this.load(parts).finally(() => {
      this.inFlight = undefined;
      this.lastFetch = Date.now();
      this.schedule();
    });
    await this.inFlight;
  }

  private async load(parts: Set<Part>): Promise<void> {
    const c = await this.s.github.tryClient();
    if (!c) {
      this.snap = { ...this.snap, error: undefined, latest: undefined, releases: [], pr: undefined, recentRuns: [], playRuns: [] };
      this.changed.fire(this.snap);
      return;
    }
    try {
      this.snap.branch = this.branchState();
      const jobs: Promise<void>[] = [];
      if (parts.has("releases") || !this.snap.loadedAt) jobs.push(this.loadReleases(c));
      if (parts.has("runs") || !this.snap.loadedAt) jobs.push(this.loadRecentRuns(c));
      if (parts.has("tracked")) jobs.push(this.loadTracked(c));
      await Promise.all(jobs);
      if (parts.has("pr") || parts.has("runs") || !this.snap.loadedAt) await this.loadPr(c);
      this.snap.error = undefined;
      this.snap.loadedAt = Date.now();
    } catch (e) {
      this.snap.error = e instanceof Error ? e.message : String(e);
      this.s.output.warn(`Releases & CI refresh failed: ${this.snap.error}`);
    }
    this.changed.fire(this.snap);
  }

  private async loadReleases(c: GitHubClient): Promise<void> {
    const [releases, tags, cargo, play] = await Promise.all([
      c.rest.repos.listReleases({ ...c.params, per_page: 20 }),
      c.rest.git.listMatchingRefs({ ...c.params, ref: "tags/v" }),
      c.rest.repos.getContent({ ...c.params, path: "Cargo.toml", ref: c.repo.defaultBranch }),
      c.rest.actions.listWorkflowRuns({ ...c.params, workflow_id: "google-play-console.yml", per_page: 20 }).catch(() => undefined),
    ]);
    const app = (releases.data as Release[]).filter((r) => !r.draft && isAppReleaseTag(r.tag_name));
    this.snap.releases = app;
    this.snap.latest = app.find((r) => !r.prerelease);
    this.snap.tags = tags.data.map((r) => r.ref.replace(/^refs\/tags\//, ""));
    const content = cargo.data as { content?: string; encoding?: string };
    if (content.content) this.snap.mainVersion = cargoVersion(Buffer.from(content.content, "base64").toString("utf8"));
    this.snap.playRuns = (play?.data.workflow_runs ?? []) as WorkflowRun[];
    this.snap.hasPlayWorkflow = play !== undefined;
  }

  private async loadRecentRuns(c: GitHubClient): Promise<void> {
    const { data } = await c.rest.actions.listWorkflowRunsForRepo({ ...c.params, per_page: 10 });
    this.snap.recentRuns = data.workflow_runs as WorkflowRun[];
  }

  private async loadPr(c: GitHubClient): Promise<void> {
    const branch = this.snap.branch?.name;
    if (!branch || branch === c.repo.defaultBranch) {
      this.snap.pr = undefined;
      return;
    }
    const { data: prs } = await c.rest.pulls.list({ ...c.params, head: `${c.repo.owner}:${branch}`, state: "open", per_page: 1 });
    const pr = prs[0] as PullRequest | undefined;
    if (!pr) {
      this.snap.pr = undefined;
      return;
    }
    const [files, runs, headCargo] = await Promise.all([
      c.rest.paginate(c.rest.pulls.listFiles, { ...c.params, pull_number: pr.number, per_page: 100 }),
      c.rest.actions.listWorkflowRunsForRepo({ ...c.params, head_sha: pr.head.sha, per_page: 20 }),
      c.rest.repos.getContent({ ...c.params, path: "Cargo.toml", ref: pr.head.sha }).catch(() => undefined),
    ]);
    const labels = pr.labels.map((l) => l.name);
    const releaseLabels = releaseLabelsOf(labels);
    const predicted =
      this.snap.mainVersion && releaseLabels.length === 1 ? predictVersion(this.snap.mainVersion, this.snap.tags, releaseLabels[0]!) : undefined;
    const content = headCargo?.data as { content?: string } | undefined;
    const branchVersion = content?.content ? cargoVersion(Buffer.from(content.content, "base64").toString("utf8")) : undefined;
    const prRuns = runs.data.workflow_runs as WorkflowRun[];
    const build = prRuns.find((r) => workflowFile(r) === "build.yml" && r.conclusion === "success");
    const artifacts = build ? ((await c.rest.actions.listWorkflowRunArtifacts({ ...c.params, run_id: build.id })).data.artifacts as Artifact[]) : [];
    this.snap.pr = {
      pr,
      nonAppOnly: isNonAppOnly(files),
      releaseLabels,
      predicted: predicted ? formatVersion(predicted) : undefined,
      branchVersion: branchVersion ? formatVersion(branchVersion) : undefined,
      runs: prRuns,
      artifacts: artifacts.filter((a) => !a.expired),
    };
  }

  private async loadTracked(c: GitHubClient): Promise<void> {
    const tracked = this.snap.tracked;
    await Promise.all(
      tracked.map(async (t) => {
        if (t.run && !isRunActive(t.run) && t.artifacts) return;
        try {
          const { data } = await c.rest.actions.getWorkflowRun({ ...c.params, run_id: t.id });
          t.run = data as WorkflowRun;
          if (!isRunActive(t.run)) {
            t.artifacts = (await c.rest.actions.listWorkflowRunArtifacts({ ...c.params, run_id: t.id })).data.artifacts as Artifact[];
          }
        } catch (e) {
          if ((e as { status?: number }).status === 404) t.notified = true;
        }
      }),
    );
    for (const t of tracked) {
      if (t.run && !isRunActive(t.run) && !t.notified) {
        t.notified = true;
        this.runFinished.fire(t);
      }
    }
    await this.persistTracked();
  }

  async track(run: TrackedRun): Promise<void> {
    this.snap.tracked = [run, ...this.snap.tracked.filter((t) => t.id !== run.id)].slice(0, MAX_TRACKED);
    await this.persistTracked();
    this.changed.fire(this.snap);
    this.refresh("tracked");
  }

  async untrack(id: number): Promise<void> {
    this.snap.tracked = this.snap.tracked.filter((t) => t.id !== id);
    await this.persistTracked();
    this.changed.fire(this.snap);
  }

  private async persistTracked(): Promise<void> {
    await this.s.context.workspaceState.update(TRACKED_KEY, this.snap.tracked);
  }

  hasActiveRuns(): boolean {
    const s = this.snap;
    return (
      s.tracked.some((t) => !t.run || isRunActive(t.run)) ||
      (s.pr?.runs.some(isRunActive) ?? false) ||
      s.recentRuns.some(isRunActive)
    );
  }

  /** 15 s while something runs, 60 s otherwise, 5 min when the window isn't focused. */
  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const poll = vscode.workspace.getConfiguration("localdesktop").get<number>("realtime.pollSeconds", 60) * 1000;
    const delay = !vscode.window.state.focused ? 5 * 60_000 : this.hasActiveRuns() ? 15_000 : Math.max(15_000, poll);
    this.timer = setTimeout(() => this.refresh(this.hasActiveRuns() ? "runs" : "releases", "runs", "tracked", "pr"), delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
    this.runFinished.dispose();
  }
}
