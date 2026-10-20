import * as vscode from "vscode";
import { compareVersions } from "../../core/env";
import { LdError } from "../../core/errors";

export const CODELLDB_ID = "vadimcn.vscode-lldb";
/** 1.11.2 and 1.11.3 can't attach with a dummy target ("no process found with process ID"). */
const BROKEN = new Set(["1.11.2", "1.11.3"]);
const MINIMUM = "1.11.4";

export interface CodeLldbStatus {
  installed: boolean;
  version?: string;
  ok: boolean;
}

export function codeLldbStatus(): CodeLldbStatus {
  const ext = vscode.extensions.getExtension(CODELLDB_ID);
  const version: string | undefined = ext?.packageJSON?.version;
  if (!ext) return { installed: false, ok: false };
  const ok = !version || (!BROKEN.has(version) && compareVersions(version, "1.11.0") >= 0);
  return { installed: true, version, ok };
}

/** Makes sure CodeLLDB can attach; offers to install or update it. Throws CODELLDB_MISSING otherwise. */
export async function ensureCodeLldb(): Promise<void> {
  let status = codeLldbStatus();
  if (status.ok) return;
  const action = status.installed ? "Update CodeLLDB" : "Install CodeLLDB";
  const message = status.installed
    ? `CodeLLDB ${status.version} can't attach to Android processes; ${MINIMUM} or newer is needed for breakpoints.`
    : "Breakpoints need the CodeLLDB extension (vadimcn.vscode-lldb).";
  const choice = await vscode.window.showErrorMessage(message, action, "Run Without Debugging");
  if (choice === action) {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", CODELLDB_ID);
    status = codeLldbStatus();
    if (status.ok) return;
    throw new LdError("CODELLDB_MISSING", "CodeLLDB was installed/updated; reload the window, then press F5 again.");
  }
  if (choice === "Run Without Debugging") throw new LdError("CODELLDB_MISSING", "RUN_WITHOUT_DEBUGGING");
  throw new LdError("CODELLDB_MISSING", message, `Install ${CODELLDB_ID} ${MINIMUM} or newer.`);
}
