import { Adb } from "./adb/adb";
import { assertUsable, listDevices, resolveDevice, type AdbDevice } from "./adb/devices";
import { findAdb, type ToolPaths } from "./env";
import { LdError } from "./errors";
import { readState } from "./state";
import { readAppInfo, requireRepoRoot, type AppInfo } from "./workspace";

/** Everything a device operation needs, independent of the editor. */
export interface CoreContext {
  root: string;
  app: AppInfo;
  paths: ToolPaths;
  /** adb without a serial (for `devices`, `connect`, `pair`). */
  adb: Adb;
  env: NodeJS.ProcessEnv;
}

export function createCoreContext(opts: { cwd: string; root?: string; paths?: ToolPaths; env?: NodeJS.ProcessEnv }): CoreContext {
  const env = opts.env ?? process.env;
  const root = opts.root ?? requireRepoRoot(opts.cwd);
  const paths = opts.paths ?? {};
  return { root, app: readAppInfo(root), paths, adb: new Adb(findAdb(paths, env)), env };
}

export interface DeviceHandle {
  adb: Adb;
  device: AdbDevice;
}

/**
 * Resolves the target device for non-interactive callers (CLI/MCP): explicit serial, then
 * $ANDROID_SERIAL, then the editor's selection in .localdesktop/state.json, then the only device.
 */
export async function requireDevice(ctx: CoreContext, serial?: string): Promise<DeviceHandle> {
  const devices = await listDevices(ctx.adb);
  if (devices.length === 0) {
    throw new LdError("NO_DEVICE", "No Android device is connected.", "Connect one over USB, or pair over Wi‑Fi (`connect_device` / Local Desktop: Pair Device).");
  }
  const device = resolveDevice(devices, {
    serial,
    envSerial: ctx.env.ANDROID_SERIAL,
    selectedSerial: readState(ctx.root).selectedSerial,
  });
  if (!device) {
    throw new LdError(
      "MULTIPLE_DEVICES",
      `${devices.length} devices are connected: ${devices.map((d) => `${d.serial} (${d.model ?? d.state})`).join(", ")}.`,
      "Pass a serial, or choose one with `select_device`.",
    );
  }
  assertUsable(device);
  return { adb: ctx.adb.forDevice(device.serial), device };
}
