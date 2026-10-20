import { createHash } from "node:crypto";

// Pure helpers behind the release-notes editor (notesFs.ts).

export function hashText(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

export interface RemoteSnapshot {
  updatedAt: string;
  bodyHash: string;
}

/**
 * Whether saving would overwrite someone else's edit made since the file was opened. `updated_at`
 * also changes for unrelated edits (labels, title), so only a different body counts as a conflict.
 */
export function detectConflict(openedWith: RemoteSnapshot | undefined, current: RemoteSnapshot): boolean {
  if (!openedWith) return false;
  // Releases have no updated_at (""), so they always fall through to the body comparison.
  if (openedWith.updatedAt && openedWith.updatedAt === current.updatedAt) return false;
  return openedWith.bodyHash !== current.bodyHash;
}

/** Commit subjects since the last release, as a starting point for empty release notes. */
export function draftFromCommits(subjects: readonly string[], sinceTag: string | undefined): string {
  const useful = subjects
    .map((s) => s.split(/\r?\n/)[0]!.trim())
    .filter((s) => s && !/^chore: set version to v/i.test(s) && !/^Merge (branch|pull request)/.test(s));
  const lines = [...new Set(useful)].map((s) => `- ${s}`);
  return `## What's changed${sinceTag ? ` since ${sinceTag}` : ""}\n\n${lines.join("\n") || "- "}\n`;
}
