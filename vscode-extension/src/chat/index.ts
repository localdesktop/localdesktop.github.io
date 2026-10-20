import * as vscode from "vscode";
import type { Services } from "../extension/services";
import { registerCommand } from "../extension/ui";
import { ChatViewProvider, openChatPanel } from "./chatView";
import { ChatController } from "./controller";
import { runChatSetup } from "./setup";

/** Maintainer chat on GitHub Discussions with per-channel E2E encryption. */
export function activateChat(s: Services): void {
  const controller = new ChatController(s);
  const provider = new ChatViewProvider(s.context.extensionUri, controller);
  s.context.subscriptions.push(
    controller,
    provider,
    vscode.window.registerWebviewViewProvider("localdesktop.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
  );
  const reg = (id: string, fn: () => unknown) => registerCommand(s.context, id, fn, s.output);
  reg("localdesktop.chat.setup", () => runChatSetup(s, () => controller.reload()));
  reg("localdesktop.chat.newChannel", () => controller.command("newChannel"));
  reg("localdesktop.chat.setPrivacy", () => controller.command("setPrivacy"));
  reg("localdesktop.chat.rotateKey", () => controller.command("rotateKey"));
  reg("localdesktop.chat.manageDevices", () => controller.command("manageDevices"));
  reg("localdesktop.chat.openInPanel", () => openChatPanel(s.context.extensionUri, controller));
}
