// Honeycomb. Spreads gradually from Horde structures and recedes when they die. Horde
// structures must be placed on honeycomb; other clans cannot build on it.

import { TILE } from '../constants.ts';
import type { Game } from '../game.ts';
import { F_WALK } from '../map/gamemap.ts';

export const COMB_CHUNK = 8; // tiles per render chunk side

export class Comb {
  w: number;
  h: number;
  grid: Uint8Array;
  target: Uint8Array;
  dirty = true;
  version = 0;
  /** incremented whenever a tile in that chunk changes (for render caches) */
  chunkVer: Uint32Array;
  cw: number;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.grid = new Uint8Array(w * h);
    this.target = new Uint8Array(w * h);
    this.cw = Math.ceil(w / COMB_CHUNK);
    this.chunkVer = new Uint32Array(this.cw * Math.ceil(h / COMB_CHUNK));
  }

  has(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.grid[ty * this.w + tx] !== 0;
  }
  hasAt(x: number, y: number): boolean {
    return this.has(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  recomputeTarget(g: Game): void {
    const { w, h, target } = this;
    target.fill(0);
    for (const e of g.entities) {
      if (!e.alive || !e.isBuilding || !e.def.combRadius || !e.built) continue;
      const r = e.def.combRadius;
      const cx = e.x / TILE;
      const cy = e.y / TILE;
      const R = Math.ceil(r) + 3;
      const x0 = Math.max(0, Math.floor(cx - R));
      const x1 = Math.min(w - 1, Math.ceil(cx + R));
      const y0 = Math.max(0, Math.floor(cy - R));
      const y1 = Math.min(h - 1, Math.ceil(cy + R));
      // footprints are large, so the radius is measured from the footprint edge
      const hw = e.tw / 2;
      const hh = e.th / 2;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const dx = Math.max(Math.abs(tx + 0.5 - cx) - hw, 0);
          const dy = Math.max(Math.abs(ty + 0.5 - cy) - hh, 0);
          if (dx * dx + dy * dy > r * r * 0.55) continue;
          if (!(g.map.flags[ty * w + tx] & F_WALK) && !inside(tx, ty, e.tx, e.ty, e.tw, e.th)) continue;
          target[ty * w + tx] = 1;
        }
      }
    }
    // keep comb under existing hive structures (they don't die instantly off comb)
    this.dirty = false;
  }

  fillToTarget(): void {
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = this.target[i];
    this.chunkVer.fill(1);
    this.version++;
  }

  private touch(tx: number, ty: number): void {
    this.chunkVer[Math.floor(ty / COMB_CHUNK) * this.cw + Math.floor(tx / COMB_CHUNK)]++;
  }

  update(g: Game): void {
    if (this.dirty) this.recomputeTarget(g);
    const { w, h, grid, target } = this;
    const rng = g.rng;
    let changed = false;
    // Two passes so growth is one ring per step. Collect changes first.
    const add: number[] = [];
    const rem: number[] = [];
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const i = ty * w + tx;
        const t = target[i];
        const c = grid[i];
        if (t === c) continue;
        if (t && !c) {
          if (
            (tx > 0 && grid[i - 1]) || (tx < w - 1 && grid[i + 1]) ||
            (ty > 0 && grid[i - w]) || (ty < h - 1 && grid[i + w])
          ) {
            if (rng.next() < 0.45) add.push(i);
          }
        } else if (!t && c) {
          if (
            (tx > 0 && !grid[i - 1]) || (tx < w - 1 && !grid[i + 1]) ||
            (ty > 0 && !grid[i - w]) || (ty < h - 1 && !grid[i + w])
          ) {
            if (rng.next() < 0.3) rem.push(i);
          }
        }
      }
    }
    for (const i of add) {
      grid[i] = 1;
      this.touch(i % w, Math.floor(i / w));
      changed = true;
    }
    for (const i of rem) {
      grid[i] = 0;
      this.touch(i % w, Math.floor(i / w));
      changed = true;
    }
    if (changed) this.version++;
  }
}

function inside(tx: number, ty: number, bx: number, by: number, bw: number, bh: number): boolean {
  return tx >= bx && ty >= by && tx < bx + bw && ty < by + bh;
}
