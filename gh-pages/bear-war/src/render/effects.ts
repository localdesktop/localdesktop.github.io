// Visual effects driven by simulation events: muzzle flashes, tracers, beams,
// explosions, splats, sparks and scorch decals. Purely cosmetic.

import type { Game } from '../game/game.ts';
import type { GameEvent } from '../game/types.ts';
import { DEFS } from '../game/data/index.ts';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  r: number;
  g: number;
  b: number;
  a: number;
  /** 0 = soft dot (additive), 1 = smoke (normal), 2 = ring, 3 = spark streak, 4 = debris chunk, 5 = goo droplet */
  kind: number;
  drag: number;
  air: boolean;
}

interface Beam {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  glow: string;
  width: number;
  life: number;
  max: number;
  air: boolean;
}

interface Decal {
  x: number;
  y: number;
  r: number;
  life: number;
  max: number;
  kind: number; // 0 scorch, 1 goo, 2 blood
  rot: number;
}

const MAX_PARTICLES = 1800;

const glowCache = new Map<number, HTMLCanvasElement>();
/** Soft radial glow sprite, cached per (quantised) colour. */
export function glowSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  let c = glowCache.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, `rgba(${r},${g},${b},1)`);
    gr.addColorStop(0.35, `rgba(${r},${g},${b},0.55)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 64, 64);
    glowCache.set(key, c);
  }
  return c;
}

type C3 = [number, number, number];
const FX_COLORS: Record<string, C3> = {
  rifle: [255, 220, 120],
  sap: [255, 170, 80],
  flame: [255, 140, 40],
  cannon: [255, 200, 120],
  boulder: [255, 180, 90],
  autocannon: [255, 220, 140],
  missile: [255, 190, 100],
  guns: [255, 70, 60],
  broadside: [120, 180, 255],
  prism: [110, 240, 255],
  torch: [140, 220, 255],
  claw: [200, 255, 160],
  starspark: [140, 230, 255],
  blade: [130, 210, 255],
  scythe: [170, 120, 255],
  maul: [220, 255, 170],
  quill: [190, 230, 90],
  glaive: [200, 120, 255],
  sting: [150, 255, 90],
  burst: [140, 255, 70],
  thorn: [210, 190, 150],
  moonorb: [120, 170, 255],
  eyebeam: [255, 120, 50],
  lantern: [120, 230, 255],
  starbolt: [255, 215, 120],
  grandshot: [140, 200, 255],
  keg: [255, 170, 80],
  honey: [255, 190, 60],
  eruption: [210, 180, 120],
  frost: [170, 230, 255],
  sunlance: [255, 240, 150],
  tongue: [255, 130, 170],
  lockon: [255, 90, 70],
  snowball: [190, 235, 255],
};

export class Effects {
  parts: Particle[] = [];
  beams: Beam[] = [];
  decals: Decal[] = [];
  /** id -> seconds of white hit-flash remaining */
  flash = new Map<number, number>();
  shieldHits: { x: number; y: number; r: number; life: number; ang: number }[] = [];
  lowFx = false;

  add(p: Partial<Particle> & { x: number; y: number }): void {
    if (this.parts.length >= MAX_PARTICLES) {
      if (this.lowFx) return;
      this.parts.shift();
    }
    this.parts.push({
      vx: 0, vy: 0, life: 0.4, max: 0.4, size: 3, grow: 0, r: 255, g: 255, b: 255, a: 1, kind: 0, drag: 0.9, air: false,
      ...p,
    } as Particle);
  }

  burst(x: number, y: number, n: number, c: C3, speed: number, size: number, life: number, kind = 0, air = false): void {
    if (this.lowFx) n = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      const l = life * (0.6 + Math.random() * 0.6);
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: l, max: l, size: size * (0.6 + Math.random() * 0.8), r: c[0], g: c[1], b: c[2], kind, air });
    }
  }

  explosion(x: number, y: number, scale: number, air = false, scorch = true): void {
    this.add({ x, y, life: 0.35, max: 0.35, size: 6 * scale, grow: 70 * scale, r: 255, g: 230, b: 170, kind: 2, air });
    this.burst(x, y, Math.round(10 * scale), [255, 190, 90], 90 * scale, 5 * scale, 0.45, 0, air);
    this.burst(x, y, Math.round(6 * scale), [255, 120, 40], 60 * scale, 7 * scale, 0.6, 0, air);
    for (let i = 0; i < Math.round(5 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const l = 0.9 + Math.random() * 0.8;
      this.add({ x: x + Math.cos(a) * 4 * scale, y: y + Math.sin(a) * 4 * scale, vx: Math.cos(a) * 15, vy: Math.sin(a) * 15 - 8, life: l, max: l, size: 6 * scale, grow: 10 * scale, r: 60, g: 55, b: 50, a: 0.55, kind: 1, drag: 0.95, air });
    }
    this.burst(x, y, Math.round(4 * scale), [80, 70, 60], 140 * scale, 2.2, 0.5, 4, air);
    if (scorch && !air) this.decals.push({ x, y, r: 10 * scale + 6, life: 25, max: 25, kind: 0, rot: Math.random() * 6 });
  }

  splat(x: number, y: number, scale: number, c: C3, decal: number): void {
    this.burst(x, y, Math.round(10 * scale), c, 70 * scale, 3.5 * scale, 0.5, 5);
    this.add({ x, y, life: 0.3, max: 0.3, size: 4 * scale, grow: 40 * scale, r: c[0], g: c[1], b: c[2], a: 0.6, kind: 2 });
    this.decals.push({ x, y, r: 7 * scale + 4, life: 18, max: 18, kind: decal, rot: Math.random() * 6 });
  }

  /** Feed simulation events. */
  onEvents(events: GameEvent[], g: Game): void {
    for (const ev of events) this.onEvent(ev, g);
  }

  private onEvent(ev: GameEvent, g: Game): void {
    switch (ev.k) {
      case 'fire': {
        const c = FX_COLORS[ev.fx] ?? [255, 255, 255];
        const dx = ev.tx - ev.x;
        const dy = ev.ty - ev.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const src = g.get(ev.id);
        const r = src ? src.r : 8;
        const mx = ev.x + (dx / d) * r * 0.9;
        const my = ev.y + (dy / d) * r * 0.9;
        const air = !!src?.air;
        switch (ev.fx) {
          case 'rifle':
          case 'autocannon':
            this.beams.push({ x0: mx, y0: my, x1: ev.tx + (Math.random() - 0.5) * 6, y1: ev.ty + (Math.random() - 0.5) * 6, color: 'rgba(255,240,180,0.95)', glow: 'rgba(255,200,90,0.35)', width: ev.fx === 'autocannon' ? 1.8 : 1.1, life: 0.06, max: 0.06, air: air || ev.air });
            this.add({ x: mx, y: my, life: 0.06, max: 0.06, size: ev.fx === 'autocannon' ? 6 : 4, r: c[0], g: c[1], b: c[2], air });
            break;
          case 'cannon':
          case 'boulder':
            this.add({ x: mx, y: my, life: 0.12, max: 0.12, size: ev.fx === 'boulder' ? 14 : 9, r: 255, g: 220, b: 150, air });
            this.burst(mx, my, 5, [120, 110, 100], 40, 4, 0.5, 1, air);
            this.beams.push({ x0: mx, y0: my, x1: ev.tx, y1: ev.ty, color: 'rgba(255,230,170,0.8)', glow: 'rgba(255,170,80,0.3)', width: ev.fx === 'boulder' ? 2.5 : 1.6, life: 0.07, max: 0.07, air });
            break;
          case 'flame': {
            for (let i = 0; i < (this.lowFx ? 6 : 14); i++) {
              const t = Math.random();
              const l = 0.25 + Math.random() * 0.25;
              this.add({ x: mx + dx * t * 0.9, y: my + dy * t * 0.9, vx: (Math.random() - 0.5) * 30 + (dx / d) * 40, vy: (Math.random() - 0.5) * 30 + (dy / d) * 40, life: l, max: l, size: 4 + t * 7, grow: 8, r: 255, g: 120 + Math.random() * 80, b: 30, air });
            }
            break;
          }
          case 'guns':
          case 'broadside':
          case 'prism': {
            const col = ev.fx === 'guns' ? ['rgba(255,120,110,1)', 'rgba(255,40,30,0.4)'] : ev.fx === 'broadside' ? ['rgba(200,225,255,1)', 'rgba(80,140,255,0.45)'] : ['rgba(200,255,255,1)', 'rgba(60,220,255,0.45)'];
            this.beams.push({ x0: mx, y0: my, x1: ev.tx, y1: ev.ty, color: col[0], glow: col[1], width: 1.6, life: 0.1, max: 0.1, air: air || ev.air });
            break;
          }
          case 'sunlance':
            this.beams.push({ x0: mx, y0: my, x1: ev.tx, y1: ev.ty, color: 'rgba(255,250,210,1)', glow: 'rgba(255,200,80,0.5)', width: 2.2, life: 0.12, max: 0.12, air: ev.air });
            break;
          case 'tongue':
            this.beams.push({ x0: mx, y0: my, x1: ev.tx, y1: ev.ty, color: 'rgba(255,150,185,1)', glow: 'rgba(200,60,110,0.4)', width: 3, life: 0.35, max: 0.35, air: true });
            break;
          case 'lockon':
            this.beams.push({ x0: mx, y0: my, x1: ev.tx, y1: ev.ty, color: 'rgba(255,140,110,0.9)', glow: 'rgba(255,60,40,0.3)', width: 1, life: 0.3, max: 0.3, air: ev.air });
            this.add({ x: ev.tx, y: ev.ty, life: 0.2, max: 0.2, size: 6, r: c[0], g: c[1], b: c[2], air: ev.air });
            break;
          case 'eruption':
            for (let i = 1; i <= 8; i++) {
              const t = i / 8;
              this.add({ x: ev.x + dx * t, y: ev.y + dy * t, vy: -12, life: 0.35 + t * 0.15, max: 0.5, size: 3, r: c[0], g: c[1], b: c[2], kind: 4 });
            }
            break;
          case 'eyebeam':
            this.beams.push({ x0: mx, y0: my, x1: ev.tx, y1: ev.ty, color: 'rgba(255,230,180,1)', glow: 'rgba(255,100,30,0.5)', width: 3, life: 0.18, max: 0.18, air });
            break;
          case 'grandshot':
            this.beams.push({ x0: ev.x, y0: ev.y, x1: ev.tx, y1: ev.ty, color: 'rgba(230,245,255,1)', glow: 'rgba(90,160,255,0.6)', width: 6, life: 0.5, max: 0.5, air: true });
            break;
          case 'torch':
          case 'starspark':
            this.burst(ev.tx, ev.ty, 4, c, 50, 2, 0.2, 3);
            break;
          default:
            break;
        }
        break;
      }
      case 'hit': {
        const c = FX_COLORS[ev.fx] ?? [255, 255, 255];
        const t = g.get(ev.tid);
        const air = !!t?.air;
        if (t) this.flash.set(t.id, 0.08);
        if (ev.shield && t) {
          this.shieldHits.push({ x: t.x, y: t.y, r: t.isBuilding ? Math.max(t.tw, t.th) * 18 : t.r + 4, life: 0.25, ang: Math.random() * 6 });
        }
        switch (ev.fx) {
          case 'claw':
          case 'maul':
          case 'blade':
          case 'scythe':
            this.burst(ev.x, ev.y, ev.fx === 'maul' ? 8 : 4, c, 60, 2.5, 0.22, 3, air);
            break;
          case 'keg':
            this.explosion(ev.x, ev.y, 0.9, air, true);
            break;
          case 'honey':
          case 'eruption':
            this.burst(ev.x, ev.y, 6, c, 50, 2.5, 0.35, ev.fx === 'honey' ? 5 : 4, air);
            break;
          case 'frost':
            this.add({ x: ev.x, y: ev.y, life: 0.2, max: 0.2, size: 8, r: c[0], g: c[1], b: c[2], air });
            this.burst(ev.x, ev.y, 5, c, 50, 2, 0.3, 3, air);
            break;
          case 'sap':
          case 'missile':
            this.explosion(ev.x, ev.y, 0.6, air, false);
            break;
          case 'boulder':
            this.explosion(ev.x, ev.y, 1.0, air, true);
            break;
          case 'quill':
          case 'sting':
          case 'glaive':
            this.burst(ev.x, ev.y, 6, c, 50, 2.5, 0.3, 0, air);
            break;
          case 'moonorb':
          case 'lantern':
            this.add({ x: ev.x, y: ev.y, life: 0.2, max: 0.2, size: 10, r: c[0], g: c[1], b: c[2], air });
            this.burst(ev.x, ev.y, 5, c, 60, 2, 0.25, 0, air);
            break;
          case 'starbolt':
            this.add({ x: ev.x, y: ev.y, life: 0.3, max: 0.3, size: 20, r: 255, g: 220, b: 140, air });
            this.add({ x: ev.x, y: ev.y, life: 0.3, max: 0.3, size: 6, grow: 60, r: 255, g: 220, b: 140, kind: 2, air });
            break;
          case 'thorn':
            this.burst(ev.x, ev.y, 8, [150, 130, 100], 50, 3, 0.4, 4);
            break;
          case 'grandshot':
            this.explosion(ev.x, ev.y, 1.6, air, false);
            break;
          case 'rifle':
          case 'autocannon':
            this.burst(ev.x, ev.y, 2, c, 40, 1.5, 0.15, 3, air);
            break;
          default:
            this.add({ x: ev.x, y: ev.y, life: 0.12, max: 0.12, size: 5, r: c[0], g: c[1], b: c[2], air });
        }
        break;
      }
      case 'splash': {
        const c = FX_COLORS[ev.fx] ?? [255, 255, 255];
        if (ev.fx === 'burst') {
          this.splat(ev.x, ev.y, 2.2, [240, 190, 60], 1);
          this.add({ x: ev.x, y: ev.y, life: 0.45, max: 0.45, size: 10, grow: ev.r * 2.5, r: 255, g: 220, b: 110, a: 0.8, kind: 2 });
        } else if (ev.fx === 'honey') {
          this.splat(ev.x, ev.y, 1.6, [240, 170, 40], 1);
        } else if (ev.fx === 'snowball') {
          this.add({ x: ev.x, y: ev.y, life: 0.5, max: 0.5, size: 10, grow: ev.r * 3, r: 200, g: 240, b: 255, a: 0.9, kind: 2 });
          this.burst(ev.x, ev.y, 24, [210, 240, 255], 110, 3.5, 0.7);
        } else if (ev.fx === 'eyebeam') {
          this.burst(ev.x, ev.y, 10, c, 50, 4, 0.45, 0);
        } else if (ev.fx === 'flame') {
          this.burst(ev.x, ev.y, 6, c, 40, 5, 0.35, 0);
        }
        break;
      }
      case 'death': {
        const def = DEFS[ev.def];
        const race = def?.race;
        const scale = Math.max(0.6, ev.r / 12);
        if (ev.building) {
          const n = Math.max(2, Math.round(ev.r / 14));
          for (let i = 0; i < n; i++) {
            const ox = (Math.random() - 0.5) * ev.r * 1.6;
            const oy = (Math.random() - 0.5) * ev.r * 1.6;
            this.explosion(ev.x + ox, ev.y + oy, 1.2 + Math.random(), false, true);
          }
          if (race === 'horde') this.splat(ev.x, ev.y, 3, [200, 140, 50], 1);
        } else if (def?.kind === 'mineral' || def?.kind === 'geyser') {
          this.burst(ev.x, ev.y, 10, [120, 200, 255], 50, 3, 0.6, 4);
        } else if (race === 'horde') {
          this.splat(ev.x, ev.y, scale, [230, 170, 50], 1);
          this.burst(ev.x, ev.y, 5, [200, 140, 50], 50 * scale, 3, 0.5, 5, ev.air);
        } else if (race === 'starborn') {
          this.add({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, size: 14 * scale, r: 150, g: 220, b: 255, air: ev.air });
          this.add({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, size: 4, grow: 60 * scale, r: 140, g: 210, b: 255, kind: 2, air: ev.air });
          this.burst(ev.x, ev.y, 12, [150, 220, 255], 70 * scale, 2.5, 0.7, 0, ev.air);
          if (def?.attrs.includes('mech')) this.explosion(ev.x, ev.y, scale * 0.8, ev.air, !ev.air);
        } else if (def?.attrs.includes('mech')) {
          this.explosion(ev.x, ev.y, scale, ev.air, !ev.air);
        } else {
          this.splat(ev.x, ev.y, scale * 0.8, [150, 30, 30], 2);
        }
        break;
      }
      case 'blink':
        this.burst(ev.x0, ev.y0, 12, [140, 200, 255], 60, 3, 0.4);
        this.burst(ev.x1, ev.y1, 12, [140, 200, 255], 60, 3, 0.4);
        this.beams.push({ x0: ev.x0, y0: ev.y0, x1: ev.x1, y1: ev.y1, color: 'rgba(170,220,255,0.6)', glow: 'rgba(100,160,255,0.3)', width: 3, life: 0.2, max: 0.2, air: false });
        break;
      case 'heal':
        this.beams.push({ x0: ev.x, y0: ev.y, x1: ev.tx, y1: ev.ty, color: 'rgba(160,255,170,0.8)', glow: 'rgba(80,255,120,0.35)', width: 1.4, life: 0.2, max: 0.2, air: false });
        this.burst(ev.tx, ev.ty, 2, [120, 255, 140], 20, 2, 0.4);
        break;
      case 'spark':
        this.burst(ev.x, ev.y, 3, [255, 220, 120], 70, 1.5, 0.25, 3);
        break;
      case 'built': {
        const e = g.get(ev.id);
        if (e) this.add({ x: e.x, y: e.y, life: 0.6, max: 0.6, size: 10, grow: e.r * 3, r: 200, g: 255, b: 220, a: 0.6, kind: 2 });
        break;
      }
      case 'placed': {
        const def = DEFS[ev.def];
        if (def?.race === 'starborn') {
          this.add({ x: ev.x, y: ev.y, life: 0.6, max: 0.6, size: 30, r: 140, g: 210, b: 255 });
          this.burst(ev.x, ev.y, 16, [140, 210, 255], 80, 3, 0.6);
        } else if (def?.race === 'horde') {
          this.splat(ev.x, ev.y, 1.5, [200, 140, 50], 1);
        } else {
          this.burst(ev.x, ev.y, 8, [180, 170, 150], 40, 3, 0.6, 1);
        }
        break;
      }
      case 'trained': {
        const def = DEFS[ev.def];
        if (def?.race === 'starborn') this.add({ x: ev.x, y: ev.y, life: 0.45, max: 0.45, size: 18, r: 150, g: 220, b: 255 });
        else if (def?.race === 'horde') this.burst(ev.x, ev.y, 8, [240, 190, 80], 50, 2.5, 0.4, 5);
        break;
      }
      case 'ability': {
        if (ev.ab === 'honeyrush') this.burst(ev.x, ev.y, 6, [255, 80, 60], 30, 2, 0.4);
        else if (ev.ab === 'royaljelly') this.burst(ev.x, ev.y, 14, [255, 210, 90], 60, 4, 0.7, 4);
        else if (ev.ab === 'haste') this.burst(ev.tx, ev.ty, 14, [255, 220, 120], 60, 3, 0.7);
        else if (ev.ab === 'bubble') this.add({ x: ev.tx, y: ev.ty, life: 0.5, max: 0.5, size: 6, grow: 50, r: 120, g: 200, b: 255, kind: 2 });
        break;
      }
    }
  }

  update(dt: number): void {
    const parts = this.parts;
    let w = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d;
      p.vy *= d;
      p.size += p.grow * dt;
      parts[w++] = p;
    }
    parts.length = w;
    let bw = 0;
    for (const b of this.beams) {
      b.life -= dt;
      if (b.life > 0) this.beams[bw++] = b;
    }
    this.beams.length = bw;
    let dw = 0;
    for (const d of this.decals) {
      d.life -= dt;
      if (d.life > 0) this.decals[dw++] = d;
    }
    this.decals.length = dw;
    if (this.decals.length > 200) this.decals.splice(0, this.decals.length - 200);
    for (const [id, t] of this.flash) {
      if (t - dt <= 0) this.flash.delete(id);
      else this.flash.set(id, t - dt);
    }
    let sw = 0;
    for (const s of this.shieldHits) {
      s.life -= dt;
      if (s.life > 0) this.shieldHits[sw++] = s;
    }
    this.shieldHits.length = sw;
  }

  drawDecals(ctx: CanvasRenderingContext2D): void {
    for (const d of this.decals) {
      const a = Math.min(1, d.life / (d.max * 0.3)) * (d.kind === 0 ? 0.55 : 0.5);
      if (d.kind === 0) {
        const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
        g.addColorStop(0, `rgba(15,10,6,${a})`);
        g.addColorStop(0.6, `rgba(25,18,10,${a * 0.6})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
      } else if (d.kind === 1) {
        ctx.fillStyle = `rgba(150,100,30,${a})`;
      } else {
        ctx.fillStyle = `rgba(90,15,15,${a})`;
      }
      ctx.beginPath();
      if (d.kind === 0) ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      else {
        for (let i = 0; i < 5; i++) {
          const a2 = d.rot + i * 1.3;
          const rr = d.r * (0.35 + ((i * 37) % 10) / 20);
          ctx.moveTo(d.x + Math.cos(a2) * d.r * 0.5 + rr, d.y + Math.sin(a2) * d.r * 0.5);
          ctx.arc(d.x + Math.cos(a2) * d.r * 0.5, d.y + Math.sin(a2) * d.r * 0.5, rr, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
  }

  /** Draw particles & beams for one layer (ground or air). */
  draw(ctx: CanvasRenderingContext2D, air: boolean): void {
    // beams
    ctx.lineCap = 'round';
    for (const b of this.beams) {
      if (b.air !== air) continue;
      const a = b.life / b.max;
      ctx.globalAlpha = a;
      ctx.strokeStyle = b.glow;
      ctx.lineWidth = b.width * 3.5;
      ctx.beginPath();
      ctx.moveTo(b.x0, b.y0);
      ctx.lineTo(b.x1, b.y1);
      ctx.stroke();
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // smoke & chunks (normal blending)
    for (const p of this.parts) {
      if (p.air !== air || (p.kind !== 1 && p.kind !== 4 && p.kind !== 5)) continue;
      const t = p.life / p.max;
      if (p.kind === 1) {
        ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.a * t})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 5) {
        ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${Math.min(1, t * 2)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${Math.min(1, t * 2)})`;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    // glowing particles (additive)
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.parts) {
      if (p.air !== air || p.kind === 1 || p.kind === 4 || p.kind === 5) continue;
      const t = p.life / p.max;
      if (p.kind === 2) {
        ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${p.a * t * 0.8})`;
        ctx.lineWidth = 2 + 3 * t;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 3) {
        ctx.strokeStyle = `rgba(${p.r},${p.g},${p.b},${t})`;
        ctx.lineWidth = p.size * 0.6;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        ctx.stroke();
      } else {
        const s = p.size * (0.5 + t * 0.5);
        ctx.globalAlpha = p.a * t;
        ctx.drawImage(glowSprite(p.r, p.g, p.b), p.x - s, p.y - s, s * 2, s * 2);
        ctx.globalAlpha = 1;
      }
    }
    // shield hits
    if (!air) {
      for (const s of this.shieldHits) {
        const t = s.life / 0.25;
        ctx.strokeStyle = `rgba(120,200,255,${t * 0.7})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, s.ang, s.ang + 2.2);
        ctx.stroke();
        ctx.fillStyle = `rgba(80,160,255,${t * 0.12})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
