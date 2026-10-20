import * as path from "node:path";
import * as vscode from "vscode";

// Minimal slice of the built-in vscode.git extension API (extensions/git/src/api/git.d.ts).

export interface GitBranchRef {
  name?: string;
  commit?: string;
  upstream?: { remote: string; name: string };
  ahead?: number;
  behind?: number;
}

export interface GitChange {
  uri: vscode.Uri;
}

export interface GitRepositoryState {
  readonly HEAD: GitBranchRef | undefined;
  readonly workingTreeChanges: GitChange[];
  readonly indexChanges: GitChange[];
  readonly untrackedChanges?: GitChange[];
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState & { remotes?: GitRemote[] };
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  fetch(remote?: string, ref?: string): Promise<void>;
}

interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

/** The vscode.git repository for `root` (undefined if the git extension is disabled). */
export async function gitRepository(root: string | undefined): Promise<GitRepository | undefined> {
  if (!root) return undefined;
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) return undefined;
  const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  const match = (r: GitRepository) => path.resolve(r.rootUri.fsPath) === path.resolve(root);
  const found = api.repositories.find(match);
  if (found) return found;
  // Repositories open asynchronously after activation.
  return new Promise((resolve) => {
    const sub = api.onDidOpenRepository((r) => {
      if (match(r)) {
        sub.dispose();
        resolve(r);
      }
    });
    setTimeout(() => {
      sub.dispose();
      resolve(api.repositories.find(match));
    }, 5000);
  });
}

/** The remote that points at `fullName` on GitHub (handles renamed repos by matching the name loosely). */
export function githubRemote(repo: GitRepository, owner: string): GitRemote | undefined {
  const remotes = repo.state.remotes ?? [];
  const isGitHub = (r: GitRemote) => /github\.com[:/]/.test(r.fetchUrl ?? r.pushUrl ?? "");
  return (
    remotes.find((r) => isGitHub(r) && new RegExp(`github\\.com[:/]${owner}/`, "i").test(r.fetchUrl ?? "") && r.name === "origin") ??
    remotes.find((r) => isGitHub(r) && new RegExp(`github\\.com[:/]${owner}/`, "i").test(r.fetchUrl ?? "")) ??
    remotes.find((r) => r.name === "origin")
  );
}
