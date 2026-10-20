import { execFile } from "./exec";

/** "owner/name" from a GitHub remote URL (https, ssh:// or scp-style), else undefined. */
export function parseGitHubRemote(url: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The GitHub repository of the checkout's `origin` remote (a fork's own repo in a fork). */
export async function originRepo(root: string): Promise<string | undefined> {
  const res = await execFile("git", ["remote", "get-url", "origin"], { cwd: root, timeoutMs: 10_000 }).catch(() => undefined);
  if (!res || res.code !== 0) return undefined;
  return parseGitHubRemote(res.stdout.toString("utf8"));
}
