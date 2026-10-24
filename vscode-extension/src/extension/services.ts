import * as vscode from "vscode";
import { createCoreContext, type CoreContext } from "../core/context";
import type { ToolPaths } from "../core/env";
import { LdError } from "../core/errors";
import { findRepoRoot, readAppInfo, type AppInfo } from "../core/workspace";
import type { GitHub } from "../github/client";
import type { RealtimeHub } from "../realtime/hub";
import type { DeviceManager } from "./deviceManager";
import type { LogcatView } from "./logcatView";

/** Shared services handed to every feature module (devices, debug, GitHub, website, chat). */
export interface Services {
  readonly context: vscode.ExtensionContext;
  /** Repository root, when the workspace is a Local Desktop checkout. */
  readonly root: string | undefined;
  readonly output: vscode.LogOutputChannel;
  readonly devices: DeviceManager;
  readonly logcat: LogcatView;
  /** The workspace's repository (a fork's own repo in a fork): Releases & CI, Website. */
  readonly github: GitHub;
  /** The main Local Desktop repository, even in a fork: chat and realtime. */
  readonly upstream: GitHub;
  readonly hub: RealtimeHub;
  toolPaths(): ToolPaths;
  /** Fresh app info (manifest.yaml can change, e.g. the package rename). Throws outside the repo. */
  app(): AppInfo;
  /** Core context for editor-independent operations. Throws outside the repo. */
  core(): CoreContext;
}

export function findWorkspaceRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const root = findRepoRoot(folder.uri.fsPath);
    if (root) return root;
  }
  return undefined;
}

export function readToolPaths(): ToolPaths {
  const c = vscode.workspace.getConfiguration("localdesktop");
  const s = (k: string) => c.get<string>(k)?.trim() || undefined;
  return {
    adbPath: s("adbPath"),
    xPath: s("xPath"),
    androidHome: s("androidHome"),
    lldbServerPath: s("lldbServerPath"),
    scrcpyPath: s("scrcpyPath"),
  };
}

export function requireRoot(root: string | undefined): string {
  if (!root) {
    throw new LdError("WORKSPACE_NOT_FOUND", "Open the Local Desktop repository (the folder with manifest.yaml) to use this command.");
  }
  return root;
}

export function makeAppGetter(root: string | undefined): () => AppInfo {
  return () => readAppInfo(requireRoot(root));
}

export function makeCoreGetter(root: string | undefined): () => CoreContext {
  return () => createCoreContext({ cwd: requireRoot(root), root: requireRoot(root), paths: readToolPaths() });
}
