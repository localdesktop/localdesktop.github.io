import type { Release, WorkflowRun } from "./types";

/** The Play upload run for a release: release-triggered (head_branch = tag) or dispatched ("Upload <tag> to Google Play"). */
export function playRunFor(release: Pick<Release, "tag_name" | "name">, runs: readonly WorkflowRun[]): WorkflowRun | undefined {
  return runs.find(
    (r) =>
      (r.event === "release" && r.head_branch === release.tag_name) ||
      r.display_title === `Upload ${release.tag_name} to Google Play` ||
      (release.name !== null && r.event === "release" && r.display_title === release.name),
  );
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} days ago`;
  return `${Math.round(d / 30)} mo ago`;
}
