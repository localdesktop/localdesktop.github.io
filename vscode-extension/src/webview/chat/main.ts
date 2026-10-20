import DOMPurify from "dompurify";
import type { HostToWebview, WebviewToHost } from "../../shared/messages";
import { createChatUi, type LocalState } from "./ui";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): LocalState | undefined;
  setState(state: LocalState): void;
};

const vscode = acquireVsCodeApi();
const ui = createChatUi(document.getElementById("app")!, {
  post: (m) => vscode.postMessage(m),
  purify: DOMPurify,
  initial: vscode.getState(),
  save: (s) => vscode.setState(s),
});

window.addEventListener("message", (e: MessageEvent<HostToWebview>) => ui.receive(e.data));
window.addEventListener("focus", () => vscode.postMessage({ type: "markRead" }));
vscode.postMessage({ type: "ready" });
