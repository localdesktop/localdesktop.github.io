import { describe, expect, it } from "vitest";
import { analyzeAudio, dominantFrequency, parseWav } from "../../src/core/audio/analyze";
import { parseScrcpyVersion, scrcpyAudioArgs } from "../../src/core/audio/record";
import { excerptForPids, parsePlayers } from "../../src/core/audio/status";

function wav16(samples: number[][], sampleRate = 48000): Buffer {
  const channels = samples[0]!.length;
  const data = Buffer.alloc(samples.length * channels * 2);
  samples.forEach((frame, i) => frame.forEach((v, c) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), (i * channels + c) * 2)));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function sine(freq: number, seconds: number, amp = 0.5, rate = 48000): number[][] {
  return Array.from({ length: Math.round(seconds * rate) }, (_, i) => {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / rate);
    return [v, v];
  });
}

describe("audio analysis", () => {
  it("finds a 440 Hz tone at the right level", () => {
    const a = analyzeAudio(parseWav(wav16(sine(440, 2))));
    expect(a.dominantHz).toBeGreaterThan(437);
    expect(a.dominantHz).toBeLessThan(443);
    expect(a.peakDbfs).toBeCloseTo(-6, 0);
    expect(a.silenceRatio).toBe(0);
    expect(a.dropouts.count).toBe(0);
    expect(a.verdict).toMatch(/continuous/);
    expect(a.channels).toBe(2);
    expect(a.durationMs).toBe(2000);
  });

  it("detects digital-silence dropouts inside audio", () => {
    const frames = sine(1000, 1);
    for (let i = 24000; i < 24000 + 480; i++) frames[i] = [0, 0]; // 10 ms gap
    const a = analyzeAudio(parseWav(wav16(frames)));
    expect(a.dropouts.count).toBe(1);
    expect(a.dropouts.atMs[0]).toBe(500);
    expect(a.verdict).toMatch(/dropout/);
  });

  it("reports silence", () => {
    const a = analyzeAudio(parseWav(wav16(Array.from({ length: 48000 }, () => [0, 0]))));
    expect(a.silenceRatio).toBe(1);
    expect(a.dominantHz).toBeUndefined();
    expect(a.verdict).toMatch(/Silent/);
  });

  it("counts clipping", () => {
    expect(analyzeAudio(parseWav(wav16(sine(200, 0.5, 1.5)))).clippedSamples).toBeGreaterThan(1000);
  });

  it("estimates frequency with sub-bin precision", () => {
    const rate = 44100;
    const s = new Float32Array(rate).map((_, i) => Math.sin((2 * Math.PI * 1234.5 * i) / rate));
    expect(Math.abs(dominantFrequency(s, rate)! - 1234.5)).toBeLessThan(2);
  });

  it("rejects non-WAV data", () => {
    expect(() => parseWav(Buffer.from("not a wav file at all"))).toThrow(/WAV/);
  });
});

describe("scrcpy", () => {
  it("parses versions", () => {
    expect(parseScrcpyVersion("scrcpy 3.1 <https://github.com/Genymobile/scrcpy>")).toEqual([3, 1]);
    expect(parseScrcpyVersion("scrcpy v2.0")).toEqual([2, 0]);
  });
  it("uses playback capture with dup on Android 13+", () => {
    expect(scrcpyAudioArgs("S", "/tmp/a.wav", 5, 34, [3, 1])).toEqual(expect.arrayContaining(["--audio-source=playback", "--audio-dup", "--record=/tmp/a.wav", "--time-limit=5"]));
    expect(scrcpyAudioArgs("S", "/tmp/a.wav", 5, 31, [3, 1])).toContain("--audio-source=output");
  });
});

describe("audio status parsing", () => {
  const dump = `  players:
  AudioPlaybackConfiguration piid:79 type:aaudio u/pid:10234/12400 state:started attr:AudioAttributes: usage=USAGE_MEDIA content=CONTENT_TYPE_UNKNOWN
  AudioPlaybackConfiguration piid:12 type:android.media.AudioTrack u/pid:10100/999 state:paused attr:AudioAttributes: usage=USAGE_NOTIFICATION
`;
  it("parses players", () => {
    expect(parsePlayers(dump)).toEqual([
      { piid: 79, type: "aaudio", uid: 10234, pid: 12400, state: "started", usage: "USAGE_MEDIA" },
      { piid: 12, type: "android.media.AudioTrack", uid: 10100, pid: 999, state: "paused", usage: "USAGE_NOTIFICATION" },
    ]);
  });
  it("excerpts lines for pids with section headers", () => {
    const text = "Output thread 0x7a (AudioOut_D):\n  Tracks of thread:\n   T Name Active Client Session\n   F 3 yes 12400 401\n   F 4 yes 999 402\n";
    expect(excerptForPids(text, [12400])).toEqual(["[Output thread 0x7a (AudioOut_D):]", "F 3 yes 12400 401"]);
  });
});
