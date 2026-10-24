import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { parseWebviewMessage, type HostToWebview } from "../shared/messages";
import type { ChatController, ChatSurface } from "./controller";

/**
 * Strict CSP: scripts only by nonce, no network from the webview (the host does all fetching),
 * images only from GitHub's avatar/camo hosts.
 */
export function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chat.css"));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: https://avatars.githubusercontent.com https://camo.githubusercontent.com https://github.com https://*.githubusercontent.com`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Maintainer chat</title>
</head>
<body>
<div id="app" class="app"><p class="muted center">Loading chat…</p></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function wire(webview: vscode.Webview, controller: ChatController, isVisible: () => boolean, disposables: vscode.Disposable[]): void {
  const surface: ChatSurface = {
    post: (m: HostToWebview) => void webview.postMessage(m),
    get visible() {
      return isVisible();
    },
  };
  disposables.push(
    controller.attach(surface),
    webview.onDidReceiveMessage((raw) => {
      const msg = parseWebviewMessage(raw);
      if (msg) void controller.handle(msg);
    }),
  );
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
  ) {
    this.disposables.push(
      controller.onDidChangeUnread((n) => {
        if (this.view) this.view.badge = n > 0 ? { value: n, tooltip: `${n} unread message${n === 1 ? "" : "s"}` } : undefined;
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.html = chatHtml(view.webview, this.extensionUri);
    const subs: vscode.Disposable[] = [];
    wire(view.webview, this.controller, () => view.visible, subs);
    subs.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.controller.handle({ type: "markRead" });
      }),
    );
    view.onDidDispose(() => {
      subs.forEach((d) => d.dispose());
      this.view = undefined;
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** `Local Desktop: Open Chat in Editor`: the same chat in an editor tab. */
export function openChatPanel(extensionUri: vscode.Uri, controller: ChatController): void {
  const panel = vscode.window.createWebviewPanel("localdesktop.chatPanel", "Maintainer Chat", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: false,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist"), vscode.Uri.joinPath(extensionUri, "media")],
  });
  panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "activitybar.svg");
  panel.webview.html = chatHtml(panel.webview, extensionUri);
  const subs: vscode.Disposable[] = [];
  wire(panel.webview, controller, () => panel.visible, subs);
  panel.onDidDispose(() => subs.forEach((d) => d.dispose()));
}
