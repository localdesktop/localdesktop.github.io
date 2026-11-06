// Declarative, symmetric map construction. Shapes are described once in "canonical"
// space; the builder evaluates every tile through each symmetry transform so maps are
// perfectly fair (rotational or mirror symmetry).

import { GameMap, F_BUILD, F_CLIFF, F_EDGE, F_RAMP, F_ROCK, F_ROUGH, F_WALK, F_WATER, type ResourceSpawn, type Tileset } from './gamemap.ts';
import { dcos, dsin, datan2 } from '../math.ts';
import { GEYSER_AMOUNT, MINERAL_AMOUNT, MINERAL_SMALL } from '../constants.ts';

export type Sym = 'none' | 'rot2' | 'rot4' | 'mirrorX' | 'mirrorY';
type P = [number, number];
interface Xf {
  f(x: number, y: number): P;
  inv(x: number, y: number): P;
  /** true if axis-aligned rectangles keep their orientation (no 90° turn) */
  keepsAxes: boolean;
}
export type Shape = (x: number, y: number) => boolean;

export interface BaseOpts {
  start?: boolean;
  minerals?: number;
  geysers?: number;
  small?: boolean;
}

interface CanonBase {
  cx: number;
  cy: number;
  angle: number;
  opts: BaseOpts;
}

// ---------------------------------------------------------------- shapes

export function disc(cx: number, cy: number, r: number): Shape {
  const r2 = r * r;
  return (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number): Shape {
  return (x, y) => ((x - cx) * (x - cx)) / (rx * rx) + ((y - cy) * (y - cy)) / (ry * ry) <= 1;
}

export function rect(x0: number, y0: number, x1: number, y1: number): Shape {
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

export function poly(pts: P[]): Shape {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

/** A thick line segment (stadium shape). */
export function capsule(x0: number, y0: number, x1: number, y1: number, width: number): Shape {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const hw2 = (width / 2) * (width / 2);
  return (x, y) => {
    let t = len2 > 0 ? ((x - x0) * dx + (y - y0) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x0 + dx * t - x;
    const py = y0 + dy * t - y;
    return px * px + py * py <= hw2;
  };
}

export function union(...shapes: Shape[]): Shape {
  return (x, y) => shapes.some((s) => s(x, y));
}

export function minus(a: Shape, b: Shape): Shape {
  return (x, y) => a(x, y) && !b(x, y);
}

/** Domain-warp a shape so its edges look organic. amp is in tiles. */
export function warp(s: Shape, amp: number, seed = 1): Shape {
  const s1 = seed * 1.7;
  const s2 = seed * 2.3;
  return (x, y) => {
    const nx = dsin(x * 0.31 + y * 0.17 + s1) * 0.6 + dsin(x * 0.73 - y * 0.41 + s2) * 0.4;
    const ny = dcos(y * 0.29 - x * 0.19 + s2) * 0.6 + dsin(y * 0.67 + x * 0.37 + s1) * 0.4;
    return s(x + nx * amp, y + ny * amp);
  };
}

// ---------------------------------------------------------------- builder

export class MapBuilder {
  id: string;
  name: string;
  desc = '';
  w: number;
  h: number;
  tileset: Tileset;
  seed: number;
  xfs: Xf[];
  elev: Uint8Array;
  rock: Uint8Array;
  water: Uint8Array;
  ramp: Uint8Array;
  rough: Uint8Array;
  bases: CanonBase[] = [];
  warnings: string[] = [];

  constructor(id: string, name: string, w: number, h: number, sym: Sym, tileset: Tileset, seed = 1) {
    this.id = id;
    this.name = name;
    this.w = w;
    this.h = h;
    this.tileset = tileset;
    this.seed = seed;
    const n = w * h;
    this.elev = new Uint8Array(n);
    this.rock = new Uint8Array(n);
    this.water = new Uint8Array(n);
    this.ramp = new Uint8Array(n);
    this.rough = new Uint8Array(n);
    const W = w;
    const H = h;
    const id2: Xf = { f: (x, y) => [x, y], inv: (x, y) => [x, y], keepsAxes: true };
    const r180: Xf = { f: (x, y) => [W - x, H - y], inv: (x, y) => [W - x, H - y], keepsAxes: true };
    switch (sym) {
      case 'none':
        this.xfs = [id2];
        break;
      case 'rot2':
        this.xfs = [id2, r180];
        break;
      case 'rot4': {
        if (W !== H) throw new Error('rot4 symmetry needs a square map');
        const r90: Xf = { f: (x, y) => [W - y, x], inv: (x, y) => [y, W - x], keepsAxes: false };
        const r270: Xf = { f: (x, y) => [y, W - x], inv: (x, y) => [W - y, x], keepsAxes: false };
        // order: P1 canonical, P2 opposite corner, then the other two
        this.xfs = [id2, r180, r90, r270];
        break;
      }
      case 'mirrorX':
        this.xfs = [id2, { f: (x, y) => [W - x, y], inv: (x, y) => [W - x, y], keepsAxes: true }];
        break;
      case 'mirrorY':
        this.xfs = [id2, { f: (x, y) => [x, H - y], inv: (x, y) => [x, H - y], keepsAxes: true }];
        break;
    }
  }

  private paint(shape: Shape, fn: (i: number) => void): void {
    const { w, h } = this;
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const cx = tx + 0.5;
        const cy = ty + 0.5;
        for (const xf of this.xfs) {
          const [ux, uy] = xf.inv(cx, cy);
          if (shape(ux, uy)) {
            fn(ty * w + tx);
            break;
          }
        }
      }
    }
  }

  fillElev(e: number): this {
    this.elev.fill(e);
    return this;
  }
  setElev(shape: Shape, e: number): this {
    this.paint(shape, (i) => (this.elev[i] = e));
    return this;
  }
  addRock(shape: Shape): this {
    this.paint(shape, (i) => (this.rock[i] = 1));
    return this;
  }
  clearRock(shape: Shape): this {
    this.paint(shape, (i) => (this.rock[i] = 0));
    return this;
  }
  addWater(shape: Shape): this {
    this.paint(shape, (i) => (this.water[i] = 1));
    return this;
  }
  addRamp(shape: Shape): this {
    this.paint(shape, (i) => (this.ramp[i] = 1));
    return this;
  }
  addRough(shape: Shape): this {
    this.paint(shape, (i) => (this.rough[i] = 1));
    return this;
  }
  /** cx, cy: town hall center in tiles (use x.5 values). angle: direction the minerals lie in. */
  base(cx: number, cy: number, angle: number, opts: BaseOpts = {}): this {
    this.bases.push({ cx, cy, angle, opts });
    return this;
  }

  build(): GameMap {
    const { w, h } = this;
    const map = new GameMap(this.id, this.name, w, h, this.tileset, this.seed);
    map.desc = this.desc;
    const elev = this.elev;
    const blocked = (i: number) => this.rock[i] || this.water[i];

    // cliffs: a tile is a cliff if a neighbor is lower, unless both are ramp tiles
    const cliff = new Uint8Array(w * h);
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const i = ty * w + tx;
        const e = elev[i];
        let isCliff = false;
        for (let dy = -1; dy <= 1 && !isCliff; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (elev[j] < e && !(this.ramp[i] && this.ramp[j])) {
              isCliff = true;
              break;
            }
          }
        }
        cliff[i] = isCliff ? 1 : 0;
      }
    }

    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const i = ty * w + tx;
        let f = 0;
        const edge = tx === 0 || ty === 0 || tx === w - 1 || ty === h - 1;
        if (edge) f |= F_EDGE;
        if (cliff[i]) f |= F_CLIFF;
        if (this.rock[i]) f |= F_ROCK;
        if (this.water[i]) f |= F_WATER;
        if (this.ramp[i]) f |= F_RAMP;
        if (this.rough[i]) f |= F_ROUGH;
        if (!edge && !cliff[i] && !blocked(i)) {
          f |= F_WALK;
          if (!this.ramp[i] && !this.rough[i]) f |= F_BUILD;
        }
        map.flags[i] = f;
      }
    }
    map.elev.set(elev);

    // bases and resources
    let startCount = 0;
    for (const b of this.bases) if (b.opts.start) startCount++;
    map.maxPlayers = Math.max(1, startCount * this.xfs.length);
    const canonStarts = this.bases.filter((b) => b.opts.start);
    this.xfs.forEach((xf, t) => {
      for (const b of this.bases) {
        const [X, Y] = xf.f(b.cx, b.cy);
        const [X2, Y2] = xf.f(b.cx + dcos(b.angle), b.cy + dsin(b.angle));
        const ang = datan2(Y2 - Y, X2 - X);
        const htx = Math.round(X - 2.5);
        const hty = Math.round(Y - 2.5);
        const start = b.opts.start ? t * canonStarts.length + canonStarts.indexOf(b) : -1;
        map.bases.push({ tx: htx, ty: hty, start });
        let res: ResourceSpawn[];
        if (t === 0 || !xf.keepsAxes) {
          res = layoutResources(htx, hty, ang, b.opts);
        } else {
          // map the canonical layout exactly, so mirrored bases are pixel-identical
          const c = layoutResources(Math.round(b.cx - 2.5), Math.round(b.cy - 2.5), b.angle, b.opts);
          res = c.map((r) => {
            const sw = r.kind === 'mineral' ? 2 : 3;
            const sh = r.kind === 'mineral' ? 1 : 3;
            const [ax, ay] = xf.f(r.tx, r.ty);
            const [bx, by] = xf.f(r.tx + sw, r.ty + sh);
            return { ...r, tx: Math.round(Math.min(ax, bx)), ty: Math.round(Math.min(ay, by)) };
          });
        }
        map.resources.push(...res);
      }
    });

    this.verify(map);
    return map;
  }

  private verify(map: GameMap): void {
    const { w } = map;
    for (const [bi, b] of map.bases.entries()) {
      for (let y = b.ty; y < b.ty + 5; y++) {
        for (let x = b.tx; x < b.tx + 5; x++) {
          if (!map.buildable(x, y)) {
            this.warnings.push(`${map.id}: base ${bi} hall tile ${x},${y} not buildable`);
            y = 1e9;
            break;
          }
        }
      }
    }
    for (const r of map.resources) {
      const sw = r.kind === 'mineral' ? 2 : 3;
      const sh = r.kind === 'mineral' ? 1 : 3;
      for (let y = r.ty; y < r.ty + sh; y++) {
        for (let x = r.tx; x < r.tx + sw; x++) {
          if (!map.walkable(x, y)) this.warnings.push(`${map.id}: ${r.kind} at ${r.tx},${r.ty} on unwalkable tile`);
        }
      }
    }
    // connectivity between all bases
    const seen = new Uint8Array(map.w * map.h);
    const b0 = map.bases[0];
    if (!b0) return;
    const q: number[] = [b0.ty * w + b0.tx];
    seen[q[0]] = 1;
    while (q.length) {
      const i = q.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (!map.walkable(nx, ny)) continue;
        const j = ny * w + nx;
        if (!seen[j]) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    for (const [bi, b] of map.bases.entries()) {
      if (!seen[b.ty * w + b.tx]) this.warnings.push(`${map.id}: base ${bi} at ${b.tx},${b.ty} unreachable from base 0`);
    }
  }
}

// ---------------------------------------------------------------- resources

function overlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** Chebyshev gap in tiles between two rects (0 if touching/overlapping). */
function gapBetween(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): number {
  const gx = Math.max(bx - (ax + aw), ax - (bx + bw), 0);
  const gy = Math.max(by - (ay + ah), ay - (by + bh), 0);
  return Math.max(gx, gy);
}

/**
 * Lay out a mineral line and geysers around a 5x5 town hall at (hx, hy), facing `angle`.
 * Resources must stay 3 tiles away from the hall footprint (so the hall can be rebuilt).
 */
export function layoutResources(hx: number, hy: number, angle: number, opts: BaseOpts = {}): ResourceSpawn[] {
  const nMin = opts.minerals ?? 8;
  const nGas = opts.geysers ?? 2;
  const amount = opts.small ? MINERAL_SMALL : MINERAL_AMOUNT;
  const cx = hx + 2.5;
  const cy = hy + 2.5;
  const dx = dcos(angle);
  const dy = dsin(angle);
  const zx = hx - 3;
  const zy = hy - 3;
  const out: ResourceSpawn[] = [];

  const cands: { tx: number; ty: number; score: number }[] = [];
  for (let ty = hy - 7; ty <= hy + 11; ty++) {
    for (let tx = hx - 8; tx <= hx + 11; tx++) {
      if (overlap(tx, ty, 2, 1, zx, zy, 11, 11)) continue;
      const gap = gapBetween(tx, ty, 2, 1, zx, zy, 11, 11);
      if (gap > 1) continue;
      const mx = tx + 1 - cx;
      const my = ty + 0.5 - cy;
      const len = Math.sqrt(mx * mx + my * my);
      const cos = (mx * dx + my * dy) / len;
      if (cos < 0.25) continue;
      cands.push({ tx, ty, score: (1 - cos) * 10 + gap * 1.6 });
    }
  }
  cands.sort((a, b) => a.score - b.score || a.ty - b.ty || a.tx - b.tx);
  const mins: { tx: number; ty: number }[] = [];
  for (const c of cands) {
    if (mins.length >= nMin) break;
    if (mins.some((m) => overlap(c.tx, c.ty, 2, 1, m.tx, m.ty, 2, 1))) continue;
    mins.push(c);
    out.push({ kind: 'mineral', tx: c.tx, ty: c.ty, amount });
  }

  const sides = nGas >= 2 ? [1, -1] : nGas === 1 ? [1] : [];
  for (const s of sides) {
    const ga = angle + s * 1.35;
    const gdx = dcos(ga);
    const gdy = dsin(ga);
    let best: { tx: number; ty: number; score: number } | null = null;
    for (let ty = hy - 8; ty <= hy + 10; ty++) {
      for (let tx = hx - 8; tx <= hx + 10; tx++) {
        if (overlap(tx, ty, 3, 3, zx, zy, 11, 11)) continue;
        const gap = gapBetween(tx, ty, 3, 3, zx, zy, 11, 11);
        if (gap > 1) continue;
        if (mins.some((m) => gapBetween(tx, ty, 3, 3, m.tx, m.ty, 2, 1) < 1)) continue;
        if (out.some((r) => r.kind === 'geyser' && gapBetween(tx, ty, 3, 3, r.tx, r.ty, 3, 3) < 1)) continue;
        const mx = tx + 1.5 - cx;
        const my = ty + 1.5 - cy;
        const len = Math.sqrt(mx * mx + my * my);
        const cos = (mx * gdx + my * gdy) / len;
        const score = (1 - cos) * 10 + gap * 2;
        if (!best || score < best.score) best = { tx, ty, score };
      }
    }
    if (best) out.push({ kind: 'geyser', tx: best.tx, ty: best.ty, amount: GEYSER_AMOUNT });
  }
  return out;
}
