import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { LdError } from "../core/errors";
import type { GitHub, GitHubClient } from "../github/client";
import { websiteChanges } from "./changes";
import { readAuthors } from "./model";
import { branchNameFor, defaultTitle, isText, validateSiteFile } from "./validate";

async function freeBranch(c: GitHubClient, wanted: string): Promise<string> {
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? wanted : `${wanted}-${n}`;
    try {
      await c.rest.git.getRef({ ...c.params, ref: `heads/${name}` });
    } catch (e) {
      if ((e as { status?: number }).status === 404) return name;
      throw e;
    }
  }
  throw new LdError("COMMAND_FAILED", `Couldn't find a free branch name for ${wanted}`);
}

/**
 * Publishes selected gh-pages/ changes as a PR without touching the working tree or the current
 * branch: blobs → tree on top of main → commit → refs/heads/website/<slug> → pull request.
 * Website-only PRs need no release label and build no APK.
 */
export async function publishWebsite(root: string, github: GitHub, output: vscode.LogOutputChannel): Promise<void> {
  const changes = await websiteChanges(root);
  if (!changes.length) {
    void vscode.window.showInformationMessage("No website changes compared to main.");
    return;
  }
  const icon = { added: "$(diff-added)", modified: "$(diff-modified)", deleted: "$(diff-removed)", untracked: "$(diff-added)" } as const;
  const picks = await vscode.window.showQuickPick(
    changes.map((c) => ({
      label: `${icon[c.status]} ${c.path.replace(/^gh-pages\//, "")}`,
      description: c.changedUpstream ? `${c.status} · also changed on main` : c.status,
      picked: true,
      change: c,
    })),
    { title: "Publish which website changes?", canPickMany: true, placeHolder: "A pull request is created from these files; your working tree is left as is" },
  );
  if (!picks?.length) return;
  const selected = picks.map((p) => p.change);
  const stale = selected.filter((c) => c.changedUpstream);
  if (stale.length) {
    const go = await vscode.window.showWarningMessage(
      `${stale.map((c) => path.basename(c.path)).join(", ")} also changed on main since your branch forked. Publishing uploads your copy and would overwrite those edits.`,
      { modal: true, detail: "Pull main and merge first to keep both." },
      "Publish Anyway",
    );
    if (!go) return;
  }

  const authors = readAuthors(path.join(root, "gh-pages"));
  const issues = selected
    .filter((c) => c.status !== "deleted" && isText(c.path))
    .flatMap((c) => validateSiteFile(root, c.path, fs.readFileSync(path.join(root, c.path), "utf8"), authors));
  const errors = issues.filter((i) => i.severity === "error");
  if (issues.length) {
    output.info(`Website publish checks:\n${issues.map((i) => `  ${i.severity}: ${i.path}: ${i.message}`).join("\n")}`);
    const summary = issues.slice(0, 3).map((i) => `${path.basename(i.path)}: ${i.message}`).join("; ");
    if (errors.length) {
      const go = await vscode.window.showErrorMessage(`${errors.length} problem(s): ${summary}`, { modal: true }, "Publish Anyway");
      if (!go) return;
    } else {
      const go = await vscode.window.showWarningMessage(`${summary}`, "Publish", "Show Details");
      if (go === "Show Details") output.show(true);
      if (go !== "Publish") return;
    }
  }

  const c = await github.client();
  const title = await vscode.window.showInputBox({ title: "Pull request title", value: defaultTitle(selected, root), ignoreFocusOut: true });
  if (!title) return;

  const pr = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Publishing website changes…" }, async (progress) => {
    const base = c.repo.defaultBranch;
    const { data: ref } = await c.rest.git.getRef({ ...c.params, ref: `heads/${base}` });
    const { data: baseCommit } = await c.rest.git.getCommit({ ...c.params, commit_sha: ref.object.sha });
    const tree: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
    for (const [i, change] of selected.entries()) {
      progress.report({ message: `${i + 1}/${selected.length} ${path.basename(change.path)}` });
      if (change.status === "deleted") {
        tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const content = fs.readFileSync(path.join(root, change.path));
      const { data: blob } = await c.rest.git.createBlob({ ...c.params, content: content.toString("base64"), encoding: "base64" });
      tree.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const { data: newTree } = await c.rest.git.createTree({ ...c.params, base_tree: baseCommit.tree.sha, tree });
    const { data: commit } = await c.rest.git.createCommit({ ...c.params, message: title, tree: newTree.sha, parents: [baseCommit.sha] });
    const branch = await freeBranch(c, branchNameFor(selected, root, new Date().toISOString().slice(0, 10)));
    await c.rest.git.createRef({ ...c.params, ref: `refs/heads/${branch}`, sha: commit.sha });
    const body = `Published from the Local Desktop VS Code extension.\n\n${selected.map((ch) => `- ${ch.status}: \`${ch.path}\``).join("\n")}\n`;
    const { data } = await c.rest.pulls.create({ ...c.params, head: branch, base, title, body });
    return data;
  });

  const choice = await vscode.window.showInformationMessage(
    `Opened #${pr.number}. Your local files are unchanged; pull main after it merges.`,
    "Enable Auto-merge",
    "Open on GitHub",
  );
  if (choice === "Open on GitHub") await vscode.env.openExternal(vscode.Uri.parse(pr.html_url));
  if (choice === "Enable Auto-merge") {
    try {
      await c.graphql(`mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }`, { id: pr.node_id });
      void vscode.window.showInformationMessage(`Auto-merge enabled for #${pr.number}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // No required checks → GitHub refuses auto-merge ("clean status"); offer an explicit merge.
      const merge = await vscode.window.showWarningMessage(`Auto-merge isn't available (${msg.slice(0, 120)}).`, "Squash and Merge Now", "Open on GitHub");
      if (merge === "Squash and Merge Now") {
        await c.rest.pulls.merge({ ...c.params, pull_number: pr.number, merge_method: "squash" });
        void vscode.window.showInformationMessage(`Merged #${pr.number}; the site deploys from main automatically.`);
      } else if (merge === "Open on GitHub") await vscode.env.openExternal(vscode.Uri.parse(pr.html_url));
    }
  }
}
