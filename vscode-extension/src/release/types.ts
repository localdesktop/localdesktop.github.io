// The subset of GitHub REST shapes the Releases & CI view uses.

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  download_count: number;
  browser_download_url: string;
  /** API URL; with Accept: application/octet-stream it redirects to the file. */
  url: string;
  digest?: string | null;
  content_type?: string;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string | null;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export interface WorkflowRun {
  id: number;
  name?: string | null;
  display_title: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  path: string;
  run_number: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: { login: string } | null;
}

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  digest?: string | null;
  archive_download_url: string;
  workflow_run?: { id?: number; head_branch?: string | null; head_sha?: string } | null;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  draft?: boolean;
  labels: { name: string }[];
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

export function isRunActive(run: Pick<WorkflowRun, "status">): boolean {
  return run.status !== "completed";
}

export function workflowFile(run: Pick<WorkflowRun, "path">): string {
  return run.path.replace(/^\.github\/workflows\//, "").replace(/@.*$/, "");
}
