import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { Adb } from "../core/adb/adb";
import { getPackageDump } from "../core/adb/app";
import { assertUsable, describeState, listDevices, resolveDevice, TrackDevicesParser, type AdbDevice } from "../core/adb/devices";
import { getDeviceInfo, type DeviceInfo } from "../core/adb/props";
import type { PackageDump } from "../core/adb/packages";
import { findAdb, type ToolPaths } from "../core/env";
import { LdError } from "../core/errors";
import { readState, statePath, updateState } from "../core/state";

export interface DeviceDetails {
  info?: DeviceInfo;
  app?: PackageDump | null;
}

interface PickItem extends vscode.QuickPickItem {
  device?: AdbDevice;
  command?: string;
}

/**
 * Tracks connected devices (adb track-devices, polling fallback), owns the selected device
 * (persisted in .localdesktop/state.json so agents use the same one), and shows it in the status bar.
 */
export class DeviceManager implements vscode.Disposable {
  private devicesList: AdbDevice[] = [];
  private selected: string | undefined;
  private tracker: ChildProcess | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly details = new Map<string, DeviceDetails>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly onDidChangeDevicesEmitter = new vscode.EventEmitter<AdbDevice[]>();
  private readonly onDidChangeSelectionEmitter = new vscode.EventEmitter<AdbDevice | undefined>();
  readonly onDidChangeDevices = this.onDidChangeDevicesEmitter.event;
  readonly onDidChangeSelection = this.onDidChangeSelectionEmitter.event;

  constructor(
    private readonly root: string | undefined,
    private readonly toolPaths: () => ToolPaths,
    private readonly appPackage: () => string | undefined,
    private readonly output: vscode.LogOutputChannel,
  ) {
    this.selected = root ? readState(root).selectedSerial : undefined;
    this.statusItem = vscode.window.createStatusBarItem("localdesktop.device", vscode.StatusBarAlignment.Left, 50);
    this.statusItem.name = "Local Desktop Device";
    this.statusItem.command = "localdesktop.devices.select";
  }

  get devices(): readonly AdbDevice[] {
    return this.devicesList;
  }

  get selectedSerial(): string | undefined {
    return this.selected;
  }

  get selectedDevice(): AdbDevice | undefined {
    return this.devicesList.find((d) => d.serial === this.selected);
  }

  detailsOf(serial: string): DeviceDetails | undefined {
    return this.details.get(serial);
  }

  /** adb without a serial; throws a helpful error when adb is missing. */
  adb(): Adb {
    return new Adb(findAdb(this.toolPaths()));
  }

  start(): void {
    void this.refresh();
    this.startTracking();
    this.watchSharedSelection();
  }

  /**
   * Another window (e.g. an Extension Development Host) or an agent's `select_device` may change
   * the selection in .localdesktop/state.json; follow it.
   */
  private watchSharedSelection(): void {
    if (!this.root) return;
    const file = statePath(this.root);
    fs.watchFile(file, { interval: 1000 }, () => {
      const shared = readState(this.root!).selectedSerial;
      if (shared === this.selected) return;
      this.selected = shared;
      this.renderStatus();
      this.onDidChangeSelectionEmitter.fire(this.selectedDevice);
      this.onDidChangeDevicesEmitter.fire(this.devicesList);
    });
  }

  async refresh(): Promise<void> {
    try {
      this.update(await listDevices(this.adb()));
    } catch (e) {
      this.output.warn(`Device refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      this.update([]);
    }
  }

  private startTracking(): void {
    let adbPath: string;
    try {
      adbPath = findAdb(this.toolPaths());
    } catch {
      this.schedulePoll(10_000);
      return;
    }
    const parser = new TrackDevicesParser();
    const child = spawn(adbPath, ["track-devices", "-l"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.tracker = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const snapshot of parser.push(chunk)) this.update(snapshot);
    });
    child.on("error", () => undefined);
    child.on("close", () => {
      if (this.disposed || this.tracker !== child) return;
      this.tracker = undefined;
      // adb server restarted or track-devices unsupported: poll, and retry tracking later.
      this.schedulePoll(3000);
      setTimeout(() => {
        if (!this.disposed && !this.tracker) {
          if (this.pollTimer) clearTimeout(this.pollTimer);
          this.pollTimer = undefined;
          this.startTracking();
        }
      }, 15_000);
    });
  }

  private schedulePoll(ms: number): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = undefined;
      await this.refresh();
      if (!this.tracker) this.schedulePoll(ms);
    }, ms);
  }

  private update(devices: AdbDevice[]): void {
    const before = JSON.stringify(this.devicesList);
    this.devicesList = devices;
    for (const serial of [...this.details.keys()]) {
      if (!devices.some((d) => d.serial === serial && d.state === "device")) this.details.delete(serial);
    }
    // Keep the selection usable: auto-select the only ready device.
    if (!this.selectedDevice) {
      const only = resolveDevice(devices, {});
      if (only && only.state === "device" && only.serial !== this.selected) this.setSelected(only.serial, false);
    }
    void vscode.commands.executeCommand("setContext", "localdesktop.devices.count", devices.length);
    void vscode.commands.executeCommand("setContext", "localdesktop.devices.available", devices.some((d) => d.state === "device"));
    this.renderStatus();
    if (JSON.stringify(devices) !== before) {
      this.onDidChangeDevicesEmitter.fire(devices);
      for (const d of devices) if (d.state === "device" && !this.details.has(d.serial)) void this.loadDetails(d.serial);
    }
  }

  async loadDetails(serial: string): Promise<DeviceDetails> {
    const adb = this.adb().forDevice(serial);
    const pkg = this.appPackage();
    const entry: DeviceDetails = this.details.get(serial) ?? {};
    this.details.set(serial, entry);
    try {
      entry.info = await getDeviceInfo(adb);
      entry.app = pkg ? ((await getPackageDump(adb, pkg)) ?? null) : undefined;
    } catch (e) {
      this.output.debug(`Couldn't read details of ${serial}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.renderStatus();
    this.onDidChangeDevicesEmitter.fire(this.devicesList);
    return entry;
  }

  async info(serial: string): Promise<DeviceInfo> {
    const cached = this.details.get(serial)?.info;
    if (cached) return cached;
    const d = await this.loadDetails(serial);
    if (!d.info) throw new LdError("DEVICE_OFFLINE", `Couldn't read device properties of ${serial}.`);
    return d.info;
  }

  setSelected(serial: string | undefined, notify = true): void {
    this.selected = serial;
    if (this.root) {
      updateState(this.root, (s) => {
        s.selectedSerial = serial;
      });
    }
    this.renderStatus();
    this.onDidChangeSelectionEmitter.fire(this.selectedDevice);
    if (notify) this.onDidChangeDevicesEmitter.fire(this.devicesList);
  }

  label(d: AdbDevice): string {
    const info = this.details.get(d.serial)?.info;
    return info?.model || d.model || d.serial;
  }

  private renderStatus(): void {
    const d = this.selectedDevice;
    if (!d) {
      this.statusItem.text = this.devicesList.length ? "$(device-mobile) Select device" : "$(device-mobile) No device";
      this.statusItem.tooltip = "Local Desktop: choose the Android device for build, debug and agent tools";
    } else {
      const via = d.transport === "wifi" ? "Wi‑Fi" : d.transport === "emulator" ? "Emulator" : "USB";
      const warn = d.state === "device" ? "" : " $(warning)";
      this.statusItem.text = `$(device-mobile) ${this.label(d)} (${via})${warn}`;
      this.statusItem.tooltip = `${d.serial} — ${describeState(d)}`;
    }
    this.statusItem.show();
  }

  /**
   * Returns the device to use: `serial` if given, else the selection/only device, else asks.
   * Throws CANCELLED if the user dismisses the picker.
   */
  async resolve(serial?: string, opts: { forcePick?: boolean; title?: string } = {}): Promise<AdbDevice> {
    if (!this.devicesList.length) await this.refresh();
    let device: AdbDevice | undefined;
    if (!opts.forcePick) {
      device = resolveDevice(this.devicesList, {
        serial,
        envSerial: process.env.ANDROID_SERIAL,
        selectedSerial: this.selected,
      });
    }
    if (!device) device = await this.pick(opts.title);
    assertUsable(device);
    return device;
  }

  /** QuickPick of devices plus pairing/connect actions (which re-open the picker afterwards). */
  async pick(title = "Select an Android device"): Promise<AdbDevice> {
    for (;;) {
      const items: PickItem[] = this.devicesList.map((d) => {
        const info = this.details.get(d.serial)?.info;
        const via = d.transport === "wifi" ? "$(broadcast) Wi‑Fi" : d.transport === "emulator" ? "$(vm) Emulator" : "$(plug) USB";
        return {
          label: `${d.serial === this.selected ? "$(check) " : ""}${this.label(d)}`,
          description: `${via} · ${d.serial}`,
          detail: d.state === "device" ? (info ? `Android ${info.release} (API ${info.sdk}) · ${info.abi}` : undefined) : `⚠ ${describeState(d)}`,
          device: d,
        };
      });
      items.push(
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(broadcast) Pair over Wi‑Fi (QR code)…", command: "localdesktop.devices.pairQr" },
        { label: "$(key) Pair over Wi‑Fi (pairing code)…", command: "localdesktop.devices.pairCode" },
        { label: "$(plug) Connect to ip:port…", command: "localdesktop.devices.connect" },
        { label: "$(refresh) Refresh", command: "refresh" },
      );
      const choice = await vscode.window.showQuickPick(items, { title, placeHolder: this.devicesList.length ? undefined : "No devices connected yet", ignoreFocusOut: true });
      if (!choice) throw new LdError("CANCELLED", "No device selected.");
      if (choice.device) {
        this.setSelected(choice.device.serial);
        return choice.device;
      }
      if (choice.command === "refresh") await this.refresh();
      else if (choice.command) {
        await vscode.commands.executeCommand(choice.command);
        await this.refresh();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.root) fs.unwatchFile(statePath(this.root));
    this.tracker?.kill();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.statusItem.dispose();
    this.onDidChangeDevicesEmitter.dispose();
    this.onDidChangeSelectionEmitter.dispose();
  }
}
