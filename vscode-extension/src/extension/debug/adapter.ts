import { DebugSession, OutputEvent, TerminatedEvent } from "@vscode/debugadapter";
import * as vscode from "vscode";
import { isLdError } from "../../core/errors";
import type { Services } from "../services";
import { DebugOrchestrator, type LocalDesktopDebugConfig } from "./orchestrator";

type InitializeResponse = Parameters<DebugSession["initializeRequest"]>[0];
type LaunchResponse = Parameters<DebugSession["launchRequest"]>[0];
type LaunchArgs = Parameters<DebugSession["launchRequest"]>[1];
type AttachResponse = Parameters<DebugSession["attachRequest"]>[0];
type DisconnectResponse = Parameters<DebugSession["disconnectRequest"]>[0];
type TerminateResponse = Parameters<DebugSession["terminateRequest"]>[0];
type AnyResponse = LaunchResponse | AttachResponse;

/**
 * The `localdesktop` debug adapter, running inside the extension host. It never sends
 * `initialized`, so VS Code routes breakpoints only to the CodeLLDB child session it starts.
 */
export class LocalDesktopDebugAdapter extends DebugSession {
  private readonly orchestrator: DebugOrchestrator;
  private ended = false;

  constructor(
    services: Services,
    private readonly session: vscode.DebugSession,
  ) {
    super();
    this.orchestrator = new DebugOrchestrator(
      services,
      session,
      {
        log: (message) => this.sendEvent(new OutputEvent(`${message}\n`, "console")),
        output: (text, category) => this.sendEvent(new OutputEvent(text, category)),
      },
      (reason) => void this.end(reason),
    );
  }

  protected override initializeRequest(response: InitializeResponse): void {
    response.body = { ...response.body, supportsTerminateRequest: true };
    this.sendResponse(response);
  }

  protected override async launchRequest(response: LaunchResponse, args: LaunchArgs): Promise<void> {
    const config = this.session.configuration as LocalDesktopDebugConfig;
    const noDebug = Boolean((args as { noDebug?: boolean }).noDebug ?? config.noDebug);
    await this.run(response, () => this.orchestrator.launch(config, noDebug));
  }

  protected override async attachRequest(response: AttachResponse): Promise<void> {
    await this.run(response, () => this.orchestrator.attach(this.session.configuration as LocalDesktopDebugConfig));
  }

  private async run(response: AnyResponse, task: () => Promise<void>): Promise<void> {
    try {
      await task();
      this.sendResponse(response);
    } catch (e) {
      await this.orchestrator.dispose();
      if (isLdError(e, "CANCELLED")) {
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
        return;
      }
      const text = isLdError(e) ? (e.hint ? `${e.message} ${e.hint}` : e.message) : e instanceof Error ? e.message : String(e);
      this.sendEvent(new OutputEvent(`${text}\n`, "stderr"));
      response.success = false;
      response.message = text;
      this.sendResponse(response);
    }
  }

  protected override async disconnectRequest(response: DisconnectResponse): Promise<void> {
    await this.orchestrator.dispose();
    this.sendResponse(response);
  }

  protected override async terminateRequest(response: TerminateResponse): Promise<void> {
    await this.orchestrator.dispose();
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  private async end(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.sendEvent(new OutputEvent(`Session ended: ${reason}.\n`, "console"));
    await this.orchestrator.dispose();
    this.sendEvent(new TerminatedEvent());
  }
}
