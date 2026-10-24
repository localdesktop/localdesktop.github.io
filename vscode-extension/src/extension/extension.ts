import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activateChat } from "../chat";
import { GitHubAuth } from "../github/auth";
import { GitHub, UPSTREAM_REPO, workspaceRepo } from "../github/client";
import { activateRealtime } from "../realtime";
import { RealtimeHub } from "../realtime/hub";
import { activateReleases } from "../release";
import { activateWebsite } from "../website";
import { activateDebug } from "./debug";
import { registerDeviceCommands } from "./deviceCommands";
import { DeviceManager } from "./deviceManager";
import { DevicesTree } from "./devicesTree";
import { LogcatView } from "./logcatView";
import { activateMcp } from "./mcp";
import { findWorkspaceRoot, makeAppGetter, makeCoreGetter, readToolPaths, type Services } from "./services";
import { registerTaskProvider } from "./tasks";
import { registerCommand } from "./ui";
import { activateWireless } from "./wireless";

export function activate(context: vscode.ExtensionContext): Services {
  const output = vscode.window.createOutputChannel("Local Desktop", { log: true });
  context.subscriptions.push(output);

  const root = findWorkspaceRoot();
  const app = makeAppGetter(root);
  const appPackage = () => {
    try {
      return app().packageName;
    } catch {
      return undefined;
    }
  };

  const devices = new DeviceManager(root, readToolPaths, appPackage, output);
  const logcat = new LogcatView(root, devices, appPackage, output);
  const auth = new GitHubAuth(context);
  const github = new GitHub(output, { auth, repo: () => workspaceRepo(root), contextPrefix: "localdesktop", repoSetting: "localdesktop.repository" });
  const upstream = new GitHub(output, { auth, repo: async () => UPSTREAM_REPO, contextPrefix: "localdesktop.chat" });
  const hub = new RealtimeHub();
  context.subscriptions.push(devices, logcat, auth, github, upstream, hub);

  const services: Services = {
    context,
    root,
    output,
    devices,
    logcat,
    github,
    upstream,
    hub,
    toolPaths: readToolPaths,
    app,
    core: makeCoreGetter(root),
  };

  void vscode.commands.executeCommand(
    "setContext",
    "localdesktop.hasWebsite",
    Boolean(root && fs.existsSync(path.join(root, "gh-pages", "docusaurus.config.ts"))),
  );

  const tree = new DevicesTree(devices);
  context.subscriptions.push(tree, vscode.window.registerTreeDataProvider("localdesktop.devices", tree));

  registerTaskProvider(context, root, readToolPaths);
  registerDeviceCommands(services);
  registerCommand(context, "localdesktop.signIn", () => github.client(), output);
  registerCommand(context, "localdesktop.signInWithToken", () => github.auth.signInWithToken(), output);
  registerCommand(context, "localdesktop.signOut", () => github.auth.signOut(), output);

  // Feature modules; each registers its own commands and views.
  for (const [name, activateFeature] of [
    ["wireless", activateWireless],
    ["debug", activateDebug],
    ["mcp", activateMcp],
    ["realtime", activateRealtime],
    ["releases", activateReleases],
    ["website", activateWebsite],
    ["chat", activateChat],
  ] as const) {
    try {
      activateFeature(services);
    } catch (e) {
      output.error(`Failed to activate ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }

  devices.start();
  logcat.startIfConfigured();
  void github.tryClient();
  return services;
}

export function deactivate(): void {
  // disposables registered on the context clean up everything
}
