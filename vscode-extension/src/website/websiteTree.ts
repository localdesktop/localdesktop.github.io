import * as path from "node:path";
import * as vscode from "vscode";
import type { WebsiteChange } from "./changes";
import type { BlogPost, DocFolder, DocPage, WebsiteModel } from "./model";
import { isInPdf } from "./pdfCoverage";

export type WebsiteNode =
  | { kind: "blogRoot" }
  | { kind: "post"; post: BlogPost }
  | { kind: "docRoot"; manual: "user" | "developer"; folder: DocFolder }
  | { kind: "folder"; folder: DocFolder }
  | { kind: "page"; page: DocPage }
  | { kind: "changes" }
  | { kind: "change"; change: WebsiteChange }
  | { kind: "deploy" };

export interface DeployRun {
  status: string | null;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
  display_title: string;
}

export interface WebsiteTreeState {
  model?: WebsiteModel;
  changes: WebsiteChange[];
  pdfFolders?: Set<string>;
  deploy?: DeployRun;
}

function docsRel(folder: DocFolder): string {
  return folder.rel;
}

export class WebsiteTree implements vscode.TreeDataProvider<WebsiteNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<WebsiteNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: () => WebsiteTreeState) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: WebsiteNode): WebsiteNode[] {
    const st = this.state();
    const m = st.model;
    if (!m) return [];
    if (!node) {
      const out: WebsiteNode[] = [
        { kind: "blogRoot" },
        { kind: "docRoot", manual: "user", folder: m.manuals.user },
        { kind: "docRoot", manual: "developer", folder: m.manuals.developer },
      ];
      if (st.changes.length) out.push({ kind: "changes" });
      if (st.deploy) out.push({ kind: "deploy" });
      return out;
    }
    switch (node.kind) {
      case "blogRoot":
        return m.blog.map((post) => ({ kind: "post", post }));
      case "docRoot":
      case "folder":
        return node.folder.children.map((c) => (c.kind === "folder" ? { kind: "folder", folder: c } : { kind: "page", page: c }));
      case "changes":
        return st.changes.map((change) => ({ kind: "change", change }));
      default:
        return [];
    }
  }

  getTreeItem(node: WebsiteNode): vscode.TreeItem {
    const st = this.state();
    const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const None = vscode.TreeItemCollapsibleState.None;
    switch (node.kind) {
      case "blogRoot": {
        const item = new vscode.TreeItem("Blog", Collapsed);
        item.description = `${st.model?.blog.length ?? 0} posts`;
        item.iconPath = new vscode.ThemeIcon("rss");
        item.contextValue = "blog.root";
        item.id = "website:blog";
        return item;
      }
      case "post": {
        const p = node.post;
        const item = new vscode.TreeItem(p.title, None);
        const badges = [p.draft ? "draft" : "", p.unlisted ? "unlisted" : "", p.hasTruncate ? "" : "no truncate"].filter(Boolean);
        item.description = [p.date, p.tags.slice(0, 3).join(", "), badges.length ? `(${badges.join(", ")})` : ""].filter(Boolean).join(" · ");
        item.tooltip = new vscode.MarkdownString(
          `**${p.title}**\n\n${p.description ?? ""}\n\n\`${p.url}\` · by ${p.authors.join(", ") || "?"}\n\nTags: ${p.tags.join(", ") || "—"}`,
        );
        item.iconPath = new vscode.ThemeIcon(p.draft ? "edit" : p.unlisted ? "eye-closed" : "note");
        item.resourceUri = vscode.Uri.file(p.file);
        item.contextValue = `blog.post${p.draft ? ".draft" : ""}`;
        item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(p.file)] };
        item.id = `website:post:${p.fileName}`;
        return item;
      }
      case "docRoot": {
        const item = new vscode.TreeItem(node.manual === "user" ? "User Manual" : "Developer Manual", Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.manual === "user" ? "book" : "tools");
        item.contextValue = "doc.root";
        item.id = `website:docs:${node.manual}`;
        return item;
      }
      case "folder": {
        const f = node.folder;
        const inPdf = isInPdf(st.pdfFolders, docsRel(f));
        const item = new vscode.TreeItem(f.label, Collapsed);
        item.description = inPdf ? undefined : "⚠ not in PDF manuals";
        item.tooltip = inPdf ? f.rel : `${f.rel}\n\nThe offline PDF manuals only include folders listed in src/bin/build_docs.rs.`;
        item.iconPath = new vscode.ThemeIcon(inPdf ? "folder" : "warning");
        item.contextValue = "doc.folder";
        item.id = `website:folder:${f.rel}`;
        return item;
      }
      case "page": {
        const p = node.page;
        const item = new vscode.TreeItem(p.title, None);
        item.description = [path.basename(p.rel), p.draft ? "draft" : "", p.unlisted ? "unlisted" : ""].filter(Boolean).join(" · ");
        item.tooltip = `${p.url}`;
        item.iconPath = new vscode.ThemeIcon(p.draft ? "edit" : "file");
        item.resourceUri = vscode.Uri.file(p.file);
        item.contextValue = "doc.page";
        item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(p.file)] };
        item.id = `website:page:${p.rel}`;
        return item;
      }
      case "changes": {
        const item = new vscode.TreeItem(`Unpublished changes (${st.changes.length})`, Collapsed);
        item.iconPath = new vscode.ThemeIcon("git-compare", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"));
        item.tooltip = "gh-pages/ files that differ from main (committed, uncommitted or untracked). Publish turns them into a pull request.";
        item.contextValue = "website.changes";
        item.id = "website:changes";
        return item;
      }
      case "change": {
        const c = node.change;
        const item = new vscode.TreeItem(c.path.replace(/^gh-pages\//, ""), None);
        item.description = c.status;
        item.iconPath = new vscode.ThemeIcon(c.status === "deleted" ? "diff-removed" : c.status === "modified" ? "diff-modified" : "diff-added");
        if (c.status !== "deleted" && st.model) {
          const uri = vscode.Uri.file(path.join(st.model.root, c.path));
          item.resourceUri = uri;
          item.command = { command: "vscode.open", title: "Open", arguments: [uri] };
        }
        item.id = `website:change:${c.path}`;
        return item;
      }
      case "deploy": {
        const d = st.deploy!;
        const item = new vscode.TreeItem("Last deploy", None);
        const status = d.status !== "completed" ? (d.status ?? "queued") : (d.conclusion ?? "done");
        item.description = `${status} · ${new Date(d.updated_at).toLocaleString()}`;
        item.tooltip = d.display_title;
        item.iconPath = new vscode.ThemeIcon(
          d.status !== "completed" ? "sync~spin" : d.conclusion === "success" ? "pass" : "error",
          d.status === "completed" ? new vscode.ThemeColor(d.conclusion === "success" ? "testing.iconPassed" : "testing.iconFailed") : undefined,
        );
        item.command = { command: "vscode.open", title: "Open run", arguments: [vscode.Uri.parse(d.html_url)] };
        item.contextValue = "website.deploy";
        return item;
      }
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
