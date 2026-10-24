import * as vscode from "vscode";
import { formatBytes } from "./artifacts";
import { playRunFor, relativeTime } from "./runs";
import type { ReleasesStore, ReleasesSnapshot, TrackedRun } from "./store";
import { isRunActive, workflowFile, type Artifact, type Release, type ReleaseAsset, type WorkflowRun } from "./types";
import { LABEL_DESCRIPTIONS, RELEASE_LABELS } from "./versioning";

export type ReleaseNode =
  | { kind: "error"; message: string }
  | { kind: "release"; release: Release; latest: boolean }
  | { kind: "asset"; release: Release; asset: ReleaseAsset }
  | { kind: "manuals"; release: Release; assets: ReleaseAsset[] }
  | { kind: "play"; release: Release; run?: WorkflowRun }
  | { kind: "pr" }
  | { kind: "prNone"; branch: string }
  | { kind: "prLabel" }
  | { kind: "prNotes" }
  | { kind: "run"; run: WorkflowRun }
  | { kind: "artifact"; artifact: Artifact; runId?: number }
  | { kind: "group"; id: "tracked" | "recent" | "releases"; label: string }
  | { kind: "tracked"; tracked: TrackedRun };

function runIcon(run: WorkflowRun): vscode.ThemeIcon {
  if (isRunActive(run)) return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.yellow"));
  switch (run.conclusion) {
    case "success":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "failure":
    case "timed_out":
    case "startup_failure":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "cancelled":
      return new vscode.ThemeIcon("circle-slash");
    case "skipped":
    case "neutral":
      return new vscode.ThemeIcon("debug-step-over");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function runContext(run: WorkflowRun): string {
  if (isRunActive(run)) return "run.inProgress";
  return run.conclusion === "failure" || run.conclusion === "timed_out" ? "run.completed.failed" : "run.completed";
}

function runStatusText(run: WorkflowRun): string {
  return isRunActive(run) ? (run.status ?? "queued").replace("_", " ") : (run.conclusion ?? "done");
}

function assetKind(name: string): "apk" | "aab" | "pdf" | "other" {
  const ext = /\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === "apk" || ext === "aab" || ext === "pdf" ? ext : "other";
}

export class ReleasesTree implements vscode.TreeDataProvider<ReleaseNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ReleaseNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly store: ReleasesStore) {
    this.sub = store.onDidChange(() => this.emitter.fire(undefined));
  }

  private get snap(): ReleasesSnapshot {
    return this.store.snapshot;
  }

  getChildren(node?: ReleaseNode): ReleaseNode[] {
    const s = this.snap;
    if (!node) {
      const out: ReleaseNode[] = [];
      if (s.error) out.push({ kind: "error", message: s.error });
      if (s.latest) out.push({ kind: "release", release: s.latest, latest: true });
      if (s.pr) out.push({ kind: "pr" });
      else if (s.branch?.name && s.loadedAt && s.branch.name !== "main") out.push({ kind: "prNone", branch: s.branch.name });
      if (s.tracked.length) out.push({ kind: "group", id: "tracked", label: "Tracked builds" });
      if (s.recentRuns.length) out.push({ kind: "group", id: "recent", label: "Recent runs" });
      if (s.releases.length > 1) out.push({ kind: "group", id: "releases", label: "All releases" });
      return out;
    }
    switch (node.kind) {
      case "release": {
        const assets = node.release.assets;
        const pdfs = assets.filter((a) => assetKind(a.name) === "pdf");
        const out: ReleaseNode[] = assets.filter((a) => assetKind(a.name) !== "pdf").map((asset) => ({ kind: "asset", release: node.release, asset }));
        if (pdfs.length) out.push({ kind: "manuals", release: node.release, assets: pdfs });
        if (s.hasPlayWorkflow !== false) out.push({ kind: "play", release: node.release, run: playRunFor(node.release, s.playRuns) });
        return out;
      }
      case "manuals":
        return node.assets.map((asset) => ({ kind: "asset", release: node.release, asset }));
      case "pr": {
        const pr = s.pr;
        if (!pr) return [];
        const out: ReleaseNode[] = [{ kind: "prLabel" }, { kind: "prNotes" }];
        out.push(...pr.runs.map((run) => ({ kind: "run" as const, run })));
        out.push(...pr.artifacts.map((artifact) => ({ kind: "artifact" as const, artifact })));
        return out;
      }
      case "group":
        if (node.id === "tracked") return s.tracked.map((tracked) => ({ kind: "tracked", tracked }));
        if (node.id === "recent") return s.recentRuns.map((run) => ({ kind: "run", run }));
        return s.releases.filter((r) => r.id !== s.latest?.id).map((release) => ({ kind: "release", release, latest: false }));
      case "tracked":
        return (node.tracked.artifacts ?? []).filter((a) => !a.expired).map((artifact) => ({ kind: "artifact", artifact, runId: node.tracked.id }));
      default:
        return [];
    }
  }

  getTreeItem(node: ReleaseNode): vscode.TreeItem {
    const s = this.snap;
    const None = vscode.TreeItemCollapsibleState.None;
    const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const Expanded = vscode.TreeItemCollapsibleState.Expanded;
    switch (node.kind) {
      case "error": {
        const item = new vscode.TreeItem("Couldn't load from GitHub", None);
        item.description = node.message;
        item.tooltip = node.message;
        item.iconPath = new vscode.ThemeIcon("warning");
        item.command = { command: "localdesktop.releases.refresh", title: "Retry" };
        return item;
      }
      case "release": {
        const r = node.release;
        const downloads = r.assets.filter((a) => /\.apk$/i.test(a.name)).reduce((n, a) => n + a.download_count, 0);
        const item = new vscode.TreeItem(r.tag_name, node.latest ? Expanded : Collapsed);
        item.description = [node.latest ? "Latest" : r.prerelease ? "Pre-release" : undefined, relativeTime(r.published_at), `${downloads.toLocaleString()} APK downloads`]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = new vscode.MarkdownString(`**${r.name ?? r.tag_name}**\n\n${(r.body ?? "").slice(0, 1500)}`);
        item.iconPath = new vscode.ThemeIcon(node.latest ? "tag" : "history");
        item.contextValue = node.latest ? "release.latest" : "release.other";
        item.id = `release:${r.id}`;
        return item;
      }
      case "asset": {
        const a = node.asset;
        const kind = assetKind(a.name);
        const item = new vscode.TreeItem(a.name, None);
        item.description = `${formatBytes(a.size)} · ${a.download_count.toLocaleString()} ↓`;
        item.iconPath = new vscode.ThemeIcon(kind === "apk" ? "device-mobile" : kind === "aab" ? "package" : kind === "pdf" ? "book" : "file");
        item.contextValue = `asset.${kind}`;
        item.tooltip = a.digest ?? a.browser_download_url;
        item.id = `asset:${node.release.id}:${a.id}`;
        return item;
      }
      case "manuals": {
        const item = new vscode.TreeItem(`Manuals (${node.assets.length})`, Collapsed);
        item.iconPath = new vscode.ThemeIcon("library");
        item.id = `manuals:${node.release.id}`;
        return item;
      }
      case "play": {
        const run = node.run;
        const item = new vscode.TreeItem("Google Play (alpha)", None);
        item.description = run ? `${runStatusText(run)} · ${relativeTime(run.updated_at)}` : "not uploaded";
        item.iconPath = run ? runIcon(run) : new vscode.ThemeIcon("circle-outline");
        item.contextValue = "play.run";
        item.tooltip = run ? `${run.display_title} — ${run.html_url}` : "No upload run found for this release.";
        if (run) item.command = { command: "vscode.open", title: "Open run", arguments: [vscode.Uri.parse(run.html_url)] };
        item.id = `play:${node.release.id}`;
        return item;
      }
      case "pr": {
        const st = s.pr!;
        const item = new vscode.TreeItem(`#${st.pr.number} ${st.pr.title}`, Expanded);
        item.iconPath = new vscode.ThemeIcon(st.pr.draft ? "git-pull-request-draft" : "git-pull-request");
        item.description = st.nonAppOnly
          ? "website/tooling only — no label needed"
          : st.releaseLabels.length === 1
            ? `${st.releaseLabels[0]}${st.predicted ? ` → v${st.predicted}` : ""}`
            : st.releaseLabels.length === 0
              ? "⚠ needs a release label"
              : "⚠ more than one release label";
        item.tooltip = new vscode.MarkdownString(`**${st.pr.head.ref}** → ${st.pr.base.ref}\n\n${st.pr.html_url}`);
        item.contextValue = "pr";
        item.id = `pr:${st.pr.number}`;
        return item;
      }
      case "prNone": {
        const item = new vscode.TreeItem(node.branch, None);
        item.description = "no pull request";
        item.iconPath = new vscode.ThemeIcon("git-branch");
        item.contextValue = "pr.none";
        item.tooltip = "Create a pull request to get a signed APK built for this branch.";
        return item;
      }
      case "prLabel": {
        const st = s.pr!;
        const label = st.releaseLabels[0];
        const item = new vscode.TreeItem(label ? label : "No release label", None);
        item.description = label
          ? `${LABEL_DESCRIPTIONS[label] ?? ""}${RELEASE_LABELS[label] ? ` · ${RELEASE_LABELS[label]} bump` : ""}${
              st.predicted ? ` · releases v${st.predicted}${st.branchVersion === st.predicted ? "" : st.branchVersion ? ` (branch at ${st.branchVersion}, bot will sync)` : ""}` : ""
            }`
          : st.nonAppOnly
            ? "not needed"
            : "required before merging";
        item.iconPath = new vscode.ThemeIcon("tag", label || st.nonAppOnly ? undefined : new vscode.ThemeColor("problemsWarningIcon.foreground"));
        item.contextValue = "pr.label";
        item.command = { command: "localdesktop.pr.setReleaseLabel", title: "Set release label" };
        return item;
      }
      case "prNotes": {
        const st = s.pr!;
        const item = new vscode.TreeItem("Release notes (PR body)", None);
        item.description = st.pr.body?.trim() ? `${st.pr.body.trim().split(/\r?\n/)[0]!.slice(0, 60)}` : "empty — will use the PR title";
        item.iconPath = new vscode.ThemeIcon("note");
        item.contextValue = "pr.notes";
        item.command = { command: "localdesktop.pr.editReleaseNotes", title: "Edit release notes" };
        return item;
      }
      case "run": {
        const run = node.run;
        const item = new vscode.TreeItem(run.name ?? workflowFile(run), None);
        item.description = `${runStatusText(run)} · ${run.display_title} · ${relativeTime(run.updated_at)}`;
        item.tooltip = `${run.name ?? workflowFile(run)} #${run.run_number}\n${run.display_title}\n${run.event} on ${run.head_branch ?? "?"} @ ${run.head_sha.slice(0, 7)}`;
        item.iconPath = runIcon(run);
        item.contextValue = runContext(run);
        item.command = { command: "localdesktop.ci.openRun", title: "Open run", arguments: [node] };
        item.id = `run:${run.id}:${s.pr?.runs.includes(run) ? "pr" : "recent"}`;
        return item;
      }
      case "artifact": {
        const a = node.artifact;
        const isApk = /apk$/i.test(a.name);
        const item = new vscode.TreeItem(a.name, None);
        item.description = formatBytes(a.size_in_bytes);
        item.iconPath = new vscode.ThemeIcon(isApk ? "device-mobile" : "package");
        item.contextValue = isApk ? "artifact.apk" : "artifact.other";
        item.tooltip = a.digest ?? undefined;
        item.id = `artifact:${a.id}:${node.runId ?? "pr"}`;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(node.label, node.id === "tracked" ? Expanded : Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.id === "tracked" ? "rocket" : node.id === "recent" ? "history" : "versions");
        if (node.id === "recent") item.description = s.recentRuns.some(isRunActive) ? `${s.recentRuns.filter(isRunActive).length} running` : undefined;
        item.id = `group:${node.id}`;
        return item;
      }
      case "tracked": {
        const t = node.tracked;
        const run = t.run;
        const opts = [t.options.debugApk ? "+debug APK" : "", t.options.aab ? "+AAB" : ""].filter(Boolean).join(" ");
        const item = new vscode.TreeItem(`Build APK · ${t.branch}`, run && !isRunActive(run) && t.artifacts?.length ? Expanded : None);
        item.description = `${run ? runStatusText(run) : "queued"} · ${relativeTime(t.dispatchedAt)}${opts ? ` · ${opts}` : ""}`;
        item.iconPath = run ? runIcon(run) : new vscode.ThemeIcon("sync~spin");
        item.contextValue = run ? runContext(run) : "run.inProgress";
        item.command = run ? { command: "localdesktop.ci.openRun", title: "Open run", arguments: [{ kind: "run", run }] } : undefined;
        item.id = `tracked:${t.id}`;
        return item;
      }
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

/** Resolves the run a command was invoked on (tree node, tracked run, or nothing). */
export function runOf(node: unknown): WorkflowRun | undefined {
  const n = node as ReleaseNode | undefined;
  if (n?.kind === "run") return n.run;
  if (n?.kind === "tracked") return n.tracked.run;
  if (n?.kind === "play") return n.run;
  return undefined;
}
