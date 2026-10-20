import type { Adb } from "../adb/adb";
import { appProcesses, type ProcessInfo } from "../adb/app";

export interface PlayerInfo {
  piid?: number;
  type: string;
  uid: number;
  pid: number;
  state: string;
  usage?: string;
}

/** Parses AudioPlaybackConfiguration lines from `dumpsys audio`. */
export function parsePlayers(dumpsysAudio: string): PlayerInfo[] {
  const players: PlayerInfo[] = [];
  for (const line of dumpsysAudio.split(/\r?\n/)) {
    const m = /AudioPlaybackConfiguration\s+piid:(\d+)\s+type:(\S+)\s+u\/pid:(\d+)\/(\d+)\s+state:(\S+)/.exec(line);
    if (!m) continue;
    players.push({
      piid: parseInt(m[1]!, 10),
      type: m[2]!,
      uid: parseInt(m[3]!, 10),
      pid: parseInt(m[4]!, 10),
      state: m[5]!,
      usage: /usage=(\w+)/.exec(line)?.[1],
    });
  }
  return players;
}

/** Lines of a dumpsys that mention one of the pids (plus the nearest preceding section header). */
export function excerptForPids(text: string, pids: number[], maxLines = 40): string[] {
  if (!pids.length) return [];
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let header = "";
  let headerEmitted = "";
  const pidRe = new RegExp(`(^|[^\\d])(${pids.join("|")})([^\\d]|$)`);
  for (const line of lines) {
    if (/^\S.*(thread|Thread|Output|Input|Stream|stream)/.test(line) || /^\s{0,2}(Output thread|Input thread|AAudio)/.test(line)) header = line.trim();
    if (pidRe.test(line)) {
      if (header && header !== headerEmitted) {
        out.push(`[${header}]`);
        headerEmitted = header;
      }
      out.push(line.trim());
      if (out.length >= maxLines) break;
    }
  }
  return out;
}

export interface AudioStatus {
  sdk?: number;
  processes: ProcessInfo[];
  pipewireRunning: boolean;
  sinkRunning: boolean;
  players: PlayerInfo[];
  /** The app has an AAudio MMAP stream (playback capture likely can't hear it). */
  mmapLikely: boolean;
  audioFlinger: string[];
  aaudioService: string[];
  summary: string;
}

/** What the app's audio pipeline (PipeWire → AAudio sink) is doing right now. */
export async function audioStatus(adb: Adb, uid: number, sdk?: number): Promise<AudioStatus> {
  const processes = await appProcesses(adb, uid);
  const pids = processes.map((p) => p.pid);
  const [audio, flinger, aaudio] = await Promise.all([
    adb.shell("dumpsys audio", { allowFailure: true, timeoutMs: 20_000 }),
    adb.shell("dumpsys media.audio_flinger", { allowFailure: true, timeoutMs: 20_000 }),
    adb.shell("dumpsys media.aaudio", { allowFailure: true, timeoutMs: 20_000 }),
  ]);
  const players = parsePlayers(audio).filter((p) => p.uid === uid);
  const aaudioService = excerptForPids(aaudio, pids);
  const flingerLines = excerptForPids(flinger, pids);
  const pipewireRunning = processes.some((p) => /pipewire(?!-pulse)/.test(p.name));
  const sinkRunning = processes.some((p) => /aaudio[-_]sink/.test(p.name));
  const mmapLikely = aaudioService.length > 0 || flingerLines.some((l) => /mmap/i.test(l));
  const started = players.filter((p) => p.state === "started");
  const parts: string[] = [];
  if (sdk !== undefined && sdk < 30) parts.push(`Android API ${sdk}: Local Desktop only starts PipeWire audio on API 30+.`);
  parts.push(`PipeWire ${pipewireRunning ? "running" : "not running"}, AAudio sink ${sinkRunning ? "running" : "not running"}.`);
  parts.push(started.length ? `${started.length} active player(s): ${started.map((p) => `${p.type} (${p.usage ?? "?"})`).join(", ")}.` : players.length ? `${players.length} player(s), none started.` : "No players registered for the app.");
  if (mmapLikely) parts.push("An MMAP (low-latency exclusive path) stream is in use; playback capture may record silence.");
  return { sdk, processes, pipewireRunning, sinkRunning, players, mmapLikely, audioFlinger: flingerLines, aaudioService, summary: parts.join(" ") };
}
