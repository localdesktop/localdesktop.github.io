import { rustSourceMap, type RustToolchain } from "./rust";

export interface LldbAttachInput {
  name: string;
  pid: number;
  serial: string;
  /** Abstract socket path of the platform server, e.g. "/io.github.localdesktop-1a2b/platform.sock". */
  socketPath: string;
  /** Directories with unstripped libraries, best first (build output, then extra paths). */
  symbolDirs: string[];
  rust?: RustToolchain;
  stopOnEntry?: boolean;
  initCommands?: string[];
  preRunCommands?: string[];
  postRunCommands?: string[];
  exitCommands?: string[];
  sourceMap?: Record<string, string>;
  /** Merged last: escape hatch for any CodeLLDB setting. */
  lldb?: Record<string, unknown>;
  /** Bookkeeping copied into the config so the parent session can recognise its child. */
  meta?: Record<string, unknown>;
}

/** Quotes an argument for the LLDB command interpreter. */
export function lldbQuote(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The connect URL for LLDB's remote-android platform. The serial goes in brackets: Wi‑Fi serials
 * like 192.168.1.5:37853 would otherwise be split into host and port.
 */
export function platformConnectUrl(serial: string, socketPath: string): string {
  return `unix-abstract-connect://[${serial}]${socketPath.startsWith("/") ? "" : "/"}${socketPath}`;
}

/** Generates the CodeLLDB attach configuration for a process in the app sandbox. */
export function buildLldbAttachConfig(input: LldbAttachInput): Record<string, unknown> {
  const initCommands = [
    "platform select remote-android",
    `platform connect ${platformConnectUrl(input.serial, input.socketPath)}`,
    "settings set plugin.jit-loader.gdb.enable off",
  ];
  const dirs = [...new Set(input.symbolDirs.filter(Boolean))];
  if (dirs.length) initCommands.push(`settings append target.exec-search-paths ${dirs.map(lldbQuote).join(" ")}`);
  initCommands.push(
    // ART uses SIGSEGV/SIGBUS internally (null checks, stack overflow); break only on real faults.
    "process handle SIGBUS SIGSEGV --pass true --stop false --notify false",
    "breakpoint set --shlib libart.so --name art_sigsegv_fault",
    "breakpoint set --shlib libart.so --name art_sigbus_fault",
    ...(input.initCommands ?? []),
  );

  const config: Record<string, unknown> = {
    type: "lldb",
    request: "attach",
    name: input.name,
    pid: input.pid,
    initCommands,
    sourceLanguages: ["rust"],
    sourceMap: { ...(input.rust ? rustSourceMap(input.rust) : {}), ...(input.sourceMap ?? {}) },
    stopOnEntry: Boolean(input.stopOnEntry),
  };
  if (input.preRunCommands?.length) config.preRunCommands = input.preRunCommands;
  if (input.postRunCommands?.length) config.postRunCommands = input.postRunCommands;
  if (input.exitCommands?.length) config.exitCommands = input.exitCommands;
  if (input.meta) config.__localdesktop = input.meta;
  return { ...config, ...(input.lldb ?? {}) };
}
