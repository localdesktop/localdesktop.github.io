import * as vscode from "vscode";
import { errorMessage, isLdError } from "../core/errors";

/** Shows an error with its hint; LdErrors are expected failures, anything else is logged too. */
export async function showError(e: unknown, output?: vscode.LogOutputChannel, ...actions: string[]): Promise<string | undefined> {
  if (isLdError(e, "CANCELLED")) return undefined;
  if (!isLdError(e)) output?.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  const message = isLdError(e) ? e.message : errorMessage(e);
  const hint = isLdError(e) ? e.hint : undefined;
  return vscode.window.showErrorMessage(hint ? `${message} ${hint}` : message, ...actions);
}

/** Registers a command whose failures surface as error notifications instead of silent rejections. */
export function registerCommand(
  context: vscode.ExtensionContext,
  id: string,
  handler: (...args: any[]) => unknown,
  output?: vscode.LogOutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (e) {
        await showError(e, output);
        return undefined;
      }
    }),
  );
}

export function withProgress<T>(title: string, task: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, task);
}

/** Bridges a CancellationToken to an AbortSignal for core operations. */
export function abortSignal(token: vscode.CancellationToken): AbortSignal {
  const ctrl = new AbortController();
  if (token.isCancellationRequested) ctrl.abort();
  token.onCancellationRequested(() => ctrl.abort());
  return ctrl.signal;
}
