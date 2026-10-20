import type { Adb } from "./adb";

/** Parses `getprop` output (`[key]: [value]`). */
export function parseGetprop(output: string): Map<string, string> {
  const props = new Map<string, string>();
  const re = /^\[([^\]]+)\]: \[([\s\S]*?)\]$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) props.set(m[1]!, m[2]!);
  return props;
}

export interface DeviceInfo {
  serial: string;
  model: string;
  manufacturer: string;
  abi: string;
  abiList: string[];
  sdk: number;
  release: string;
  serialNo?: string;
  isEmulator: boolean;
}

export function deviceInfoFromProps(serial: string, props: Map<string, string>): DeviceInfo {
  return {
    serial,
    model: props.get("ro.product.model") ?? "",
    manufacturer: props.get("ro.product.manufacturer") ?? "",
    abi: props.get("ro.product.cpu.abi") ?? "",
    abiList: (props.get("ro.product.cpu.abilist") ?? "").split(",").filter(Boolean),
    sdk: parseInt(props.get("ro.build.version.sdk") ?? "0", 10) || 0,
    release: props.get("ro.build.version.release") ?? "",
    serialNo: props.get("ro.serialno") || undefined,
    isEmulator: props.get("ro.kernel.qemu") === "1" || props.get("ro.boot.qemu") === "1",
  };
}

export async function getDeviceInfo(adb: Adb): Promise<DeviceInfo> {
  const out = await adb.shell("getprop", { timeoutMs: 15_000 });
  return deviceInfoFromProps(adb.serial ?? "", parseGetprop(out));
}

/** Seconds since the epoch on the device clock (logcat -T needs device time, not host time). */
export async function deviceEpoch(adb: Adb): Promise<number> {
  const out = await adb.shell("date +%s", { timeoutMs: 10_000 });
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : Math.floor(Date.now() / 1000);
}
