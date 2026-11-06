// Procedural audio: every sound effect is synthesized with the Web Audio API at runtime
// and the music is generated on the fly, no audio files are shipped.

import type { GameEvent } from '../game/types.ts';
import type { Game } from '../game/game.ts';
import type { Camera } from '../render/camera.ts';
import type { Settings } from '../app/settings.ts';
import { DEFS } from '../game/data/index.ts';

type Voice = { t: number };

export class AudioEngine {
  settings: Settings;
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private comp!: DynamicsCompressorNode;
  private noise!: AudioBuffer;
  private recent = new Map<string, number[]>();
  private voices: Voice[] = [];
  private lastSay = new Map<string, number>();
  private lastAnySay = 0;
  private music: { stop: () => void } | null = null;
  private wantMusic = false;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /** Browsers only allow audio after a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.sfx = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfx.connect(this.comp);
    this.musicBus.connect(this.master);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applySettings();
    if (this.wantMusic) this.startMusic();
  }

  applySettings(): void {
    if (!this.ctx) return;
    const s = this.settings;
    this.master.gain.value = s.master;
    this.sfx.gain.value = s.sfx;
    this.musicBus.gain.value = s.music * 0.5;
  }

  // ------------------------------------------------------------------ primitives

  private now(): number {
    return this.ctx!.currentTime;
  }

  private out(pan: number, vol: number): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(this.sfx);
    } else g.connect(this.sfx);
    return g;
  }

  private env(g: GainNode, t: number, a: number, d: number, peak = 1): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, dur: number, vol: number, attack = 0.005): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, attack, dur, vol);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  private noiseHit(dest: AudioNode, type: BiquadFilterType, f0: number, f1: number, q: number, t: number, dur: number, vol: number, attack = 0.003): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, attack, dur, vol);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + dur + 0.05);
  }

  /** Rate limiting so 40 marines don't produce 40 simultaneous shots. */
  private allow(key: string, maxPer: number, windowS: number): boolean {
    const t = performance.now() / 1000;
    let list = this.recent.get(key);
    if (!list) {
      list = [];
      this.recent.set(key, list);
    }
    while (list.length && t - list[0] > windowS) list.shift();
    if (list.length >= maxPer) return false;
    list.push(t);
    this.voices = this.voices.filter((v) => t - v.t < 0.25);
    if (this.voices.length > 28) return false;
    this.voices.push({ t });
    return true;
  }

  // ------------------------------------------------------------------ sound bank

  play(name: string, pan = 0, vol = 1): void {
    if (!this.ctx || this.ctx.state !== 'running' || vol < 0.03) return;
    const t = this.now() + 0.005;
    const o = this.out(pan, vol);
    const r = (a: number, b: number) => a + Math.random() * (b - a);
    switch (name) {
      case 'rifle':
        this.noiseHit(o, 'bandpass', r(2200, 2800), 900, 1.2, t, 0.05, 0.35);
        this.tone(o, 'square', r(320, 380), 120, t, 0.03, 0.08);
        break;
      case 'autocannon':
        this.noiseHit(o, 'lowpass', 1800, 400, 0.8, t, 0.09, 0.45);
        this.tone(o, 'sine', 140, 60, t, 0.08, 0.35);
        break;
      case 'cannon':
        this.tone(o, 'sine', 110, 45, t, 0.28, 0.6);
        this.noiseHit(o, 'lowpass', 900, 150, 0.7, t, 0.25, 0.5);
        break;
      case 'boulder':
      case 'keg':
        this.tone(o, 'sine', 80, 30, t, 0.5, 0.8);
        this.noiseHit(o, 'lowpass', 700, 80, 0.7, t, 0.5, 0.7);
        this.noiseHit(o, 'bandpass', 2500, 600, 1, t, 0.12, 0.25);
        break;
      case 'sap':
        this.tone(o, 'triangle', 220, 90, t, 0.12, 0.4);
        this.noiseHit(o, 'lowpass', 1200, 300, 0.7, t, 0.1, 0.3);
        break;
      case 'missile':
        this.noiseHit(o, 'bandpass', 700, 3200, 2, t, 0.25, 0.35, 0.02);
        break;
      case 'flame':
        this.noiseHit(o, 'lowpass', 1400, 500, 0.6, t, 0.35, 0.45, 0.03);
        this.noiseHit(o, 'bandpass', 300, 200, 1.5, t, 0.3, 0.3, 0.02);
        break;
      case 'guns':
        this.tone(o, 'sawtooth', 1700, 500, t, 0.12, 0.16);
        break;
      case 'broadside':
        this.tone(o, 'square', r(1400, 1600), 700, t, 0.07, 0.1);
        break;
      case 'prism':
      case 'sunlance':
      case 'lockon':
        this.tone(o, 'sawtooth', 2200, 900, t, 0.09, 0.12);
        this.tone(o, 'sine', 3300, 1500, t, 0.09, 0.08);
        break;
      case 'moonorb':
      case 'frost':
      case 'lantern':
        this.tone(o, 'sine', 950, 280, t, 0.18, 0.35);
        this.tone(o, 'triangle', 1900, 560, t, 0.12, 0.12);
        break;
      case 'starbolt':
        this.tone(o, 'sine', 700, 120, t, 0.45, 0.5);
        this.noiseHit(o, 'bandpass', 1800, 300, 1.5, t, 0.4, 0.3, 0.02);
        break;
      case 'eyebeam':
        this.tone(o, 'sawtooth', 160, 120, t, 0.3, 0.2, 0.02);
        this.noiseHit(o, 'bandpass', 2600, 1800, 2, t, 0.3, 0.2, 0.02);
        break;
      case 'quill':
      case 'honey':
      case 'eruption':
        this.noiseHit(o, 'bandpass', 3200, 1600, 3, t, 0.06, 0.4);
        this.tone(o, 'triangle', 600, 200, t, 0.05, 0.15);
        break;
      case 'glaive':
        this.noiseHit(o, 'bandpass', 2400, 1200, 4, t, 0.12, 0.35);
        this.tone(o, 'sine', 500, 900, t, 0.1, 0.1);
        break;
      case 'sting':
      case 'tongue':
        this.noiseHit(o, 'lowpass', 900, 400, 4, t, 0.15, 0.4);
        this.tone(o, 'sine', 300, 150, t, 0.12, 0.2);
        break;
      case 'claw':
      case 'maul':
        this.noiseHit(o, 'highpass', 3000, 1500, 0.8, t, name === 'maul' ? 0.12 : 0.05, name === 'maul' ? 0.5 : 0.3);
        if (name === 'maul') this.tone(o, 'sine', 120, 60, t, 0.15, 0.4);
        break;
      case 'blade':
      case 'scythe':
        this.noiseHit(o, 'highpass', 4500, 3000, 1, t, 0.07, 0.25);
        this.tone(o, 'sine', name === 'scythe' ? 1200 : 1900, name === 'scythe' ? 600 : 1500, t, 0.12, 0.15);
        break;
      case 'torch':
      case 'starspark':
        this.tone(o, 'sawtooth', 180, 160, t, 0.08, 0.12);
        this.noiseHit(o, 'highpass', 5000, 5000, 0.5, t, 0.06, 0.1);
        break;
      case 'thorn':
        this.tone(o, 'sine', 170, 55, t, 0.2, 0.55);
        this.noiseHit(o, 'lowpass', 600, 200, 1, t, 0.15, 0.3);
        break;
      case 'burst':
        this.noiseHit(o, 'lowpass', 900, 120, 1.5, t, 0.45, 0.8);
        this.tone(o, 'sine', 140, 40, t, 0.4, 0.6);
        break;
      case 'grandshot':
        this.tone(o, 'sawtooth', 90, 40, t, 0.6, 0.5);
        this.noiseHit(o, 'bandpass', 3000, 200, 1, t, 0.6, 0.7);
        break;
      case 'explode_s':
        this.noiseHit(o, 'lowpass', 1500, 150, 0.7, t, 0.35, 0.6);
        this.tone(o, 'sine', 90, 35, t, 0.3, 0.5);
        break;
      case 'explode_l':
        this.noiseHit(o, 'lowpass', 1100, 60, 0.7, t, 0.9, 0.9, 0.01);
        this.tone(o, 'sine', 70, 25, t, 0.8, 0.8);
        this.noiseHit(o, 'bandpass', 400, 100, 1, t + 0.15, 0.6, 0.5);
        break;
      case 'squish':
        this.noiseHit(o, 'bandpass', 800, 250, 3, t, 0.22, 0.5);
        this.tone(o, 'sine', 260, 90, t, 0.18, 0.3);
        break;
      case 'scream':
        this.tone(o, 'sawtooth', 600, 300, t, 0.25, 0.08);
        break;
      case 'shimmer':
        for (let i = 0; i < 3; i++) this.tone(o, 'sine', 1400 - i * 300, 600 - i * 120, t + i * 0.04, 0.3, 0.15);
        this.noiseHit(o, 'highpass', 6000, 3000, 0.7, t, 0.3, 0.15);
        break;
      case 'summon':
        this.tone(o, 'sine', 300, 1200, t, 0.5, 0.25, 0.05);
        this.tone(o, 'triangle', 600, 2400, t, 0.5, 0.1, 0.05);
        break;
      case 'construct':
        this.noiseHit(o, 'bandpass', 1800, 1800, 6, t, 0.06, 0.2);
        this.tone(o, 'square', 90, 90, t, 0.04, 0.08);
        break;
      case 'grow':
        this.noiseHit(o, 'lowpass', 600, 200, 2, t, 0.5, 0.35, 0.05);
        break;
      case 'honeyrush':
        this.tone(o, 'sine', 400, 900, t, 0.15, 0.2);
        break;
      case 'heal':
        this.tone(o, 'sine', 880, 1320, t, 0.12, 0.08);
        break;
      case 'blink':
        this.tone(o, 'sine', 1200, 300, t, 0.2, 0.3);
        this.noiseHit(o, 'highpass', 4000, 1000, 0.7, t, 0.15, 0.2);
        break;
      case 'storm':
        this.noiseHit(o, 'bandpass', 2000, 800, 2, t, 1.2, 0.4, 0.1);
        this.tone(o, 'sawtooth', 70, 55, t, 1.2, 0.15, 0.1);
        break;
      case 'sniff':
        this.tone(o, 'sine', 600, 1800, t, 0.6, 0.2, 0.05);
        break;
    }
  }

  // ------------------------------------------------------------------ UI

  ui(name: string): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.allow('ui:' + name, 2, 0.12)) return;
    const t = this.now() + 0.005;
    const o = this.out(0, 1);
    switch (name) {
      case 'click':
        this.tone(o, 'sine', 1800, 1200, t, 0.03, 0.08);
        break;
      case 'error':
        this.tone(o, 'square', 220, 200, t, 0.08, 0.12);
        this.tone(o, 'square', 180, 160, t + 0.1, 0.1, 0.12);
        break;
      case 'complete':
        this.tone(o, 'sine', 660, 660, t, 0.15, 0.2);
        this.tone(o, 'sine', 990, 990, t + 0.12, 0.25, 0.2);
        break;
      case 'research':
        [523, 659, 784].forEach((f, i) => this.tone(o, 'triangle', f, f, t + i * 0.1, 0.25, 0.18));
        break;
      case 'alert':
        for (let i = 0; i < 3; i++) this.tone(o, 'square', 880, 620, t + i * 0.18, 0.12, 0.12);
        break;
    }
  }

  /** Unit acknowledgement chirps, flavoured per race. */
  ack(kind: string, race?: string): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.allow('ack', 1, 0.18)) return;
    const t = this.now() + 0.005;
    const o = this.out(0, 0.6);
    const hi = kind === 'attack' ? 1.25 : kind === 'select' ? 1.1 : 1;
    if (race === 'horde') {
      this.tone(o, 'sawtooth', 140 * hi, 90 * hi, t, 0.12, 0.12);
      this.noiseHit(o, 'bandpass', 700 * hi, 400, 4, t, 0.12, 0.15);
    } else if (race === 'starborn') {
      this.tone(o, 'sine', 660 * hi, 880 * hi, t, 0.12, 0.12);
      this.tone(o, 'sine', 990 * hi, 1320 * hi, t + 0.03, 0.12, 0.06);
    } else {
      this.tone(o, 'square', 1250 * hi, 1250 * hi, t, 0.03, 0.06);
      this.tone(o, 'square', 1650 * hi, 1650 * hi, t + 0.06, 0.03, 0.06);
      this.noiseHit(o, 'bandpass', 2500, 2500, 2, t, 0.1, 0.05);
    }
  }

  /** Spoken announcements via the browser's speech synthesis (if enabled). */
  say(text: string): void {
    if (!this.settings.voice || typeof speechSynthesis === 'undefined') return;
    const now = performance.now();
    if (now - this.lastAnySay < 2500 || now - (this.lastSay.get(text) ?? -1e9) < 8000) return;
    this.lastAnySay = now;
    this.lastSay.set(text, now);
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = 0.85;
      u.volume = Math.min(1, this.settings.master * 0.9);
      speechSynthesis.speak(u);
    } catch {
      // speech unavailable
    }
  }

  // ------------------------------------------------------------------ game events

  onEvents(events: GameEvent[], g: Game, player: number, cam: Camera): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const cx = cam.centerX;
    const cy = cam.centerY;
    const halfW = cam.viewW / 2;
    const halfH = cam.viewH / 2;
    const spatial = (x: number, y: number): [number, number] => {
      const dx = (x - cx) / halfW;
      const dy = (y - cy) / halfH;
      const out = Math.max(Math.abs(dx), Math.abs(dy));
      const vol = out <= 1 ? 1 : Math.max(0, 1 - (out - 1) * 1.2);
      return [Math.max(-0.9, Math.min(0.9, dx * 0.7)), vol];
    };
    const team = player >= 0 ? g.players[player].team : -1;
    const seen = (x: number, y: number) => team < 0 || g.vision.visibleAt(team, x, y);
    for (const ev of events) {
      switch (ev.k) {
        case 'fire': {
          if (!seen(ev.x, ev.y)) break;
          const [pan, vol] = spatial(ev.x, ev.y);
          if (vol <= 0) break;
          const heavy = ev.fx === 'boulder' || ev.fx === 'grandshot' || ev.fx === 'starbolt';
          if (!this.allow('fx:' + ev.fx, heavy ? 3 : 4, 0.09)) break;
          this.play(ev.fx, pan, vol * (heavy ? 0.9 : 0.55));
          break;
        }
        case 'splash':
          if (ev.fx === 'burst' && seen(ev.x, ev.y)) {
            const [pan, vol] = spatial(ev.x, ev.y);
            if (this.allow('burst', 3, 0.1)) this.play('burst', pan, vol);
          }
          break;
        case 'death': {
          if (!seen(ev.x, ev.y)) break;
          const [pan, vol] = spatial(ev.x, ev.y);
          if (vol <= 0) break;
          const def = DEFS[ev.def];
          if (!def || def.kind === 'mineral' || def.kind === 'geyser') break;
          let name = 'explode_s';
          if (ev.building) name = 'explode_l';
          else if (def.race === 'horde') name = 'squish';
          else if (def.race === 'starborn') name = def.attrs.includes('mech') ? 'explode_s' : 'shimmer';
          else if (!def.attrs.includes('mech')) name = 'scream';
          if (ev.r > 16 && !ev.building) name = 'explode_l';
          if (this.allow('death:' + name, 3, 0.12)) this.play(name, pan, vol * 0.8);
          break;
        }
        case 'placed': {
          if (ev.owner !== player) break;
          const def = DEFS[ev.def];
          const [pan, vol] = spatial(ev.x, ev.y);
          this.play(def.race === 'starborn' ? 'summon' : def.race === 'horde' ? 'grow' : 'construct', pan, vol * 0.7);
          break;
        }
        case 'spark': {
          if (!seen(ev.x, ev.y)) break;
          const [pan, vol] = spatial(ev.x, ev.y);
          if (this.allow('spark', 2, 0.25)) this.play('construct', pan, vol * 0.4);
          break;
        }
        case 'trained':
          if (ev.owner === player && this.allow('trained', 1, 0.5)) {
            const def = DEFS[ev.def];
            const [pan, vol] = spatial(ev.x, ev.y);
            if (def.race === 'starborn') this.play('summon', pan, vol * 0.4);
            else this.ack('select', def.race);
          }
          break;
        case 'ability': {
          if (!seen(ev.tx, ev.ty) && ev.owner !== player) break;
          const [pan, vol] = spatial(ev.tx, ev.ty);
          const map: Record<string, string> = { honeyrush: 'honeyrush', starfall: 'storm', sniff: 'sniff', moonstep: 'blink', bubble: 'heal', staticburst: 'grandshot', beecloud: 'grow', stingswarm: 'sting', haste: 'summon', royaljelly: 'grow', brace: 'construct', unbrace: 'construct', digin: 'construct', hibernate: 'grow', anchor: 'construct', hopoff: 'construct', releasecubs: 'grow', yank: 'blink', pollen: 'grow', hornetbomb: 'sting', spiritwalk: 'blink', snowball: 'storm', scaldinghoney: 'sting', lockon: 'sniff', sunlanceon: 'summon' };
          const n = map[ev.ab];
          if (n && this.allow('ab:' + n, 2, 0.2)) this.play(n, pan, vol * 0.8);
          break;
        }
        case 'blink': {
          const [pan, vol] = spatial(ev.x1, ev.y1);
          if (this.allow('blink', 2, 0.1)) this.play('blink', pan, vol * 0.6);
          break;
        }
        case 'cargo': {
          if (ev.owner !== player && !seen(ev.x, ev.y)) break;
          const [pan, vol] = spatial(ev.x, ev.y);
          const race = g.byId.get(ev.carrier)?.def.race;
          const n = race === 'starborn' ? 'blink' : race === 'horde' ? 'grow' : 'construct';
          if (this.allow('cargo', 2, 0.12)) this.play(n, pan, vol * 0.45);
          break;
        }
        case 'heal':
          if (ev.id && seen(ev.x, ev.y) && this.allow('heal', 1, 0.4)) {
            const [pan, vol] = spatial(ev.x, ev.y);
            this.play('heal', pan, vol * 0.5);
          }
          break;
      }
    }
  }

  // ------------------------------------------------------------------ music

  startMusic(): void {
    this.wantMusic = true;
    if (!this.ctx || this.music) return;
    this.music = generativeMusic(this.ctx, this.musicBus);
  }

  stopMusic(): void {
    this.wantMusic = false;
    this.music?.stop();
    this.music = null;
  }
}

/** Slow evolving ambient pads with sparse bell notes (A minor / dorian). */
function generativeMusic(ctx: AudioContext, out: GainNode): { stop: () => void } {
  const bus = ctx.createGain();
  bus.gain.value = 0.0001;
  bus.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 4);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  lp.Q.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.05;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 500;
  lfo.connect(lfoGain);
  lfoGain.connect(lp.frequency);
  lfo.start();
  // feedback delay for space
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.6;
  const fb = ctx.createGain();
  fb.gain.value = 0.35;
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(bus);
  lp.connect(bus);
  lp.connect(delay);
  bus.connect(out);

  const chords = [
    [57, 60, 64, 67], // Am7
    [53, 57, 60, 64], // Fmaj7
    [55, 59, 62, 65], // G7-ish
    [52, 55, 59, 62], // Em7
  ];
  const scale = [57, 59, 60, 62, 64, 65, 67, 69, 72, 74, 76];
  const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
  let stopped = false;
  let step = 0;
  const timers: number[] = [];

  const pad = (notes: number[], t: number, dur: number) => {
    for (const n of notes) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(n - 12);
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.025, t + dur * 0.35);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g);
        g.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
    }
  };
  const bell = (n: number, t: number) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = midi(n);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = midi(n) * 2.76;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(delay);
    g.connect(bus);
    o.start(t);
    o2.start(t);
    o.stop(t + 3.1);
    o2.stop(t + 3.1);
  };
  const tick = () => {
    if (stopped) return;
    const t = ctx.currentTime + 0.1;
    const chord = chords[step % chords.length];
    pad(chord, t, 9);
    // bass
    const b = ctx.createOscillator();
    b.type = 'triangle';
    b.frequency.value = midi(chord[0] - 24);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.08, t + 1);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 8);
    b.connect(bg);
    bg.connect(bus);
    b.start(t);
    b.stop(t + 8.2);
    for (let i = 0; i < 3; i++) if (Math.random() < 0.6) bell(scale[Math.floor(Math.random() * scale.length)], t + 1 + i * 2.2 + Math.random());
    step++;
    timers.push(window.setTimeout(tick, 8000));
  };
  tick();
  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(bus.gain.value, ctx.currentTime);
      bus.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.5);
      window.setTimeout(() => {
        lfo.stop();
        bus.disconnect();
      }, 1700);
    },
  };
}
