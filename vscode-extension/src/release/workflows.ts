import * as vscode from "vscode";
import { LdError } from "../core/errors";
import type { GitHubClient } from "../github/client";

/** Workflows the one-click actions dispatch. Forks may not have all of them. */
export const WORKFLOWS = {
  build: "build.yml",
  play: "google-play-console.yml",
  pages: "gh-pages.yml",
} as const;

export type WorkflowKey = keyof typeof WORKFLOWS;

/**
 * Which of the dispatchable workflows exist in the repository, exposed as the
 * `localdesktop.workflows.<key>` context keys so menus hide actions a fork can't run.
 */
export class WorkflowPresence {
  private readonly known = new Map<WorkflowKey, boolean>();
  private repo = "";

  async refresh(c: GitHubClient | undefined): Promise<void> {
    this.known.clear();
    this.repo = c?.repo.fullName ?? "";
    await Promise.all(
      (Object.keys(WORKFLOWS) as WorkflowKey[]).map(async (key) => {
        let present: boolean | undefined;
        if (c) {
          try {
            await c.rest.actions.getWorkflow({ ...c.params, workflow_id: WORKFLOWS[key] });
            present = true;
          } catch (e) {
            // Only a 404 means missing; other errors shouldn't hide actions.
            present = (e as { status?: number }).status === 404 ? false : undefined;
          }
        }
        if (present !== undefined) this.known.set(key, present);
        await vscode.commands.executeCommand("setContext", `localdesktop.workflows.${key}`, present ?? Boolean(c));
      }),
    );
  }

  /** Throws a clear error when the repository is known not to have the workflow. */
  require(key: WorkflowKey, action: string): void {
    if (this.known.get(key) === false) {
      throw new LdError("COMMAND_FAILED", `${this.repo} has no .github/workflows/${WORKFLOWS[key]}, so ${action} isn't available in this repository.`);
    }
  }
}
