import { LdError } from "../errors";

export interface PcmAudio {
  sampleRate: number;
  channels: number;
  /** Mono mix in [-1, 1]. */
  samples: Float32Array;
}

/** Parses a RIFF/WAVE file (PCM 8/16/24/32-bit integer or 32/64-bit float, incl. WAVE_FORMAT_EXTENSIBLE). */
export function parseWav(buf: Buffer): PcmAudio {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new LdError("COMMAND_FAILED", "Not a WAV file.");
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    // Streaming writers (scrcpy while recording) may leave sizes at 0/0xFFFFFFFF; clamp to the file.
    if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // extensible: sub-format GUID
      fmt = { format, channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new LdError("COMMAND_FAILED", "WAV file has no fmt/data chunk.");
  const { format, channels, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const samples = new Float32Array(frames);
  const read = (i: number): number => {
    const p = i * bytes;
    if (format === 3) return bits === 64 ? data!.readDoubleLE(p) : data!.readFloatLE(p);
    switch (bits) {
      case 8:
        return (data!.readUInt8(p) - 128) / 128;
      case 16:
        return data!.readInt16LE(p) / 32768;
      case 24:
        return data!.readIntLE(p, 3) / 8388608;
      case 32:
        return data!.readInt32LE(p) / 2147483648;
      default:
        throw new LdError("COMMAND_FAILED", `Unsupported WAV sample size: ${bits} bits`);
    }
  };
  if (format !== 1 && format !== 3) throw new LdError("COMMAND_FAILED", `Unsupported WAV format ${format}`);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(f * channels + c);
    samples[f] = sum / channels;
  }
  return { sampleRate: fmt.sampleRate, channels, samples };
}

export const SILENCE_DBFS = -60;

export function toDbfs(x: number): number {
  return x <= 1e-9 ? -180 : 20 * Math.log10(x);
}

export interface AudioWindow {
  startMs: number;
  peakDbfs: number;
  rmsDbfs: number;
}

export interface AudioAnalysis {
  durationMs: number;
  sampleRate: number;
  channels: number;
  peakDbfs: number;
  rmsDbfs: number;
  /** Share of windows below SILENCE_DBFS (0..1). */
  silenceRatio: number;
  longestSilenceMs: number;
  /** Runs of digital silence (exact zeros) ≥ 2 ms inside otherwise-audible audio: typical underruns. */
  dropouts: { count: number; atMs: number[] };
  clippedSamples: number;
  /** Strongest frequency in the loudest second (Hz), if there is audible audio. */
  dominantHz?: number;
  windows: AudioWindow[];
  verdict: string;
}

/** Levels per window, silence, dropouts, clipping and dominant frequency — so agents can "hear". */
export function analyzeAudio(audio: PcmAudio, windowMs = 100): AudioAnalysis {
  const { samples, sampleRate } = audio;
  const n = samples.length;
  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const windows: AudioWindow[] = [];
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sumSq += samples[i]! * samples[i]!;
  }
  for (let start = 0; start < n; start += win) {
    const end = Math.min(n, start + win);
    let p = 0;
    let s = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i]!);
      if (a > p) p = a;
      s += samples[i]! * samples[i]!;
    }
    windows.push({ startMs: Math.round((start / sampleRate) * 1000), peakDbfs: round1(toDbfs(p)), rmsDbfs: round1(toDbfs(Math.sqrt(s / (end - start)))) });
  }

  const silent = windows.map((w) => w.rmsDbfs < SILENCE_DBFS);
  let longest = 0;
  let run = 0;
  for (const s of silent) {
    run = s ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  const dropouts = findDropouts(samples, sampleRate);
  const dominantHz = peak > 0.001 ? dominantFrequency(samples, sampleRate) : undefined;
  const silenceRatio = windows.length ? silent.filter(Boolean).length / windows.length : 1;
  const durationMs = Math.round((n / sampleRate) * 1000);

  let verdict: string;
  if (n === 0) verdict = "Empty recording.";
  else if (silenceRatio >= 0.99) verdict = "Silent: nothing audible was captured (is the app playing? MMAP streams may be invisible to capture).";
  else if (dropouts.count > 0) verdict = `Audible with ${dropouts.count} dropout(s) — likely underruns.`;
  else if (clipped > sampleRate * 0.001) verdict = "Audible but clipping.";
  else if (silenceRatio > 0.3) verdict = "Audible with gaps.";
  else verdict = "Audible and continuous.";

  return {
    durationMs,
    sampleRate,
    channels: audio.channels,
    peakDbfs: round1(toDbfs(peak)),
    rmsDbfs: round1(toDbfs(Math.sqrt(sumSq / Math.max(1, n)))),
    silenceRatio: Math.round(silenceRatio * 1000) / 1000,
    longestSilenceMs: longest * windowMs,
    dropouts,
    clippedSamples: clipped,
    dominantHz: dominantHz !== undefined ? Math.round(dominantHz) : undefined,
    windows,
    verdict,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function findDropouts(samples: Float32Array, sampleRate: number): { count: number; atMs: number[] } {
  const minRun = Math.round(sampleRate * 0.002);
  const ctx = Math.round(sampleRate * 0.05);
  const atMs: number[] = [];
  let i = 0;
  while (i < samples.length) {
    if (samples[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < samples.length && samples[j] === 0) j++;
    if (j - i >= minRun && i > ctx && j + ctx < samples.length && rms(samples, i - ctx, i) > 0.01 && rms(samples, j, j + ctx) > 0.01) {
      atMs.push(Math.round((i / sampleRate) * 1000));
    }
    i = j;
  }
  return { count: atMs.length, atMs: atMs.slice(0, 50) };
}

function rms(s: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Peak FFT bin (Hann window) over the loudest ~1 s, with parabolic interpolation. */
export function dominantFrequency(samples: Float32Array, sampleRate: number): number | undefined {
  let size = 1;
  while (size * 2 <= Math.min(samples.length, 65536, sampleRate)) size *= 2;
  if (size < 256) return undefined;
  // Pick the loudest block of `size` samples (stride size/2).
  let bestStart = 0;
  let bestEnergy = -1;
  for (let start = 0; start + size <= samples.length; start += size / 2) {
    let e = 0;
    for (let i = start; i < start + size; i += 4) e += samples[i]! * samples[i]!;
    if (e > bestEnergy) {
      bestEnergy = e;
      bestStart = start;
    }
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = samples[bestStart + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  fft(re, im);
  const minBin = Math.ceil((20 * size) / sampleRate);
  let best = -1;
  let bestMag = 0;
  const mag = (k: number) => Math.hypot(re[k]!, im[k]!);
  for (let k = minBin; k < size / 2; k++) {
    const m = mag(k);
    if (m > bestMag) {
      bestMag = m;
      best = k;
    }
  }
  if (best <= 0) return undefined;
  const a = mag(best - 1);
  const b = bestMag;
  const c = best + 1 < size / 2 ? mag(best + 1) : 0;
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return ((best + delta) * sampleRate) / size;
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Compact text summary of an analysis (windows summarised as a level sparkline). */
export function describeAnalysis(a: AudioAnalysis): string {
  const bars = " ▁▂▃▄▅▆▇█";
  const step = Math.max(1, Math.ceil(a.windows.length / 80));
  let spark = "";
  for (let i = 0; i < a.windows.length; i += step) {
    const db = Math.max(...a.windows.slice(i, i + step).map((w) => w.rmsDbfs));
    const level = Math.max(0, Math.min(8, Math.round(((db + 60) / 60) * 8)));
    spark += bars[level];
  }
  return [
    a.verdict,
    `duration ${(a.durationMs / 1000).toFixed(1)} s, ${a.sampleRate} Hz, ${a.channels} ch`,
    `peak ${a.peakDbfs} dBFS, rms ${a.rmsDbfs} dBFS, silence ${(a.silenceRatio * 100).toFixed(0)}% (longest ${a.longestSilenceMs} ms)`,
    `dropouts ${a.dropouts.count}${a.dropouts.count ? ` at ${a.dropouts.atMs.slice(0, 10).join(", ")} ms` : ""}, clipped samples ${a.clippedSamples}`,
    a.dominantHz !== undefined ? `dominant frequency ≈ ${a.dominantHz} Hz` : "no dominant frequency",
    `levels (${step * 100} ms/char): ${spark}`,
  ].join("\n");
}
