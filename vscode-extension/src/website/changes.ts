import { execFile } from "../core/exec";

export type ChangeStatus = "added" | "modified" | "deleted" | "untracked";

export interface WebsiteChange {
  /** Repo-relative path with forward slashes. */
  path: string;
  status: ChangeStatus;
  /** Also changed on main since this branch forked: publishing would overwrite those edits. */
  changedUpstream?: boolean;
}

async function git(root: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const r = await execFile("git", args, { cwd: root, timeoutMs: 20_000 });
  return { code: r.code, out: r.stdout.toString("utf8") };
}

/** The ref local website changes are compared against: <remote>/main, preferring origin. */
export async function baseRef(root: string, branch = "main"): Promise<string> {
  const refs = (await git(root, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${branch}`])).out.split(/\r?\n/).filter(Boolean);
  return refs.find((r) => r === `origin/${branch}`) ?? refs[0] ?? branch;
}

/** Parses `git diff --name-status -z`. */
export function parseNameStatus(out: string): WebsiteChange[] {
  const parts = out.split("\0").filter((p) => p !== "");
  const changes: WebsiteChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const from = parts[i++]!;
      const to = parts[i++]!;
      if (code.startsWith("R")) changes.push({ path: from, status: "deleted" });
      changes.push({ path: to, status: "added" });
    } else {
      const p = parts[i++]!;
      changes.push({ path: p, status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
    }
  }
  return changes;
}

/**
 * Files under gh-pages/ changed locally since this branch forked from <remote>/main: committed but
 * unmerged, uncommitted and untracked. These are what "Publish" turns into a pull request. Diffing
 * against the merge-base (not main itself) keeps newer upstream edits from looking like local ones.
 */
export async function websiteChanges(root: string, prefix = "gh-pages/"): Promise<WebsiteChange[]> {
  const base = await baseRef(root);
  const mb = await git(root, ["merge-base", "HEAD", base]);
  const forkPoint = mb.code === 0 && mb.out.trim() ? mb.out.trim() : base;
  const diff = await git(root, ["diff", "--name-status", "-z", "--no-renames", forkPoint, "--", prefix]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", prefix]);
  const changes = diff.code === 0 ? parseNameStatus(diff.out) : [];
  if (forkPoint !== base) {
    const upstream = await git(root, ["diff", "--name-only", "-z", forkPoint, base, "--", prefix]);
    const touched = new Set(upstream.out.split("\0").filter(Boolean));
    for (const c of changes) if (touched.has(c.path)) c.changedUpstream = true;
  }
  for (const p of untracked.out.split("\0").filter(Boolean)) {
    if (!changes.some((c) => c.path === p)) changes.push({ path: p, status: "untracked" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
