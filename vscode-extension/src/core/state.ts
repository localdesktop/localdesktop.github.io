import * as fs from "node:fs";
import * as path from "node:path";
import type { Profile } from "./workspace";

/** Shared between the extension, the MCP server and the CLI through `.localdesktop/state.json`. */
export interface SharedState {
  selectedSerial?: string;
  lastLaunch?: { serial: string; pid?: number; deviceEpoch?: number; profile?: Profile; debug?: boolean; at: string };
  /** sha256 of the APK last installed per serial, to skip redundant installs. */
  installHash?: Record<string, string>;
  /** Geometry of the last agent screenshot, so taps in screenshot coordinates map to device pixels. */
  lastScreenshot?: { serial: string; width: number; height: number; deviceWidth: number; deviceHeight: number; at: string };
}

export function statePath(root: string): string {
  return path.join(root, ".localdesktop", "state.json");
}

export function readState(root: string): SharedState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(root), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SharedState) : {};
  } catch {
    return {};
  }
}

/** Read-modify-write with an atomic rename so concurrent readers never see a torn file. */
export function updateState(root: string, mutate: (s: SharedState) => void): SharedState {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = readState(root);
  mutate(state);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return state;
}
