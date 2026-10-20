import { randomBytes } from "node:crypto";

/** Repository events that ring the doorbell (push/workflow_job are too chatty for ntfy's quota). */
export const WEBHOOK_EVENTS = ["discussion", "discussion_comment", "workflow_run", "release", "pull_request", "member"];

/**
 * ntfy message template (Go text/template over the webhook JSON): a readable line for phone
 * notifications plus a machine tag `[ld:<kind>:<id>]` that clients turn into a refresh scope.
 * JSON numbers are float64 in Go templates (`1.23456789e+08`), so ids go through printf "%.0f".
 */
export const NTFY_MESSAGE_TEMPLATE =
  '{{if .discussion}}{{if .comment}}New message{{else}}Channel {{.action}}{{end}} in {{.discussion.title}} [ld:d:{{printf "%.0f" .discussion.number}}]' +
  '{{else if .workflow_run}}{{.workflow_run.name}} {{.workflow_run.status}}{{with .workflow_run.conclusion}} {{.}}{{end}} [ld:r:{{printf "%.0f" .workflow_run.id}}]' +
  '{{else if .release}}Release {{.release.tag_name}} {{.action}} [ld:rel:{{printf "%.0f" .release.id}}]' +
  '{{else if .pull_request}}PR #{{printf "%.0f" .pull_request.number}} {{.action}} [ld:pr:{{printf "%.0f" .pull_request.number}}]' +
  "{{else if .member}}Collaborator {{.action}} [ld:m:]" +
  '{{else if .zen}}Ping [ld:ping:{{printf "%.0f" .hook_id}}]' +
  "{{else}}[ld:x:]{{end}}";

/** Chat at default priority; CI noise at min priority so phones can mute it. */
export const NTFY_PRIORITY_TEMPLATE = "{{if .discussion}}3{{else}}1{{end}}";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function randomTopic(bytes: Uint8Array = randomBytes(10)): string {
  let out = "";
  for (const b of bytes) out += BASE32[b & 31];
  return `localdesktop-${out}`;
}

/** The URL GitHub posts to: the topic plus templating parameters. */
export function ntfyWebhookUrl(topicUrl: string): string {
  const base = topicUrl.replace(/\/+$/, "");
  const q = new URLSearchParams({
    template: "yes",
    title: "Local Desktop",
    priority: NTFY_PRIORITY_TEMPLATE,
    message: NTFY_MESSAGE_TEMPLATE,
  });
  return `${base}?${q.toString()}`;
}

/** `ntfy://host/topic` deep link for the ntfy phone app. */
export function ntfyAppLink(topicUrl: string): string {
  const u = new URL(topicUrl);
  return `ntfy://${u.host}${u.pathname}`;
}

/** Whether an existing hook URL targets this topic (ignoring template parameters). */
export function hookTargets(hookUrl: string | undefined, topicUrl: string): boolean {
  if (!hookUrl) return false;
  return hookUrl.split("?")[0]!.replace(/\/+$/, "") === topicUrl.replace(/\/+$/, "");
}
