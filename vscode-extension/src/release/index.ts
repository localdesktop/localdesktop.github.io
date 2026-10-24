import * as path from "node:path";
import * as vscode from "vscode";
import { LdError } from "../core/errors";
import type { Services } from "../extension/services";
import { registerCommand, showError } from "../extension/ui";
import { downloadArtifact, downloadReleaseAsset } from "./artifacts";
import { buildApkOnCi, dispatchWorkflow, RunTracker } from "./ci";
import { pickReleaseLabel } from "./labels";
import { NotesFileSystem, PR_SCHEME, prNotesUri, RELEASE_SCHEME, releaseNotesUri } from "./notesFs";
import { ReleasesTree, runOf, type ReleaseNode } from "./releasesTree";
import { ReleasesStore, type TrackedRun } from "./store";
import type { Artifact, Release, ReleaseAsset } from "./types";
import { WorkflowPresence } from "./workflows";

/** Releases & CI view, one-click CI builds, release labels and notes. */
export function activateReleases(s: Services): void {
  const { context, output } = s;
  const store = new ReleasesStore(s);
  const workflows = new WorkflowPresence();
  context.subscriptions.push(s.github.onDidChange((c) => void workflows.refresh(c)));
  void s.github.tryClient().then((c) => workflows.refresh(c));
  const tree = new ReleasesTree(store);
  const view = vscode.window.createTreeView("localdesktop.releases", { treeDataProvider: tree, showCollapseAll: true });
  const notes = new NotesFileSystem(s.github, () => store.refresh("pr", "releases"));
  context.subscriptions.push(
    store,
    tree,
    view,
    vscode.workspace.registerFileSystemProvider(PR_SCHEME, notes),
    vscode.workspace.registerFileSystemProvider(RELEASE_SCHEME, notes),
  );
  const badge = store.onDidChange((snap) => {
    view.badge = snap.tracked.some((t) => !t.run || t.run.status !== "completed")
      ? { value: snap.tracked.filter((t) => !t.run || t.run.status !== "completed").length, tooltip: "CI builds running" }
      : undefined;
  });
  context.subscriptions.push(
    badge,
    view.onDidChangeVisibility((e) => e.visible && store.refresh("releases", "pr", "runs", "tracked")),
  );

  const downloads = () => path.join(context.globalStorageUri.fsPath, "downloads");
  const reg = (id: string, fn: (...args: any[]) => unknown) => registerCommand(context, id, fn, output);

  async function token(): Promise<string> {
    const session = await s.github.auth.current();
    if (!session) throw new LdError("CANCELLED", "Not signed in to GitHub.");
    return session.token;
  }

  async function fetchArtifact(artifact: Artifact): Promise<string> {
    const c = await s.github.client();
    const tok = await token();
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${artifact.name}`, cancellable: true },
      (progress, ct) => {
        const ctrl = new AbortController();
        ct.onCancellationRequested(() => ctrl.abort());
        let last = 0;
        return downloadArtifact(c.params, artifact, {
          token: tok,
          destDir: downloads(),
          signal: ctrl.signal,
          onProgress: (received, total) => {
            if (!total) return;
            const pct = Math.floor((received / total) * 100);
            if (pct > last) {
              progress.report({ increment: pct - last, message: `${pct}%` });
              last = pct;
            }
          },
        });
      },
    );
  }

  async function fetchAsset(asset: ReleaseAsset): Promise<string> {
    const c = await s.github.client();
    const tok = await token();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${asset.name}`, cancellable: true }, (_p, ct) => {
      const ctrl = new AbortController();
      ct.onCancellationRequested(() => ctrl.abort());
      return downloadReleaseAsset(c.params, asset, { token: tok, destDir: downloads(), signal: ctrl.signal });
    });
  }

  const install = (file: string) => vscode.commands.executeCommand("localdesktop.devices.installApk", vscode.Uri.file(file), { replace: true });

  async function revealDownloaded(file: string): Promise<void> {
    const actions = /\.apk$/i.test(file) ? ["Install on Device", "Reveal"] : ["Reveal"];
    const choice = await vscode.window.showInformationMessage(`Downloaded ${path.basename(file)}.`, ...actions);
    if (choice === "Install on Device") await install(file);
    else if (choice === "Reveal") await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
  }

  function artifactOf(node: unknown): Artifact {
    const n = node as ReleaseNode | undefined;
    if (n?.kind === "artifact") return n.artifact;
    const apk = store.snapshot.pr?.artifacts.find((a) => /\.apk$/i.test(a.name));
    if (apk) return apk;
    throw new LdError("INVALID_ARGUMENT", "No artifact selected.");
  }

  function releaseOf(node: unknown): Release | undefined {
    const n = node as ReleaseNode | undefined;
    if (n && (n.kind === "release" || n.kind === "asset" || n.kind === "play" || n.kind === "manuals")) return n.release;
    return store.snapshot.latest;
  }

  function assetOf(node: unknown): ReleaseAsset {
    const n = node as ReleaseNode | undefined;
    if (n?.kind === "asset") return n.asset;
    const apk = store.snapshot.latest?.assets.find((a) => /^localdesktop-[\d.]+\.apk$/.test(a.name));
    if (apk) return apk;
    throw new LdError("INVALID_ARGUMENT", "No release asset selected.");
  }

  async function requirePr() {
    await store.refreshNow();
    const st = store.snapshot.pr;
    if (!st) throw new LdError("COMMAND_FAILED", "The current branch has no open pull request.", "Create one with “Create Pull Request…”.");
    return st;
  }

  async function onTrackedReady(t: TrackedRun, action: "download" | "install"): Promise<void> {
    const apk = (t.artifacts ?? []).find((a) => /-release\.apk$/i.test(a.name)) ?? (t.artifacts ?? []).find((a) => /\.apk$/i.test(a.name));
    if (!apk) throw new LdError("COMMAND_FAILED", "That run uploaded no APK.");
    const file = await fetchArtifact(apk);
    if (action === "install") await install(file);
    else await revealDownloaded(file);
  }

  context.subscriptions.push(new RunTracker(s, store, (t, action) => onTrackedReady(t, action).catch((e) => void showError(e, output))));

  reg("localdesktop.releases.refresh", () => store.refreshNow());

  reg("localdesktop.ci.buildApk", () => {
    workflows.require("build", "building on CI");
    return buildApkOnCi(s, store);
  });
  reg("localdesktop.ci.buildApkWithOptions", async () => {
    workflows.require("build", "building on CI");
    const picks = await vscode.window.showQuickPick(
      [
        { label: "Also upload the debug APK", value: "debugApk" as const, description: "debuggable, debug-signed" },
        { label: "Also build the AAB", value: "aab" as const, description: "Play bundle; adds a few minutes" },
      ],
      { title: "Build APK on CI", canPickMany: true, placeHolder: "The signed release APK is always uploaded" },
    );
    if (!picks) return;
    await buildApkOnCi(s, store, { debugApk: picks.some((p) => p.value === "debugApk"), aab: picks.some((p) => p.value === "aab") });
  });

  reg("localdesktop.ci.openRun", async (node?: unknown) => {
    const run = runOf(node);
    if (run) await vscode.env.openExternal(vscode.Uri.parse(run.html_url));
  });
  reg("localdesktop.ci.cancelRun", async (node?: unknown) => {
    const run = runOf(node);
    if (!run) return;
    const c = await s.github.client();
    await c.rest.actions.cancelWorkflowRun({ ...c.params, run_id: run.id });
    store.refresh("runs", "tracked");
  });
  reg("localdesktop.ci.rerunRun", async (node?: unknown) => {
    const run = runOf(node);
    if (!run) return;
    const c = await s.github.client();
    await c.rest.actions.reRunWorkflow({ ...c.params, run_id: run.id });
    const tracked = store.snapshot.tracked.find((t) => t.id === run.id);
    if (tracked) await store.track({ ...tracked, run: undefined, artifacts: undefined, notified: false });
    store.refresh("runs", "tracked");
  });
  reg("localdesktop.ci.rerunFailed", async (node?: unknown) => {
    const run = runOf(node);
    if (!run) return;
    const c = await s.github.client();
    await c.rest.actions.reRunWorkflowFailedJobs({ ...c.params, run_id: run.id });
    store.refresh("runs", "tracked");
  });
  reg("localdesktop.ci.downloadArtifact", async (node?: unknown) => revealDownloaded(await fetchArtifact(artifactOf(node))));
  reg("localdesktop.ci.installArtifact", async (node?: unknown) => {
    await install(await fetchArtifact(artifactOf(node)));
  });

  reg("localdesktop.release.downloadAsset", async (node?: unknown) => revealDownloaded(await fetchAsset(assetOf(node))));
  reg("localdesktop.release.installAsset", async (node?: unknown) => {
    await install(await fetchAsset(assetOf(node)));
  });
  reg("localdesktop.release.copyLink", async (node?: unknown) => {
    const asset = assetOf(node);
    await vscode.env.clipboard.writeText(asset.browser_download_url);
    void vscode.window.setStatusBarMessage(`Copied ${asset.name} link`, 3000);
  });
  reg("localdesktop.release.openOnGitHub", async (node?: unknown) => {
    const r = releaseOf(node);
    if (r) await vscode.env.openExternal(vscode.Uri.parse(r.html_url));
  });
  reg("localdesktop.release.editNotes", async (node?: unknown) => {
    const r = releaseOf(node);
    if (!r) throw new LdError("COMMAND_FAILED", "No release found.");
    await vscode.window.showTextDocument(releaseNotesUri(r.tag_name), { preview: false });
  });
  reg("localdesktop.release.uploadToPlay", async (node?: unknown) => {
    const c = await s.github.client();
    workflows.require("play", "uploading to Google Play");
    let release = (node as ReleaseNode | undefined)?.kind ? releaseOf(node) : undefined;
    if (!release) {
      const items = store.snapshot.releases.map((r) => ({ label: r.tag_name, description: r.name ?? undefined, release: r }));
      const pick = await vscode.window.showQuickPick(items, { title: "Upload which release to Google Play (alpha)?" });
      if (!pick) return;
      release = pick.release;
    }
    if (!release.assets.some((a) => /^localdesktop-[\d.]+\.aab$/.test(a.name))) {
      throw new LdError("COMMAND_FAILED", `${release.tag_name} has no AAB to upload.`);
    }
    const ok = await vscode.window.showWarningMessage(
      `Upload ${release.tag_name} to the Google Play alpha track?`,
      { modal: true, detail: "This runs “Upload AAB to Google Play” on main with the release's AAB." },
      "Upload",
    );
    if (!ok) return;
    await dispatchWorkflow(c, "google-play-console.yml", c.repo.defaultBranch, { tag: release.tag_name });
    void vscode.window.showInformationMessage(`Google Play upload of ${release.tag_name} started.`);
    store.refresh("releases", "runs");
  });

  reg("localdesktop.pr.setReleaseLabel", async () => {
    const st = await requirePr();
    const c = await s.github.client();
    const label = await pickReleaseLabel(c, st, store.snapshot.mainVersion, store.snapshot.tags);
    if (label) {
      void vscode.window.setStatusBarMessage(`#${st.pr.number} labelled ${label}; the release bot will sync the version`, 5000);
      store.refresh("pr");
    }
  });
  reg("localdesktop.pr.editReleaseNotes", async () => {
    const st = await requirePr();
    await vscode.window.showTextDocument(prNotesUri(st.pr.number), { preview: false });
  });
  reg("localdesktop.pr.open", async () => {
    const st = store.snapshot.pr ?? (await requirePr());
    await vscode.env.openExternal(vscode.Uri.parse(st.pr.html_url));
  });
  reg("localdesktop.pr.create", async () => {
    const c = await s.github.client();
    const repo = store.gitRepo;
    const branch = repo?.state.HEAD?.name;
    if (!repo || !branch) throw new LdError("COMMAND_FAILED", "Check out a branch first.");
    if (branch === c.repo.defaultBranch) throw new LdError("COMMAND_FAILED", `You're on ${branch}; create a feature branch first.`);
    if (!repo.state.HEAD?.upstream || (repo.state.HEAD.ahead ?? 0) > 0) {
      const push = await vscode.window.showWarningMessage(`Push ${branch} to GitHub first?`, "Push");
      if (!push) return;
      await repo.push(repo.state.HEAD?.upstream?.remote ?? "origin", branch, !repo.state.HEAD?.upstream);
    }
    const title = await vscode.window.showInputBox({ title: `Pull request for ${branch}`, prompt: "Title", value: branch.replace(/[-_/]+/g, " ") });
    if (!title) return;
    const { data } = await c.rest.pulls.create({ ...c.params, head: branch, base: c.repo.defaultBranch, title, body: "" });
    store.refresh("pr");
    const next = await vscode.window.showInformationMessage(`Opened #${data.number}.`, "Set Release Label", "Open on GitHub");
    if (next === "Set Release Label") await vscode.commands.executeCommand("localdesktop.pr.setReleaseLabel");
    else if (next === "Open on GitHub") await vscode.env.openExternal(vscode.Uri.parse(data.html_url));
  });

  reg("localdesktop.website.deploy", async () => {
    const c = await s.github.client();
    workflows.require("pages", "deploying the website");
    const ok = await vscode.window.showWarningMessage(
      "Deploy the website from main now?",
      { modal: true, detail: "Runs “Deploy Docs to GitHub Pages”. Pushes to main touching gh-pages/ deploy automatically." },
      "Deploy",
    );
    if (!ok) return;
    await dispatchWorkflow(c, "gh-pages.yml", c.repo.defaultBranch, {});
    void vscode.window.showInformationMessage("Website deploy started.");
    store.refresh("runs");
  });

  store.refresh("releases", "pr", "runs", "tracked");
}
