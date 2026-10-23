import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { appProcesses, forceStop, getPackageDump, getUid, installApk, pidof, sha256File, startApp, waitForPid } from "./adb/app";
import { listDevices } from "./adb/devices";
import { deviceEpoch, getDeviceInfo } from "./adb/props";
import { analyzeAudio, describeAnalysis, parseWav } from "./audio/analyze";
import { recordAudio } from "./audio/record";
import { audioStatus } from "./audio/status";
import { runBuild } from "./build";
import { requireDevice, type CoreContext } from "./context";
import { collectCrashes } from "./crash/collect";
import { symbolize } from "./crash/symbolize";
import { formatChecks, runDoctor } from "./doctor";
import { LdError } from "./errors";
import { downscalePng } from "./image";
import { LOCKED_HINT, wakeAndUnlock } from "./power";
import { drag, longPress, mouse, pressKey, swipe, tap, typeText, type Point } from "./input";
import { queryLogcat, queryLogFile, parseLevel } from "./logcat/query";
import { captureScreen, pngSize, timestampName } from "./screen";
import { shQuote } from "./shell";
import { readState, updateState } from "./state";
import { buildArtifacts, findApk, localDir } from "./workspace";

export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  image?: { data: Buffer; mimeType: string };
  audio?: { data: Buffer; mimeType: string };
}

export interface ToolRuntime {
  core: CoreContext;
  signal?: AbortSignal;
  progress?: (message: string, fraction?: number) => void;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations?: ToolAnnotations;
  run(args: z.infer<z.ZodObject<S>>, rt: ToolRuntime): Promise<ToolResult>;
}

function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const serial = z.string().optional().describe("adb serial. Default: ANDROID_SERIAL, the device selected in the editor, or the only connected device.");
const space = z
  .enum(["screenshot", "device"])
  .default("screenshot")
  .describe('Coordinate space: "screenshot" = pixels of the last `screenshot` image from this device (default), "device" = physical pixels.');

async function app(rt: ToolRuntime, serialArg?: string) {
  const handle = await requireDevice(rt.core, serialArg);
  return { ...handle, pkg: rt.core.app.packageName };
}

async function requireUid(adb: Awaited<ReturnType<typeof app>>["adb"], pkg: string): Promise<number> {
  const uid = await getUid(adb, pkg);
  if (uid === undefined) throw new LdError("NOT_INSTALLED", `${pkg} isn't installed on ${adb.serial}.`, "Use `build_apk` + `install_apk`, or press F5 in the editor.");
  return uid;
}

/** Maps a point given in screenshot space to device pixels using the last screenshot of that device. */
function toDevice(root: string, deviceSerial: string, p: Point, coordSpace: "screenshot" | "device"): { point: Point; note?: string } {
  if (coordSpace === "device") return { point: p };
  const last = readState(root).lastScreenshot;
  if (!last || last.serial !== deviceSerial) {
    return { point: p, note: "No screenshot of this device yet, so coordinates were used as device pixels. Take a `screenshot` first." };
  }
  return { point: { x: (p.x * last.deviceWidth) / last.width, y: (p.y * last.deviceHeight) / last.height } };
}

function sinceToEpoch(since: string | undefined, root: string, deviceNow: number): number | undefined {
  if (!since) return undefined;
  if (since === "launch") return readState(root).lastLaunch?.deviceEpoch;
  if (/^\d+(\.\d+)?$/.test(since)) return deviceNow - parseFloat(since);
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new LdError("INVALID_ARGUMENT", `Can't parse since="${since}". Use seconds ("120"), "launch", or an ISO time.`);
  return Math.floor(t / 1000);
}

export const TOOLS: ToolDef<any>[] = [
  tool({
    name: "devices",
    title: "List devices",
    description: "List connected Android devices (USB, Wi‑Fi, emulators) with model, Android version, ABI and which one is selected.",
    input: {},
    annotations: { readOnlyHint: true },
    async run(_args, rt) {
      const devices = await listDevices(rt.core.adb);
      const selected = readState(rt.core.root).selectedSerial;
      const rows = await Promise.all(
        devices.map(async (d) => {
          const info = d.state === "device" ? await getDeviceInfo(rt.core.adb.forDevice(d.serial)).catch(() => undefined) : undefined;
          return {
            serial: d.serial,
            state: d.state,
            transport: d.transport,
            model: info?.model || d.model,
            android: info?.release,
            sdk: info?.sdk,
            abi: info?.abi,
            selected: d.serial === selected,
          };
        }),
      );
      const text = rows.length
        ? rows.map((r) => `${r.selected ? "* " : "  "}${r.serial}  ${r.state}  ${r.transport}  ${r.model ?? ""}${r.android ? `  Android ${r.android} (API ${r.sdk})` : ""}${r.abi ? `  ${r.abi}` : ""}`).join("\n")
        : "No devices connected.";
      return { text, structured: { devices: rows } };
    },
  }),

  tool({
    name: "select_device",
    title: "Select device",
    description: "Make a device the default for all tools (shared with the editor's device picker).",
    input: { serial: z.string() },
    annotations: { idempotentHint: true },
    async run({ serial: s }, rt) {
      const devices = await listDevices(rt.core.adb);
      if (!devices.some((d) => d.serial === s)) throw new LdError("DEVICE_NOT_FOUND", `${s} is not connected.`);
      updateState(rt.core.root, (st) => {
        st.selectedSerial = s;
      });
      return { text: `Selected ${s}.` };
    },
  }),

  tool({
    name: "connect_device",
    title: "Connect over Wi‑Fi",
    description: "Connect to a device with wireless debugging already paired (`adb connect ip:port`). Pairing needs the human (QR or code in the editor).",
    input: { address: z.string().describe("ip:port shown under Wireless debugging") },
    annotations: { openWorldHint: true },
    async run({ address }, rt) {
      const out = await rt.core.adb.run(["connect", address], { allowFailure: true, timeoutMs: 20_000 });
      if (!/connected to/i.test(out)) throw new LdError("COMMAND_FAILED", out.trim() || `Couldn't connect to ${address}`, "Pair first: in the editor run 'Local Desktop: Pair Device over Wi‑Fi'.");
      return { text: out.trim() };
    },
  }),

  tool({
    name: "doctor",
    title: "Check environment",
    description: "Check the build/debug toolchain (adb, Android SDK, xbuild, Gradle, Java, Rust target, lldb-server, symbolizer, scrcpy).",
    input: {},
    annotations: { readOnlyHint: true },
    async run(_args, rt) {
      const checks = await runDoctor(rt.core.root, rt.core.paths);
      return { text: formatChecks(checks), structured: { checks } };
    },
  }),

  tool({
    name: "app_status",
    title: "App status",
    description: "Whether Local Desktop is installed and running: version, debuggable, uid, processes (app, proot, pipewire, sink) with memory.",
    input: { serial },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb, pkg, device } = await app(rt, args.serial);
      const dump = await getPackageDump(adb, pkg);
      if (!dump) return { text: `${pkg} is not installed on ${device.serial}.`, structured: { installed: false, package: pkg } };
      const uid = dump.userId ?? (await getUid(adb, pkg));
      const procs = uid !== undefined ? await appProcesses(adb, uid) : [];
      const focus = await adb.shell("dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity'", { allowFailure: true });
      const foreground = focus.includes(pkg);
      // Only upstream was renamed; forks (e.g. app.elementarymobile) sit next to app.polarbear on purpose.
      const old = pkg === "io.github.localdesktop" ? await getPackageDump(adb, "app.polarbear") : undefined;
      const lines = [
        `${pkg} ${dump.versionName ?? "?"} (code ${dump.versionCode ?? "?"}) on ${device.serial}${dump.debuggable ? ", debuggable" : ", release build"}`,
        `uid ${uid ?? "?"}, ${procs.length ? `${procs.length} process(es)` : "not running"}${foreground ? ", in foreground" : ""}`,
        ...procs.map((p) => `  pid ${p.pid}  ${Math.round((p.rssKb ?? 0) / 1024)} MB  ${p.name}`),
        ...(old ? ["Note: the pre-rename package app.polarbear is also installed (a separate app with its own data)."] : []),
      ];
      return { text: lines.join("\n"), structured: { installed: true, package: pkg, ...dump, uid, processes: procs, foreground } };
    },
  }),

  tool({
    name: "app_start",
    title: "Start app",
    description: "Start Local Desktop (or bring it to front). Records the launch time so `logcat since=launch` works.",
    input: { serial, restart: z.boolean().default(false).describe("Force-stop first") },
    async run(args, rt) {
      const { adb, pkg, device } = await app(rt, args.serial);
      const epoch = await deviceEpoch(adb);
      const screen = await startApp(adb, pkg, { restart: args.restart });
      const pid = await waitForPid(adb, pkg, 15_000, rt.signal).catch(() => undefined);
      updateState(rt.core.root, (s) => {
        s.lastLaunch = { serial: device.serial, pid, deviceEpoch: epoch, at: new Date().toISOString() };
      });
      return { text: `Started ${pkg}${pid ? ` (pid ${pid})` : ""}.${screen.locked ? ` ${LOCKED_HINT}` : ""}`, structured: { pid, locked: screen.locked } };
    },
  }),

  tool({
    name: "app_stop",
    title: "Stop app",
    description: "Force-stop Local Desktop (kills the Linux session too).",
    input: { serial },
    annotations: { destructiveHint: true, idempotentHint: true },
    async run(args, rt) {
      const { adb, pkg } = await app(rt, args.serial);
      await forceStop(adb, pkg);
      return { text: `Stopped ${pkg}.` };
    },
  }),

  tool({
    name: "build_apk",
    title: "Build APK",
    description: "Build the APK with the patched xbuild (arm64). Takes minutes. Returns rustc errors and the APK path.",
    input: { profile: z.enum(["debug", "release"]).default("debug") },
    async run(args, rt) {
      let lines = 0;
      const result = await runBuild(rt.core.root, args.profile, {
        paths: rt.core.paths,
        signal: rt.signal,
        onLine: (line) => {
          lines++;
          if (lines % 25 === 0 || /Compiling localdesktop|Running gradle|BUILD SUCCESSFUL/i.test(line)) rt.progress?.(line.slice(0, 200));
        },
      });
      const diag = result.diagnostics.filter((d) => d.severity === "error");
      const text = result.ok
        ? `Built ${result.apk ?? "(APK not found)"} in ${Math.round(result.durationMs / 1000)} s.`
        : [`Build failed (exit ${result.exitCode}).`, ...diag.slice(0, 20).map((d) => `${d.file ?? "?"}:${d.line ?? "?"}: ${d.message}`), "--- last output ---", result.tail].join("\n");
      return { text, structured: { ok: result.ok, apk: result.apk, errors: diag, durationMs: result.durationMs } };
    },
  }),

  tool({
    name: "install_apk",
    title: "Install APK",
    description: "Install an APK (default: the newest local debug build). Never uninstalls: that would wipe the Arch Linux rootfs.",
    input: { serial, apk: z.string().optional().describe("Path to the APK"), profile: z.enum(["debug", "release"]).default("debug") },
    async run(args, rt) {
      const { adb, device } = await app(rt, args.serial);
      const apk = args.apk ? path.resolve(rt.core.root, args.apk) : findApk(rt.core.root, args.profile);
      if (!apk) throw new LdError("APK_NOT_FOUND", `No ${args.profile} APK has been built.`, "Run `build_apk` first.");
      await installApk(adb, apk, { signal: rt.signal });
      const hash = sha256File(apk);
      updateState(rt.core.root, (s) => {
        s.installHash = { ...s.installHash, [device.serial]: hash };
      });
      return { text: `Installed ${path.relative(rt.core.root, apk)} on ${device.serial}.` };
    },
  }),

  tool({
    name: "logcat",
    title: "Read logs",
    description:
      "Recent log lines from Local Desktop only (filtered by the app's uid, so it includes proot/pipewire children). Tags: RustStdoutStderr = stdout/stderr/panics, localdesktop::* = Rust log crate, LocalDesktopA11y = keyboard service.",
    input: {
      serial,
      lines: z.number().int().min(1).max(5000).default(200),
      since: z.string().optional().describe('Seconds ago ("120"), "launch" (since the last app_start / F5), or an ISO timestamp'),
      level: z.string().optional().describe("Minimum level: V, D, I, W, E, F"),
      tags: z.array(z.string()).optional(),
      grep: z.string().optional().describe("Case-insensitive regex on tag + message"),
      crash: z.boolean().default(false).describe("Include the crash buffer"),
      source: z.enum(["device", "file"]).default("device").describe('"file" reads the editor\'s persisted .localdesktop/logs/logcat.log (works when the device is gone)'),
      maxBytes: z.number().int().default(32 * 1024),
    },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const filter = { lines: args.lines, minLevel: parseLevel(args.level), tags: args.tags, grep: args.grep, maxBytes: args.maxBytes };
      if (args.source === "file") {
        const file = path.join(rt.core.root, ".localdesktop", "logs", "logcat.log");
        const r = queryLogFile(file, filter);
        return { text: r.text || "(no matching lines in the log file)", structured: { lineCount: r.lineCount, truncated: r.truncated, file } };
      }
      const { adb, pkg } = await app(rt, args.serial);
      const uid = await requireUid(adb, pkg);
      const sinceEpoch = sinceToEpoch(args.since, rt.core.root, await deviceEpoch(adb));
      const r = await queryLogcat(adb, { ...filter, uid, sinceEpoch, buffers: args.crash ? ["main", "system", "crash"] : undefined });
      const note = r.deviceFilter === "none" ? "\n(note: this device's logcat lacks --uid; lines from other apps may appear)" : "";
      return { text: (r.text || "(no matching lines)") + (r.truncated ? "\n(truncated: narrow with since/level/grep)" : "") + note, structured: { lineCount: r.lineCount, truncated: r.truncated } };
    },
  }),

  tool({
    name: "crash_report",
    title: "Crash report",
    description: "Recent native crashes (tombstones), Java crashes, ANRs and Rust panics of Local Desktop, with native frames symbolicated against the local unstripped libraries.",
    input: { serial, max: z.number().int().min(1).max(10).default(3), symbolicate: z.boolean().default(true) },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb, pkg } = await app(rt, args.serial);
      const uid = await getUid(adb, pkg);
      const reports = await collectCrashes(adb, pkg, uid, args.max);
      if (!reports.length) return { text: "No crashes, ANRs or panics recorded for the app.", structured: { reports: [] } };
      const dirs = [...buildArtifacts(rt.core.root, "debug").symbolDirs, ...buildArtifacts(rt.core.root, "release").symbolDirs];
      const parts: string[] = [];
      for (const r of reports) {
        let text = r.text;
        let note = "";
        if (args.symbolicate && r.kind === "native") {
          const s = await symbolize(text, dirs, rt.core.paths);
          text = s.text;
          note = s.tool ? ` (${s.symbolized} frame(s) symbolicated)` : " (no llvm-symbolizer found; unsymbolicated)";
        }
        parts.push(`=== ${r.kind} ${r.time ?? ""} from ${r.source}${note} ===\n${text.length > 12000 ? text.slice(0, 12000) + "\n…" : text}`);
      }
      return { text: parts.join("\n\n"), structured: { reports: reports.map((r) => ({ kind: r.kind, time: r.time, source: r.source })) } };
    },
  }),

  tool({
    name: "screenshot",
    title: "Screenshot",
    description:
      "See what's on the device screen. Returns a downscaled image; tap/swipe/mouse coordinates default to this image's pixel space. The full-resolution PNG is saved under .localdesktop/screenshots/.",
    input: { serial, maxSize: z.number().int().min(200).max(4096).default(1280).describe("Longest side of the returned image"), format: z.enum(["jpeg", "png"]).default("jpeg") },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb, device } = await app(rt, args.serial);
      const screen = await wakeAndUnlock(adb);
      const png = await captureScreen(adb);
      const { width: deviceWidth, height: deviceHeight } = pngSize(png);
      const dir = localDir(rt.core.root, "screenshots");
      const file = path.join(dir, timestampName("screenshot", "png"));
      fs.writeFileSync(file, png);
      const scaled = downscalePng(png, args.maxSize, args.format);
      updateState(rt.core.root, (s) => {
        s.lastScreenshot = { serial: device.serial, width: scaled.width, height: scaled.height, deviceWidth, deviceHeight, at: new Date().toISOString() };
      });
      return {
        text: `Screenshot ${scaled.width}×${scaled.height} (device ${deviceWidth}×${deviceHeight}); full PNG: ${path.relative(rt.core.root, file)}${screen.locked ? `\n${LOCKED_HINT} The image shows the lock screen.` : ""}`,
        structured: { locked: screen.locked, file, width: scaled.width, height: scaled.height, deviceWidth, deviceHeight, scale: scaled.scale },
        image: { data: scaled.data, mimeType: scaled.mimeType },
      };
    },
  }),

  tool({
    name: "tap",
    title: "Tap",
    description: "Tap the touchscreen at (x, y). Coordinates are in the last screenshot's space unless space=device.",
    input: { serial, x: z.number(), y: z.number(), space, longPressMs: z.number().int().optional().describe("Hold for this long (long-press / right-click in Local Desktop)") },
    async run(args, rt) {
      const { adb, device } = await app(rt, args.serial);
      const { point, note } = toDevice(rt.core.root, device.serial, args, args.space);
      if (args.longPressMs) await longPress(adb, point, args.longPressMs);
      else await tap(adb, point);
      return { text: `${args.longPressMs ? "Long-pressed" : "Tapped"} at device (${Math.round(point.x)}, ${Math.round(point.y)}).${note ? ` ${note}` : ""}` };
    },
  }),

  tool({
    name: "swipe",
    title: "Swipe / drag",
    description: "Swipe or drag from (x1, y1) to (x2, y2). Use drag=true to press-and-hold first (moving windows, selecting text).",
    input: { serial, x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), durationMs: z.number().int().min(10).max(10_000).default(300), drag: z.boolean().default(false), space },
    async run(args, rt) {
      const { adb, device } = await app(rt, args.serial);
      const a = toDevice(rt.core.root, device.serial, { x: args.x1, y: args.y1 }, args.space);
      const b = toDevice(rt.core.root, device.serial, { x: args.x2, y: args.y2 }, args.space);
      if (args.drag) await drag(adb, a.point, b.point, args.durationMs);
      else await swipe(adb, a.point, b.point, args.durationMs);
      return { text: `${args.drag ? "Dragged" : "Swiped"} (${Math.round(a.point.x)}, ${Math.round(a.point.y)}) → (${Math.round(b.point.x)}, ${Math.round(b.point.y)}).${a.note ? ` ${a.note}` : ""}` };
    },
  }),

  tool({
    name: "mouse",
    title: "Mouse",
    description: "Desktop-style mouse input at (x, y): click, move (hover) or scroll (positive scrollV = up).",
    input: { serial, action: z.enum(["click", "move", "scroll"]), x: z.number(), y: z.number(), scrollV: z.number().optional(), scrollH: z.number().optional(), space },
    async run(args, rt) {
      const { adb, device } = await app(rt, args.serial);
      const { point, note } = toDevice(rt.core.root, device.serial, args, args.space);
      await mouse(adb, args.action, point, { scrollV: args.scrollV, scrollH: args.scrollH });
      return { text: `Mouse ${args.action} at device (${Math.round(point.x)}, ${Math.round(point.y)}).${note ? ` ${note}` : ""}` };
    },
  }),

  tool({
    name: "type_text",
    title: "Type text",
    description: "Type ASCII text into the focused field (via `input text`). Press keys like enter separately with press_key.",
    input: { serial, text: z.string().min(1).max(5000) },
    async run(args, rt) {
      const { adb } = await app(rt, args.serial);
      await typeText(adb, args.text);
      return { text: `Typed ${args.text.length} character(s).` };
    },
  }),

  tool({
    name: "press_key",
    title: "Press key",
    description: 'Press a key or chord: "enter", "back", "home", "tab", "escape", "backspace", "up", "f5", "ctrl+c", "alt+tab", "ctrl+shift+t", or a KEYCODE_* name. Chords need Android 13+.',
    input: { serial, key: z.string(), longPress: z.boolean().default(false) },
    async run(args, rt) {
      const { adb } = await app(rt, args.serial);
      const info = args.key.includes("+") ? await getDeviceInfo(adb).catch(() => undefined) : undefined;
      await pressKey(adb, args.key, { longPress: args.longPress, sdk: info?.sdk });
      return { text: `Pressed ${args.key}.` };
    },
  }),

  tool({
    name: "audio_status",
    title: "Audio status",
    description: "What the app's audio pipeline is doing (PipeWire → AAudio sink): running processes, active players, MMAP use, AudioFlinger/AAudio excerpts.",
    input: { serial },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb, pkg } = await app(rt, args.serial);
      const uid = await requireUid(adb, pkg);
      const info = await getDeviceInfo(adb).catch(() => undefined);
      const st = await audioStatus(adb, uid, info?.sdk);
      const text = [st.summary, ...(st.players.length ? ["Players:", ...st.players.map((p) => `  ${p.type} pid ${p.pid} ${p.state} ${p.usage ?? ""}`)] : []), ...(st.audioFlinger.length ? ["AudioFlinger:", ...st.audioFlinger.map((l) => `  ${l}`)] : []), ...(st.aaudioService.length ? ["AAudio service:", ...st.aaudioService.map((l) => `  ${l}`)] : [])].join("\n");
      return { text, structured: { ...st } };
    },
  }),

  tool({
    name: "audio_record",
    title: "Record & analyse audio",
    description:
      "Record what the device is playing (scrcpy, Android 11+) and analyse it: levels over time, silence, dropouts (underruns), clipping and dominant frequency. Use it to check the app produces sound. Optionally returns the audio itself.",
    input: { serial, seconds: z.number().int().min(1).max(30).default(5), returnAudio: z.boolean().default(false).describe("Also return the WAV (≤ 10 s) as MCP audio content") },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb, device } = await app(rt, args.serial);
      const info = await getDeviceInfo(adb);
      rt.progress?.(`Recording ${args.seconds} s of audio…`);
      const file = await recordAudio(device.serial, localDir(rt.core.root, "audio"), args.seconds, info.sdk, rt.core.paths, rt.signal);
      const wav = fs.readFileSync(file);
      const analysis = analyzeAudio(parseWav(wav));
      const { windows: _w, ...summary } = analysis;
      return {
        text: `${describeAnalysis(analysis)}\nfile: ${path.relative(rt.core.root, file)}`,
        structured: { file, ...summary },
        audio: args.returnAudio && args.seconds <= 10 ? { data: wav, mimeType: "audio/wav" } : undefined,
      };
    },
  }),

  tool({
    name: "screen_record",
    title: "Record screen",
    description: "Record the screen to an MP4 (≤ 30 s) under .localdesktop/recordings/ and return its path.",
    input: { serial, seconds: z.number().int().min(1).max(30).default(5) },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb } = await app(rt, args.serial);
      const remote = `/data/local/tmp/ld-record-${Date.now()}.mp4`;
      await adb.shell(`screenrecord --time-limit ${args.seconds} ${remote}`, { timeoutMs: (args.seconds + 20) * 1000 });
      const file = path.join(localDir(rt.core.root, "recordings"), timestampName("screen", "mp4"));
      await adb.run(["pull", remote, file], { timeoutMs: 120_000 });
      await adb.shell(`rm -f ${remote}`, { allowFailure: true });
      return { text: `Saved ${path.relative(rt.core.root, file)}.`, structured: { file } };
    },
  }),

  tool({
    name: "shell",
    title: "Device shell",
    description: "Run a command on the device with `adb shell`. With runAs=true it runs as the app (debuggable builds only), e.g. to inspect files/arch (the Arch rootfs).",
    input: { serial, command: z.string(), runAs: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(600_000).default(30_000) },
    annotations: { destructiveHint: true, openWorldHint: true },
    async run(args, rt) {
      const { adb, pkg } = await app(rt, args.serial);
      const line = args.runAs ? `run-as ${shQuote(pkg)} sh -c ${shQuote(args.command)}` : args.command;
      const res = await adb.shellResult(line, { timeoutMs: args.timeoutMs });
      const out = res.stdout.toString("utf8");
      const text = `${out.length > 64_000 ? out.slice(0, 64_000) + "\n…(truncated)" : out}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}\n[exit ${res.code}]`;
      return { text, structured: { exitCode: res.code } };
    },
  }),

  tool({
    name: "pull_file",
    title: "Pull file",
    description: "Copy a file from the device to .localdesktop/pull/. With runAs=true, reads from the app's private data (e.g. files/arch/var/log/…).",
    input: { serial, devicePath: z.string(), runAs: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb, pkg } = await app(rt, args.serial);
      const file = path.join(localDir(rt.core.root, "pull"), path.basename(args.devicePath) || "file");
      if (args.runAs) {
        const data = await adb.execOut(`run-as ${shQuote(pkg)} cat ${shQuote(args.devicePath)}`, { timeoutMs: 120_000 });
        fs.writeFileSync(file, data);
      } else {
        await adb.run(["pull", args.devicePath, file], { timeoutMs: 300_000 });
      }
      return { text: `Saved ${path.relative(rt.core.root, file)} (${fs.statSync(file).size} bytes).`, structured: { file } };
    },
  }),

  tool({
    name: "app_pid",
    title: "App pid",
    description: "The main process id of Local Desktop, if running.",
    input: { serial },
    annotations: { readOnlyHint: true },
    async run(args, rt) {
      const { adb, pkg } = await app(rt, args.serial);
      const pid = await pidof(adb, pkg);
      return { text: pid ? String(pid) : "not running", structured: { pid } };
    },
  }),
];

export function findTool(name: string): ToolDef<any> | undefined {
  return TOOLS.find((t) => t.name === name);
}
