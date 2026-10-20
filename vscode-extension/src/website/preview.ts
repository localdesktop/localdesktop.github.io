import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import { LdError } from "../core/errors";
import { sleep } from "../core/exec";
import { runTask } from "../extension/tasks";

const TASK_SOURCE = "localdesktop-website";

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export async function findFreePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) if (await isPortFree(p)) return p;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function respond(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function shellTask(site: string, name: string, command: string, background: boolean): vscode.Task {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(site)) ?? vscode.TaskScope.Workspace;
  const task = new vscode.Task({ type: "shell", task: name }, folder, name, TASK_SOURCE, new vscode.ShellExecution(command, { cwd: site }), []);
  task.isBackground = background;
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  return task;
}

/** Runs the Docusaurus dev server (`pnpm start`) as a background task and opens pages in the Simple Browser. */
export class WebsitePreview implements vscode.Disposable {
  private execution: vscode.TaskExecution | undefined;
  private port: number | undefined;
  private starting: Promise<string> | undefined;
  private readonly sub: vscode.Disposable;

  constructor(private readonly root: string) {
    this.sub = vscode.tasks.onDidEndTask((e) => {
      if (e.execution === this.execution) {
        this.execution = undefined;
        this.port = undefined;
      }
    });
  }

  private get site(): string {
    return path.join(this.root, "gh-pages");
  }

  /** Base URL of the running server, starting it if needed. */
  ensureRunning(): Promise<string> {
    if (this.execution && this.port) return Promise.resolve(`http://localhost:${this.port}`);
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<string> {
    if (!fs.existsSync(path.join(this.site, "node_modules"))) {
      const code = await runTask(shellTask(this.site, "Install website dependencies", "pnpm install --frozen-lockfile", false));
      if (code !== 0) throw new LdError("COMMAND_FAILED", "pnpm install failed in gh-pages/.", "Is pnpm installed? (`npm i -g pnpm` or `corepack enable`)");
    }
    const preferred = vscode.workspace.getConfiguration("localdesktop").get<number>("website.previewPort", 3000);
    const port = await findFreePort(preferred);
    this.execution = await vscode.tasks.executeTask(shellTask(this.site, "Website preview", `pnpm start --port ${port} --no-open`, true));
    this.port = port;
    const url = `http://localhost:${port}`;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Starting the website preview…", cancellable: true },
      async (_p, token) => {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          if (token.isCancellationRequested) throw new LdError("CANCELLED", "Preview cancelled.");
          if (!this.execution) throw new LdError("COMMAND_FAILED", "The preview server stopped.", "See the “Website preview” terminal.");
          if (await respond(`${url}/`)) return url;
          await sleep(1000);
        }
        throw new LdError("TIMEOUT", "The preview server didn't start within 3 minutes.");
      },
    );
  }

  async open(pagePath = "/"): Promise<void> {
    const base = await this.ensureRunning();
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(`${base}${pagePath}`));
    await vscode.commands.executeCommand("simpleBrowser.show", external.toString());
  }

  /** `pnpm build` (onBrokenLinks: "throw" makes this the link check). */
  async build(): Promise<boolean> {
    const code = await runTask(shellTask(this.site, "Build website", fs.existsSync(path.join(this.site, "node_modules")) ? "pnpm build" : "pnpm install --frozen-lockfile && pnpm build", false));
    return code === 0;
  }

  dispose(): void {
    this.sub.dispose();
    this.execution?.terminate();
  }
}
