import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { LdError } from "../core/errors";
import { sleep } from "../core/exec";
import type { Services } from "../extension/services";
import type { GitHubClient } from "../github/client";
import { githubRemote } from "../extension/git";
import type { ReleasesStore, TrackedRun } from "./store";
import { isRunActive, type WorkflowRun } from "./types";

export interface BuildOptions {
  debugApk?: boolean;
  aab?: boolean;
}

interface DispatchResult {
  runId?: number;
  usedInputs: boolean;
}

function isUnexpectedInputs(e: unknown): boolean {
  const err = e as { status?: number; message?: string; response?: { data?: { message?: string } } };
  const msg = `${err.message ?? ""} ${err.response?.data?.message ?? ""}`;
  return err.status === 422 && /unexpected inputs/i.test(msg);
}

/**
 * workflow_dispatch with `return_run_details: true` (GitHub returns 200 + workflow_run_id; older API
 * behaviour is 204). Branches that predate the workflow inputs reject them with 422 "Unexpected
 * inputs", so retry without inputs.
 */
export async function dispatchWorkflow(
  c: GitHubClient,
  workflow: string,
  ref: string,
  inputs: Record<string, string | boolean>,
): Promise<DispatchResult> {
  const send = async (withInputs: boolean) => {
    const res = await c.rest.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
      ...c.params,
      workflow_id: workflow,
      ref,
      ...(withInputs && Object.keys(inputs).length ? { inputs } : {}),
      return_run_details: true,
    } as never);
    const data = (res as { data?: { workflow_run_id?: number } }).data;
    return data?.workflow_run_id;
  };
  try {
    return { runId: await send(true), usedInputs: true };
  } catch (e) {
    if (!isUnexpectedInputs(e)) throw e;
    return { runId: await send(false), usedInputs: false };
  }
}

/** Fallback when the dispatch API didn't return a run id: newest dispatch run on the branch by us. */
export async function findDispatchedRun(c: GitHubClient, workflow: string, branch: string, since: number, signal?: AbortSignal): Promise<WorkflowRun | undefined> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const { data } = await c.rest.actions.listWorkflowRuns({ ...c.params, workflow_id: workflow, branch, event: "workflow_dispatch", per_page: 10 });
    const run = (data.workflow_runs as WorkflowRun[]).find(
      (r) => Date.parse(r.created_at) >= since - 10_000 && (!r.actor || r.actor.login === c.repo.viewerLogin),
    );
    if (run) return run;
    await sleep(2000, signal);
  }
  return undefined;
}

/**
 * One-click CI build of the current branch: makes sure the branch is on GitHub, dispatches
 * build.yml, and tracks the run (status bar + notification with Download/Install when done).
 */
export async function buildApkOnCi(s: Services, store: ReleasesStore, opts: BuildOptions = {}): Promise<void> {
  const c = await s.github.client();
  const repo = store.gitRepo;
  const head = repo?.state.HEAD;
  const branch = head?.name;
  if (!repo || !branch) {
    throw new LdError("COMMAND_FAILED", "Check out a branch first (detached HEAD or no git repository).");
  }

  if (repo.state.workingTreeChanges.length + repo.state.indexChanges.length > 0) {
    const go = await vscode.window.showWarningMessage(
      `CI builds what's pushed to ${branch}; your uncommitted changes won't be included.`,
      "Build Anyway",
    );
    if (!go) return;
  }
  if (!head.upstream || (head.ahead ?? 0) > 0) {
    const why = !head.upstream ? `${branch} isn't on GitHub yet` : `${branch} has ${head.ahead} unpushed commit(s)`;
    const choice = await vscode.window.showWarningMessage(`${why}. Push before building?`, "Push and Build", "Build Pushed Version");
    if (!choice) return;
    if (choice === "Push and Build") {
      const remote = head.upstream?.remote ?? githubRemote(repo, c.repo.owner)?.name ?? "origin";
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${branch}…` }, () =>
        repo.push(remote, branch, !head.upstream),
      );
    } else if (!head.upstream) {
      return;
    }
  }

  const dispatchId = randomUUID().slice(0, 8);
  const started = Date.now();
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Starting a CI build of ${branch}…` },
    async () => {
      const r = await dispatchWorkflow(c, "build.yml", branch, {
        include_debug_apk: Boolean(opts.debugApk),
        include_aab: Boolean(opts.aab),
        dispatch_id: dispatchId,
      });
      if (!r.runId) r.runId = (await findDispatchedRun(c, "build.yml", branch, started))?.id;
      return r;
    },
  );
  if (!result.usedInputs) {
    void vscode.window.showWarningMessage(
      `${branch} predates the downloadable-build workflow, so this run won't upload an APK. Rebase on main to get artifacts.`,
    );
  }
  if (!result.runId) {
    void vscode.window.showWarningMessage("The build was started, but its run couldn't be found yet. It will show up under Recent runs.");
    store.refresh("runs");
    return;
  }
  await store.track({ id: result.runId, branch, dispatchedAt: new Date(started).toISOString(), options: { debugApk: opts.debugApk, aab: opts.aab } });
  s.output.info(`Dispatched build.yml on ${branch}: run ${result.runId} (dispatch id ${dispatchId})`);
}

/** Status bar spinner while dispatched builds run; notifications when they finish. */
export class RunTracker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly s: Services,
    private readonly store: ReleasesStore,
    private readonly onReady: (tracked: TrackedRun, action: "download" | "install") => Promise<void>,
  ) {
    this.item = vscode.window.createStatusBarItem("localdesktop.ciBuild", vscode.StatusBarAlignment.Left, 49);
    this.item.name = "Local Desktop CI build";
    this.subs.push(
      store.onDidChange(() => this.render()),
      store.onDidFinishTrackedRun((t) => void this.notify(t)),
    );
    this.render();
  }

  private render(): void {
    const active = this.store.snapshot.tracked.filter((t) => !t.run || isRunActive(t.run));
    if (!active.length) {
      this.item.hide();
      return;
    }
    const first = active[0]!;
    this.item.text = `$(sync~spin) CI: ${first.branch}${active.length > 1 ? ` +${active.length - 1}` : ""}`;
    this.item.tooltip = `Building APK on GitHub Actions (${first.run?.status ?? "queued"}). Click to open the run.`;
    this.item.command = first.run ? { command: "vscode.open", title: "Open run", arguments: [vscode.Uri.parse(first.run.html_url)] } : undefined;
    this.item.show();
  }

  private async notify(t: TrackedRun): Promise<void> {
    const run = t.run!;
    if (run.conclusion === "success") {
      const apk = t.artifacts?.some((a) => /\.apk$/i.test(a.name));
      const actions = apk ? (this.s.devices.devices.some((d) => d.state === "device") ? ["Install on Device", "Download"] : ["Download"]) : ["Open Run"];
      const choice = await vscode.window.showInformationMessage(`CI build of ${t.branch} finished${apk ? " — APK ready" : ""}.`, ...actions);
      if (choice === "Install on Device") await this.onReady(t, "install");
      else if (choice === "Download") await this.onReady(t, "download");
      else if (choice === "Open Run") await vscode.env.openExternal(vscode.Uri.parse(run.html_url));
    } else {
      const choice = await vscode.window.showErrorMessage(`CI build of ${t.branch} ${run.conclusion ?? "failed"}.`, "Open Run");
      if (choice) await vscode.env.openExternal(vscode.Uri.parse(run.html_url));
    }
  }

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
    this.item.dispose();
  }
}
