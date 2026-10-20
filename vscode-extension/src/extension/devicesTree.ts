import * as vscode from "vscode";
import { describeState, type AdbDevice } from "../core/adb/devices";
import type { DeviceManager } from "./deviceManager";

type Node = { kind: "device"; device: AdbDevice } | { kind: "detail"; label: string; description?: string; icon: string; tooltip?: string };

export class DevicesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly devices: DeviceManager) {
    this.subs.push(devices.onDidChangeDevices(() => this.changed.fire(undefined)));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "detail") {
      const item = new vscode.TreeItem(node.label);
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      return item;
    }
    const d = node.device;
    const selected = d.serial === this.devices.selectedSerial;
    const item = new vscode.TreeItem(this.devices.label(d), vscode.TreeItemCollapsibleState.Collapsed);
    const via = d.transport === "wifi" ? "Wi‑Fi" : d.transport === "emulator" ? "Emulator" : "USB";
    item.description = d.state === "device" ? `${via}${selected ? " · selected" : ""}` : describeState(d);
    item.iconPath = new vscode.ThemeIcon(
      d.state !== "device" ? "warning" : d.transport === "wifi" ? "broadcast" : d.transport === "emulator" ? "vm" : "device-mobile",
      selected ? new vscode.ThemeColor("charts.green") : undefined,
    );
    item.tooltip = new vscode.MarkdownString(`**${this.devices.label(d)}**  \n\`${d.serial}\`  \n${describeState(d)}`);
    item.id = `device:${d.serial}`;
    const state = d.state === "device" ? "ready" : d.state.replace(/\s+/g, "-");
    item.contextValue = `device.${state}${selected ? ".selected" : ""}.${d.transport}`;
    if (d.state === "device" && !selected) {
      item.command = { command: "localdesktop.devices.select", title: "Select", arguments: [d] };
    }
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.devices.devices.map((device) => ({ kind: "device", device }));
    if (node.kind !== "device") return [];
    const d = node.device;
    const details = this.devices.detailsOf(d.serial);
    const out: Node[] = [{ kind: "detail", label: d.serial, icon: "symbol-key", tooltip: "adb serial" }];
    if (d.state !== "device") {
      out.push({ kind: "detail", label: describeState(d), icon: "warning", tooltip: d.detail });
      return out;
    }
    const info = details?.info;
    if (info) {
      out.push({ kind: "detail", label: `Android ${info.release}`, description: `API ${info.sdk}`, icon: "info" });
      const ok = info.abi === "arm64-v8a";
      out.push({
        kind: "detail",
        label: info.abi || "unknown ABI",
        description: ok ? undefined : "not arm64 — can't run Local Desktop natively",
        icon: ok ? "chip" : "warning",
      });
    } else {
      out.push({ kind: "detail", label: "Loading…", icon: "loading~spin" });
    }
    const app = details?.app;
    if (app === null) out.push({ kind: "detail", label: "Local Desktop not installed", icon: "circle-slash" });
    else if (app) {
      out.push({
        kind: "detail",
        label: `Local Desktop ${app.versionName ?? "?"}`,
        description: app.debuggable ? "debuggable" : "release build",
        icon: app.debuggable ? "debug" : "package",
        tooltip: app.lastUpdateTime ? `Updated ${app.lastUpdateTime}` : undefined,
      });
    }
    return out;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
