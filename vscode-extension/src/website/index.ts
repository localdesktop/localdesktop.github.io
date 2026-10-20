import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { LdError } from "../core/errors";
import type { Services } from "../extension/services";
import { registerCommand } from "../extension/ui";
import { hintMatches } from "../realtime/hub";
import { websiteChanges } from "./changes";
import { readWebsite, SITE_URL, urlForFile } from "./model";
import { newDocCategory, newDocPage } from "./newDoc";
import { copyBlogImage, newBlogPost } from "./newPost";
import { readPdfFolders } from "./pdfCoverage";
import { WebsitePreview } from "./preview";
import { publishWebsite } from "./publish";
import { WebsiteTree, type DeployRun, type WebsiteNode, type WebsiteTreeState } from "./websiteTree";

/** Website view: blog/docs trees, new post/doc wizards, preview, publish. */
export function activateWebsite(s: Services): void {
  const root = s.root;
  if (!root || !fs.existsSync(path.join(root, "gh-pages", "docusaurus.config.ts"))) return;
  const { context, output } = s;

  const state: WebsiteTreeState = { changes: [] };
  const tree = new WebsiteTree(() => state);
  const view = vscode.window.createTreeView("localdesktop.website", { treeDataProvider: tree, showCollapseAll: true });
  const preview = new WebsitePreview(root);
  context.subscriptions.push(tree, view, preview);

  let reloadTimer: NodeJS.Timeout | undefined;
  const reload = (delay = 300) => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load(), delay);
  };
  async function load(): Promise<void> {
    try {
      state.model = readWebsite(root!);
      state.pdfFolders = readPdfFolders(root!);
      state.changes = await websiteChanges(root!).catch(() => []);
      view.badge = state.changes.length ? { value: state.changes.length, tooltip: `${state.changes.length} unpublished website change(s)` } : undefined;
    } catch (e) {
      output.warn(`Website view: ${e instanceof Error ? e.message : String(e)}`);
    }
    tree.refresh();
  }
  async function loadDeploy(): Promise<void> {
    const c = await s.github.tryClient();
    if (!c) return;
    try {
      const { data } = await c.rest.actions.listWorkflowRuns({ ...c.params, workflow_id: "gh-pages.yml", per_page: 1 });
      state.deploy = data.workflow_runs[0] as DeployRun | undefined;
      tree.refresh();
    } catch {
      // workflow missing or no access
    }
  }

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "gh-pages/{blog,docs,static/img}/**"));
  const authorsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "gh-pages/blog/authors.yml"));
  context.subscriptions.push(
    watcher,
    authorsWatcher,
    watcher.onDidCreate(() => reload()),
    watcher.onDidChange(() => reload(1000)),
    watcher.onDidDelete(() => reload()),
    authorsWatcher.onDidChange(() => reload()),
    vscode.workspace.onDidSaveTextDocument((d) => d.uri.fsPath.startsWith(path.join(root, "gh-pages")) && reload()),
    s.github.onDidChange(() => void loadDeploy()),
    s.hub.onHint((hint) => {
      if (hintMatches(hint, "website")) reload();
      if (hintMatches(hint, "runs", "run:")) void loadDeploy();
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible) {
        reload(0);
        void loadDeploy();
      }
    }),
  );
  void load();
  void loadDeploy();

  const reg = (id: string, fn: (...args: any[]) => unknown) => registerCommand(context, id, fn, output);

  /** File for a command invoked from the tree, the editor title, or the palette (active editor). */
  function fileOf(arg: unknown): string | undefined {
    const n = arg as WebsiteNode | undefined;
    if (n?.kind === "post") return n.post.file;
    if (n?.kind === "page") return n.page.file;
    if (arg instanceof vscode.Uri) return arg.fsPath;
    return vscode.window.activeTextEditor?.document.uri.fsPath;
  }

  function folderOf(arg: unknown): string | undefined {
    const n = arg as WebsiteNode | undefined;
    if (n?.kind === "docRoot" || n?.kind === "folder") return n.folder.rel;
    return undefined;
  }

  reg("localdesktop.website.refresh", async () => {
    await load();
    await loadDeploy();
  });
  reg("localdesktop.website.newPost", async () => {
    await newBlogPost(root, s.github);
    reload(0);
  });
  reg("localdesktop.website.newDoc", async (arg?: unknown) => {
    await newDocPage(root, folderOf(arg));
    reload(0);
  });
  reg("localdesktop.website.newCategory", async (arg?: unknown) => {
    await newDocCategory(root, folderOf(arg));
    reload(0);
  });
  reg("localdesktop.website.addImage", async (arg?: unknown) => {
    const file = fileOf(arg);
    if (!file || !file.startsWith(path.join(root, "gh-pages", "blog"))) throw new LdError("INVALID_ARGUMENT", "Open or select a blog post first.");
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Images: ["webp", "png", "jpg", "jpeg", "gif", "svg"] } });
    if (!picked?.[0]) return;
    const slug = path.basename(file).replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.mdx?$/, "");
    const sitePath = copyBlogImage(root, picked[0].fsPath, slug);
    const alt = (await vscode.window.showInputBox({ title: "Alt text", prompt: "Describe the image for screen readers" })) ?? "";
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    await editor.edit((b) => b.insert(editor.selection.active, `![${alt}](${sitePath})`));
    void vscode.window.setStatusBarMessage(`Added ${sitePath}`, 4000);
  });
  reg("localdesktop.website.preview", () => preview.open("/"));
  reg("localdesktop.website.previewActive", async (arg?: unknown) => {
    const file = fileOf(arg);
    const url = file ? urlForFile(root, file) : undefined;
    if (!url) throw new LdError("INVALID_ARGUMENT", "This file isn't a blog post or doc page.");
    if (vscode.window.activeTextEditor?.document.isDirty) await vscode.window.activeTextEditor.document.save();
    await preview.open(url);
  });
  reg("localdesktop.website.openLive", async (arg?: unknown) => {
    const file = fileOf(arg);
    const url = file ? urlForFile(root, file) : undefined;
    await vscode.env.openExternal(vscode.Uri.parse(`${SITE_URL}${url ?? "/"}`));
  });
  reg("localdesktop.website.build", async () => {
    const ok = await preview.build();
    if (ok) void vscode.window.showInformationMessage("Website built; no broken links.");
    else void vscode.window.showErrorMessage("Website build failed (see the “Build website” terminal).");
  });
  reg("localdesktop.website.publish", async () => {
    await publishWebsite(root, s.github, output);
    reload(0);
  });
}
