import { LdError } from "../errors";
import type { Adb } from "./adb";

export type DeviceState =
  | "device"
  | "offline"
  | "unauthorized"
  | "authorizing"
  | "connecting"
  | "no permissions"
  | "bootloader"
  | "recovery"
  | "sideload"
  | "host"
  | "unknown";

export type Transport = "usb" | "wifi" | "emulator";

export interface AdbDevice {
  serial: string;
  state: DeviceState;
  transport: Transport;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  /** Extra text for "no permissions (…)" and similar states. */
  detail?: string;
}

const STATES = ["device", "offline", "unauthorized", "authorizing", "connecting", "bootloader", "recovery", "sideload", "host", "unknown"];

export function transportOf(serial: string): Transport {
  if (/^emulator-\d+$/.test(serial)) return "emulator";
  if (/^\[?[0-9a-fA-F.:]+\]?:\d+$/.test(serial) || serial.includes("._adb-tls-connect._tcp")) return "wifi";
  return "usb";
}

/** Parses `adb devices -l`. Tolerates "no permissions (...); see [...]" states that contain spaces. */
export function parseDevicesList(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const serial = m[1]!;
    let rest = m[2]!;
    let state: DeviceState = "unknown";
    let detail: string | undefined;
    if (rest.startsWith("no permissions")) {
      state = "no permissions";
      // Everything up to the first key:value token belongs to the state description.
      const kv = /\s(usb|product|model|device|transport_id):\S+/.exec(rest);
      detail = (kv ? rest.slice(0, kv.index) : rest).replace(/^no permissions\s*/, "").trim() || undefined;
      rest = kv ? rest.slice(kv.index) : "";
    } else {
      const sm = /^(\S+)\s*(.*)$/.exec(rest)!;
      state = (STATES.includes(sm[1]!) ? sm[1] : "unknown") as DeviceState;
      rest = sm[2]!;
    }
    const props: Record<string, string> = {};
    for (const token of rest.split(/\s+/)) {
      const kv = /^([a-z_]+):(.*)$/.exec(token);
      if (kv) props[kv[1]!] = kv[2]!;
    }
    devices.push({
      serial,
      state,
      transport: transportOf(serial),
      model: props.model?.replace(/_/g, " "),
      product: props.product,
      device: props.device,
      transportId: props.transport_id,
      detail,
    });
  }
  return devices;
}

export async function listDevices(adb: Adb): Promise<AdbDevice[]> {
  return parseDevicesList(await adb.run(["devices", "-l"]));
}

/**
 * Splits the hex-length-prefixed stream of `adb track-devices -l` into device lists.
 * Feed raw chunks; each complete block yields one snapshot of all devices.
 */
export class TrackDevicesParser {
  private buf = "";

  push(chunk: string): AdbDevice[][] {
    this.buf += chunk;
    const snapshots: AdbDevice[][] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = parseInt(this.buf.slice(0, 4), 16);
      if (Number.isNaN(len)) {
        this.buf = "";
        break;
      }
      if (this.buf.length < 4 + len) break;
      const payload = this.buf.slice(4, 4 + len);
      this.buf = this.buf.slice(4 + len);
      snapshots.push(parseDevicesList(payload));
    }
    return snapshots;
  }
}

export function describeState(d: AdbDevice): string {
  switch (d.state) {
    case "device":
      return "ready";
    case "unauthorized":
      return "unauthorized — accept the prompt on the device";
    case "offline":
      return "offline";
    case "no permissions":
      return "no permissions — check udev rules";
    default:
      return d.state;
  }
}

/** Throws a helpful error when a device exists but can't be used. */
export function assertUsable(d: AdbDevice): void {
  switch (d.state) {
    case "device":
      return;
    case "unauthorized":
    case "authorizing":
      throw new LdError("DEVICE_UNAUTHORIZED", `${d.serial} hasn't authorized this computer.`, "Unlock the device and accept the USB debugging prompt (re-pair for Wi‑Fi).");
    case "offline":
      throw new LdError("DEVICE_OFFLINE", `${d.serial} is offline.`, "Reconnect it, or run `adb reconnect offline`.");
    case "no permissions":
      throw new LdError("DEVICE_NO_PERMISSIONS", `No permission to access ${d.serial}.`, "Install Android udev rules and re-plug the device.");
    default:
      throw new LdError("DEVICE_OFFLINE", `${d.serial} is in state "${d.state}".`);
  }
}

export interface ResolveDeviceInput {
  /** Explicit serial ("auto"/undefined = choose). */
  serial?: string;
  envSerial?: string;
  selectedSerial?: string;
}

/**
 * Picks the device to use: explicit serial, then $ANDROID_SERIAL, then the shared selection
 * (if still connected), then the only ready device. Returns undefined when the caller must ask.
 */
export function resolveDevice(devices: AdbDevice[], input: ResolveDeviceInput): AdbDevice | undefined {
  const explicit = input.serial && input.serial !== "auto" && input.serial !== "pick" ? input.serial : undefined;
  for (const wanted of [explicit, input.envSerial]) {
    if (!wanted) continue;
    const d = devices.find((x) => x.serial === wanted);
    if (!d) throw new LdError("DEVICE_NOT_FOUND", `Device ${wanted} is not connected.`, `Connected: ${devices.map((x) => x.serial).join(", ") || "none"}`);
    return d;
  }
  if (input.serial === "pick") return undefined;
  if (input.selectedSerial) {
    const d = devices.find((x) => x.serial === input.selectedSerial && x.state === "device");
    if (d) return d;
  }
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 1) return ready[0];
  if (devices.length === 1) return devices[0];
  return undefined;
}
