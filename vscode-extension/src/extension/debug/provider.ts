import * as vscode from "vscode";
import { LdError } from "../../core/errors";
import type { Services } from "../services";
import { showError } from "../ui";
import type { LocalDesktopDebugConfig } from "./orchestrator";

export const DEBUG_TYPE = "localdesktop";

export function launchConfiguration(): LocalDesktopDebugConfig {
  return { type: DEBUG_TYPE, request: "launch", name: "Local Desktop: Debug on Android" };
}

export function attachConfiguration(): LocalDesktopDebugConfig {
  return { type: DEBUG_TYPE, request: "attach", name: "Local Desktop: Attach to Running App", pid: "${command:localdesktop.pickAppProcess}" };
}

/**
 * Fills defaults (F5 works without launch.json) and fixes the device serial before launch, so a
 * Restart reuses the same device instead of asking again.
 */
export class LocalDesktopConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly s: Services) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [launchConfiguration(), attachConfiguration()];
  }

  resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration | undefined {
    if (!config.type && !config.request && !config.name) {
      if (!this.s.root) {
        void vscode.window.showErrorMessage("Open the Local Desktop repository (the folder with manifest.yaml) to debug it.");
        return undefined;
      }
      config = launchConfiguration();
    }
    const c = config as LocalDesktopDebugConfig;
    c.device ??= "auto";
    if (c.request === "launch") {
      c.build ??= true;
      c.install ??= true;
      c.profile ??= "debug";
      c.stopAppOnDisconnect ??= true;
    }
    c.logcat ??= "rust";
    return c;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const c = config as LocalDesktopDebugConfig;
    try {
      if (!this.s.root) throw new LdError("WORKSPACE_NOT_FOUND", "Open the Local Desktop repository (the folder with manifest.yaml) to debug it.");
      if (c.request !== "launch" && c.request !== "attach") throw new LdError("INVALID_ARGUMENT", `Unknown request "${c.request}" (use launch or attach).`);
      const forcePick = c.device === "pick" && !c.serial;
      const device = await this.s.devices.resolve(c.serial ?? c.device, {
        forcePick,
        title: c.request === "attach" ? "Attach to Local Desktop on…" : "Debug Local Desktop on…",
      });
      c.serial = device.serial;
      if (c.request === "attach") {
        let pid = typeof c.pid === "number" ? c.pid : parseInt(String(c.pid ?? ""), 10);
        if (!Number.isFinite(pid)) {
          const picked = await vscode.commands.executeCommand<string | undefined>("localdesktop.pickAppProcess", { serial: device.serial });
          if (!picked) return undefined;
          pid = parseInt(picked, 10);
        }
        c.pid = pid;
      }
      return c;
    } catch (e) {
      await showError(e, this.s.output);
      return undefined;
    }
  }
}

/** Offered in the Run and Debug dropdown even without a launch.json. */
export class LocalDesktopDynamicProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly s: Services) {}

  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return this.s.root ? [launchConfiguration(), attachConfiguration()] : [];
  }
}
