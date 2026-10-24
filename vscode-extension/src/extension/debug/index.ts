import * as vscode from "vscode";
import type { Services } from "../services";
import { LocalDesktopDebugAdapter } from "./adapter";
import { DEBUG_TYPE, LocalDesktopConfigurationProvider, LocalDesktopDynamicProvider } from "./provider";

/** F5 debugging (launch/attach/noDebug) — debug orchestrator + CodeLLDB child sessions. */
export function activateDebug(services: Services): void {
  services.context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new LocalDesktopConfigurationProvider(services)),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new LocalDesktopDynamicProvider(services), vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor: (session) => new vscode.DebugAdapterInlineImplementation(new LocalDesktopDebugAdapter(services, session)),
    }),
  );
}
