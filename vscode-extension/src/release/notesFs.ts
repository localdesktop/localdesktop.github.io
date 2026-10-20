import * as vscode from "vscode";
import type { GitHub, GitHubClient } from "../github/client";
import { detectConflict, draftFromCommits, hashText, type RemoteSnapshot } from "./notes";
import { highestTag } from "./versioning";

export const PR_SCHEME = "ldpr";
export const RELEASE_SCHEME = "ldrelease";

export function prNotesUri(pr: number): vscode.Uri {
  return vscode.Uri.from({ scheme: PR_SCHEME, path: `/pr/${pr}/release-notes.md` });
}

export function releaseNotesUri(tag: string): vscode.Uri {
  return vscode.Uri.from({ scheme: RELEASE_SCHEME, path: `/${tag}.md` });
}

type Target = { kind: "pr"; number: number } | { kind: "release"; tag: string };

function parseUri(uri: vscode.Uri): Target {
  if (uri.scheme === PR_SCHEME) {
    const m = /^\/pr\/(\d+)\/release-notes\.md$/.exec(uri.path);
    if (m) return { kind: "pr", number: parseInt(m[1]!, 10) };
  }
  if (uri.scheme === RELEASE_SCHEME) {
    const m = /^\/(.+)\.md$/.exec(uri.path);
    if (m) return { kind: "release", tag: decodeURIComponent(m[1]!) };
  }
  throw vscode.FileSystemError.FileNotFound(uri);
}

/**
 * Edit a PR body (the release notes the bot puts in the tag) or a published release's notes as a
 * Markdown file; saving PATCHes GitHub. A save that would overwrite a newer remote edit opens a
 * diff instead.
 */
export class NotesFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly opened = new Map<string, RemoteSnapshot & { size: number; releaseId?: number }>();

  constructor(
    private readonly github: GitHub,
    private readonly onSaved?: (target: Target) => void,
  ) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const known = this.opened.get(uri.toString());
    if (known) return { type: vscode.FileType.File, ctime: 0, mtime: Date.parse(known.updatedAt) || 0, size: known.size };
    const { text, snapshot } = await this.fetch(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.parse(snapshot.updatedAt) || 0, size: Buffer.byteLength(text) };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { text, snapshot, releaseId } = await this.fetch(uri);
    this.opened.set(uri.toString(), { ...snapshot, size: Buffer.byteLength(text), releaseId });
    return Buffer.from(text, "utf8");
  }

  private async fetch(uri: vscode.Uri): Promise<{ text: string; snapshot: RemoteSnapshot; releaseId?: number }> {
    const c = await this.github.client();
    const target = parseUri(uri);
    if (target.kind === "pr") {
      const { data: pr } = await c.rest.pulls.get({ ...c.params, pull_number: target.number });
      const body = pr.body ?? "";
      const text = body.trim() ? body : await this.draft(c, pr.head.sha);
      return { text, snapshot: { updatedAt: pr.updated_at, bodyHash: hashText(body) } };
    }
    const { data: rel } = await c.rest.repos.getReleaseByTag({ ...c.params, tag: target.tag });
    const body = rel.body ?? "";
    return { text: body, snapshot: { updatedAt: "", bodyHash: hashText(body) }, releaseId: rel.id };
  }

  private async draft(c: GitHubClient, headSha: string): Promise<string> {
    try {
      const { data: refs } = await c.rest.git.listMatchingRefs({ ...c.params, ref: "tags/v" });
      const latest = highestTag(refs.map((r) => r.ref.replace(/^refs\/tags\//, "")));
      const tag = latest ? `v${latest.major}.${latest.minor}.${latest.patch}` : undefined;
      if (!tag) return draftFromCommits([], undefined);
      const { data } = await c.rest.repos.compareCommitsWithBasehead({ ...c.params, basehead: `${tag}...${headSha}`, per_page: 100 });
      return draftFromCommits(
        data.commits.map((cm) => cm.commit.message),
        tag,
      );
    } catch {
      return draftFromCommits([], undefined);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const c = await this.github.client();
    const target = parseUri(uri);
    const text = Buffer.from(content).toString("utf8");
    const opened = this.opened.get(uri.toString());
    const current = await this.fetch(uri);
    if (detectConflict(opened, current.snapshot)) {
      const choice = await vscode.window.showWarningMessage(
        `${target.kind === "pr" ? `PR #${target.number}` : target.tag} was edited on GitHub after you opened it.`,
        { modal: true },
        "Overwrite",
        "Show GitHub Version",
      );
      if (choice === "Show GitHub Version") {
        const remote = vscode.Uri.parse(`untitled:${target.kind === "pr" ? `pr-${target.number}` : target.tag}-github.md`);
        const doc = await vscode.workspace.openTextDocument(remote);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(remote, new vscode.Position(0, 0), current.text);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand("vscode.diff", doc.uri, uri, "GitHub ↔ yours");
      }
      if (choice !== "Overwrite") throw vscode.FileSystemError.Unavailable("Not saved: the notes changed on GitHub.");
    }
    if (target.kind === "pr") {
      const { data } = await c.rest.pulls.update({ ...c.params, pull_number: target.number, body: text });
      this.opened.set(uri.toString(), { updatedAt: data.updated_at, bodyHash: hashText(text), size: Buffer.byteLength(text) });
    } else {
      const id = opened?.releaseId ?? current.releaseId!;
      const { data } = await c.rest.repos.updateRelease({ ...c.params, release_id: id, body: text });
      this.opened.set(uri.toString(), { updatedAt: "", bodyHash: hashText(data.body ?? text), size: Buffer.byteLength(text), releaseId: id });
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    this.onSaved?.(target);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
