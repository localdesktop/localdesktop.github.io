import * as vscode from "vscode";
import { installXbuildCommand, xbuildCommand } from "../core/build";
import type { ToolPaths } from "../core/env";
import { LdError } from "../core/errors";
import type { Profile } from "../core/workspace";

export const TASK_TYPE = "localdesktop";

interface LdTaskDefinition extends vscode.TaskDefinition {
  command: "build" | "installXbuild";
  profile?: Profile;
  format?: "apk" | "aab";
}

function makeTask(root: string, def: LdTaskDefinition, paths: ToolPaths, folder: vscode.WorkspaceFolder | vscode.TaskScope): vscode.Task {
  if (def.command === "installXbuild") {
    const cmd = installXbuildCommand(root);
    const task = new vscode.Task(def, folder, "Install patched xbuild", TASK_TYPE, new vscode.ProcessExecution(cmd.command, cmd.args, { cwd: cmd.cwd }), []);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
    return task;
  }
  const profile = def.profile ?? "debug";
  const format = def.format ?? "apk";
  const cmd = xbuildCommand(root, profile, format, paths);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cmd.env)) if (v !== undefined && process.env[k] !== v) env[k] = v;
  const task = new vscode.Task(
    def,
    folder,
    `Build ${profile} ${format.toUpperCase()}`,
    TASK_TYPE,
    new vscode.ProcessExecution(cmd.command, cmd.args, { cwd: cmd.cwd, env }),
    ["$localdesktop-rustc"],
  );
  task.group = vscode.TaskGroup.Build;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true, panel: vscode.TaskPanelKind.Dedicated };
  return task;
}

export function registerTaskProvider(context: vscode.ExtensionContext, root: string | undefined, paths: () => ToolPaths): void {
  if (!root) return;
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(TASK_TYPE, {
      provideTasks: () => {
        const folder = folderFor(root);
        const out: vscode.Task[] = [];
        for (const profile of ["debug", "release"] as const) {
          try {
            out.push(makeTask(root, { type: TASK_TYPE, command: "build", profile }, paths(), folder));
          } catch {
            // x missing: the doctor/installXbuild command explains it
          }
        }
        out.push(makeTask(root, { type: TASK_TYPE, command: "installXbuild" }, paths(), folder));
        return out;
      },
      resolveTask: (task) => {
        const def = task.definition as LdTaskDefinition;
        return makeTask(root, def, paths(), task.scope ?? folderFor(root));
      },
    }),
  );
}

function folderFor(root: string): vscode.WorkspaceFolder | vscode.TaskScope {
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ?? vscode.TaskScope.Workspace;
}

/** Runs a task and resolves with its exit code (undefined if it was terminated). */
export async function runTask(task: vscode.Task, token?: vscode.CancellationToken): Promise<number | undefined> {
  const execution = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const subs: vscode.Disposable[] = [];
    const finish = (code: number | undefined) => {
      subs.forEach((s) => s.dispose());
      resolve(code);
    };
    subs.push(
      vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === execution) finish(e.exitCode);
      }),
      vscode.tasks.onDidEndTask((e) => {
        // Fires without onDidEndTaskProcess when the task couldn't start.
        if (e.execution === execution) setTimeout(() => finish(undefined), 500);
      }),
    );
    if (token) {
      subs.push(
        token.onCancellationRequested(() => {
          execution.terminate();
        }),
      );
    }
  });
}

/** Builds the APK through a visible task (problem matcher → Problems view). Throws on failure. */
export async function buildWithTask(root: string, profile: Profile, paths: ToolPaths, token?: vscode.CancellationToken, format: "apk" | "aab" = "apk"): Promise<void> {
  const task = makeTask(root, { type: TASK_TYPE, command: "build", profile, format }, paths, folderFor(root));
  const code = await runTask(task, token);
  if (token?.isCancellationRequested) throw new LdError("CANCELLED", "Build cancelled.");
  if (code !== 0) {
    throw new LdError("BUILD_FAILED", `xbuild failed${code === undefined ? "" : ` (exit ${code})`}.`, "See the Terminal and Problems view.");
  }
}

export async function installXbuildWithTask(root: string): Promise<boolean> {
  const task = makeTask(root, { type: TASK_TYPE, command: "installXbuild" }, {}, folderFor(root));
  return (await runTask(task)) === 0;
}
