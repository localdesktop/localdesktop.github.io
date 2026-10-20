/** Exact-match uid lookup in `pm list packages -U` (prefix collisions like foo/foo.bar must not match). */
export function parseUidFromPmList(output: string, pkg: string): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const m = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim());
    if (m && m[1] === pkg) return parseInt(m[2]!, 10);
  }
  return undefined;
}

export interface PackageDump {
  versionName?: string;
  versionCode?: number;
  userId?: number;
  debuggable: boolean;
  firstInstallTime?: string;
  lastUpdateTime?: string;
}

/** Extracts the useful bits of `dumpsys package <pkg>`. */
export function parseDumpsysPackage(output: string): PackageDump | undefined {
  if (!/Packages:\s*\n\s*Package \[/.test(output) && !/^\s*Package \[/m.test(output)) return undefined;
  const get = (re: RegExp) => re.exec(output)?.[1];
  const versionCode = get(/versionCode=(\d+)/);
  const userId = get(/userId=(\d+)/) ?? get(/appId=(\d+)/);
  const flags = get(/pkgFlags=\[([^\]]*)\]/) ?? get(/\bflags=\[([^\]]*)\]/) ?? "";
  return {
    versionName: get(/versionName=(\S+)/),
    versionCode: versionCode ? parseInt(versionCode, 10) : undefined,
    userId: userId ? parseInt(userId, 10) : undefined,
    debuggable: /\bDEBUGGABLE\b/.test(flags),
    firstInstallTime: get(/firstInstallTime=([^\n]+)/)?.trim(),
    lastUpdateTime: get(/lastUpdateTime=([^\n]+)/)?.trim(),
  };
}

/** Maps `adb install` output to a stable failure code (or undefined on success). */
export function parseInstallFailure(output: string): { code: string; message: string } | undefined {
  const m = /Failure \[([A-Z_]+)(?::?\s*([^\]]*))?\]/.exec(output) ?? /(INSTALL_[A-Z_]+|DELETE_FAILED_[A-Z_]+)(?::\s*(.*))?/.exec(output);
  if (!m) return /\bSuccess\b/.test(output) ? undefined : output.trim() ? { code: "UNKNOWN", message: output.trim() } : undefined;
  return { code: m[1]!, message: (m[2] ?? "").trim() };
}
