import * as path from "node:path";
import * as vscode from "vscode";
import type { Services } from "./services";
import { registerCommand } from "./ui";

/** Environment for the MCP server: repo root and the user's tool path overrides. */
function serverEnv(s: Services): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  if (s.root) env.LOCALDESKTOP_ROOT = s.root;
  const p = s.toolPaths();
  if (p.adbPath) env.LOCALDESKTOP_ADB = p.adbPath;
  if (p.xPath) env.LOCALDESKTOP_X = p.xPath;
  if (p.androidHome) env.LOCALDESKTOP_ANDROID_HOME = p.androidHome;
  if (p.lldbServerPath) env.LOCALDESKTOP_LLDB_SERVER = p.lldbServerPath;
  if (p.scrcpyPath) env.LOCALDESKTOP_SCRCPY = p.scrcpyPath;
  return env;
}

/**
 * Offers the device tools to the editor's built-in agent (Copilot agent mode) through the MCP
 * server definition API, running the bundled server with the editor's own Node (no Node on PATH
 * needed). Claude Code, Codex and Cursor use the committed .mcp.json / .cursor/mcp.json instead.
 */
export function activateMcp(s: Services): void {
  const { context } = s;
  const mcpJs = path.join(context.extensionPath, "dist", "mcp.js");
  const lm = (vscode as unknown as { lm?: { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider } }).lm;
  if (s.root && lm?.registerMcpServerDefinitionProvider && typeof vscode.McpStdioServerDefinition === "function") {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("localdesktop")) changed.fire();
      }),
      lm.registerMcpServerDefinitionProvider("localdesktop.mcp", {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => {
          if (!vscode.workspace.getConfiguration("localdesktop").get<boolean>("mcp.enabled", true)) return [];
          const version = String(context.extension.packageJSON.version ?? "0.0.0");
          return [new vscode.McpStdioServerDefinition("Local Desktop devices", process.execPath, [mcpJs], serverEnv(s), version)];
        },
      }),
    );
  }

  registerCommand(
    context,
    "localdesktop.agent.setup",
    async () => {
      const root = s.root;
      const launcher = root ? path.join(root, "vscode-extension", "bin", "localdesktop-mcp.cjs") : mcpJs;
      const cli = root ? "node vscode-extension/bin/localdesktop.cjs" : `node "${path.join(context.extensionPath, "dist", "cli.js")}"`;
      const items: (vscode.QuickPickItem & { run: () => Thenable<unknown> | void })[] = [
        {
          label: "$(terminal) Claude Code",
          detail: "Uses the committed .mcp.json — approve the “localdesktop” server when Claude Code asks.",
          run: () => openFile(root, ".mcp.json"),
        },
        {
          label: "$(copy) Codex CLI",
          detail: "Copies a `codex mcp add` command (Codex needs an absolute path).",
          run: async () => {
            await vscode.env.clipboard.writeText(`codex mcp add localdesktop -- node "${launcher}"`);
            void vscode.window.showInformationMessage("Copied. Paste it in a terminal to register the Local Desktop tools with Codex.");
          },
        },
        {
          label: "$(sparkle) Cursor",
          detail: "Uses the committed .cursor/mcp.json — enable “localdesktop” under Cursor Settings → MCP.",
          run: () => openFile(root, path.join(".cursor", "mcp.json")),
        },
        {
          label: "$(copilot) Copilot / built-in agent",
          detail: vscode.workspace.getConfiguration("localdesktop").get<boolean>("mcp.enabled", true)
            ? "Already offered via the editor's MCP API (setting localdesktop.mcp.enabled)."
            : "Turn on localdesktop.mcp.enabled to offer the tools to the built-in agent.",
          run: () => vscode.commands.executeCommand("workbench.action.openSettings", "localdesktop.mcp.enabled"),
        },
        {
          label: "$(console) Shell-only agents",
          detail: `Same tools as a CLI: ${cli} help`,
          run: async () => {
            await vscode.env.clipboard.writeText(`${cli} help`);
            void vscode.window.showInformationMessage("Copied the CLI command.");
          },
        },
        { label: "$(book) Open AGENTS.md", detail: "What the tools do and how agents should use them.", run: () => openFile(root, "AGENTS.md") },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: "Give coding agents access to the device (logs, screen, input, audio)", matchOnDetail: true });
      await pick?.run();
    },
    s.output,
  );
}

async function openFile(root: string | undefined, rel: string): Promise<void> {
  if (!root) {
    void vscode.window.showWarningMessage("Open the Local Desktop repository first.");
    return;
  }
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path.join(root, rel)));
}
