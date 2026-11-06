// Procedural terrain: a smooth height field derived from the tile elevations is
// hill-shaded per pixel (light from the top-left), giving plateaus, cliffs and ramps a
// 3D look without any image assets. Rendered lazily in cached chunks.

import { TILE } from '../game/constants.ts';
import { F_CLIFF, F_EDGE, F_RAMP, F_ROCK, F_ROUGH, F_WATER, type GameMap, type Tileset } from '../game/map/gamemap.ts';
import type { Comb } from '../game/systems/comb.ts';
import { COMB_CHUNK } from '../game/systems/comb.ts';
import type { Camera } from './camera.ts';
import { fbm, hash2, hex, mix, mulberry, rgb, vnoise, type RGB } from './noise.ts';

interface Palette {
  low: string;
  mid: string;
  high: string;
  rock: string;
  water: string;
  deep: string;
  edge: string;
  tintA: string;
  tintB: string;
  pebble: string;
  comb: string;
  combDark: string;
  combVein: string;
}

export const TILESETS: Record<Tileset, Palette> = {
  badlands: {
    low: '#4c4033', mid: '#6a5843', high: '#8b7656', rock: '#5f5349', water: '#1f5363', deep: '#10303c', edge: '#0d0b09',
    tintA: '#7b5536', tintB: '#4f5a43', pebble: '#a28d6b', comb: '#a8731d', combDark: '#5a3a0e', combVein: '#e9b545',
  },
  frost: {
    low: '#5e6b78', mid: '#7f8f9e', high: '#a9b8c6', rock: '#59626c', water: '#1e4c70', deep: '#0f2b44', edge: '#0a0d10',
    tintA: '#8a9fb4', tintB: '#6d7a80', pebble: '#cfd9e2', comb: '#a8731d', combDark: '#5a3a0e', combVein: '#e9b545',
  },
  ash: {
    low: '#36302d', mid: '#4a423d', high: '#625751', rock: '#2f2a28', water: '#5a1d0c', deep: '#2e0b04', edge: '#080605',
    tintA: '#5a3a2a', tintB: '#3a3a3a', pebble: '#7a6d64', comb: '#a8731d', combDark: '#5a3a0e', combVein: '#e9b545',
  },
  verdant: {
    low: '#3b5230', mid: '#53703f', high: '#6e8c50', rock: '#585c50', water: '#1d5160', deep: '#0f2f3a', edge: '#0a0e08',
    tintA: '#6a7a3a', tintB: '#3f5a4a', pebble: '#9aa37a', comb: '#a8731d', combDark: '#5a3a0e', combVein: '#e9b545',
  },
};

const CHUNK_TILES = COMB_CHUNK; // 8 tiles per chunk side
const CHUNK_PX = CHUNK_TILES * TILE; // 256 world px
const HALF = CHUNK_PX / 2; // shaded at half resolution
const LEVEL_H = 38; // px of height per elevation level (for shading)

interface Chunk {
  base: HTMLCanvasElement;
  final: HTMLCanvasElement;
  combVer: number;
  used: number;
}

export class TerrainRenderer {
  map: GameMap;
  pal: Palette;
  heights: Float32Array;
  chunks = new Map<number, Chunk>();
  chunkCols: number;
  chunkRows: number;
  maxChunks = 64;
  frame = 0;
  private pool: HTMLCanvasElement[] = [];
  private shadeBuf: ImageData | null = null;
  private shadeCanvas: HTMLCanvasElement;

  constructor(map: GameMap) {
    this.map = map;
    this.pal = TILESETS[map.tileset] ?? TILESETS.badlands;
    this.chunkCols = Math.ceil(map.w / CHUNK_TILES);
    this.chunkRows = Math.ceil(map.h / CHUNK_TILES);
    this.heights = computeHeights(map);
    this.shadeCanvas = document.createElement('canvas');
    this.shadeCanvas.width = HALF;
    this.shadeCanvas.height = HALF;
  }

  private newCanvas(): HTMLCanvasElement {
    const c = this.pool.pop() ?? document.createElement('canvas');
    c.width = CHUNK_PX;
    c.height = CHUNK_PX;
    return c;
  }

  /** Bilinear tile height at world position. */
  heightAt(wx: number, wy: number): number {
    const m = this.map;
    const u = wx / TILE - 0.5;
    const v = wy / TILE - 0.5;
    let x0 = Math.floor(u);
    let y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const cl = (a: number, n: number) => (a < 0 ? 0 : a >= n ? n - 1 : a);
    const x1 = cl(x0 + 1, m.w);
    const y1 = cl(y0 + 1, m.h);
    x0 = cl(x0, m.w);
    y0 = cl(y0, m.h);
    const H = this.heights;
    const a = H[y0 * m.w + x0];
    const b = H[y0 * m.w + x1];
    const c = H[y1 * m.w + x0];
    const d = H[y1 * m.w + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  private renderBase(cx: number, cy: number): HTMLCanvasElement {
    const m = this.map;
    const pal = this.pal;
    const seed = m.seed * 131 + 7;
    const ox = cx * CHUNK_PX;
    const oy = cy * CHUNK_PX;
    // height samples at half resolution (2 world px per sample), with 1-sample margin
    const S = HALF + 2;
    const hbuf = new Float32Array(S * S);
    const rockMask = new Float32Array(S * S);
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const wx = ox + (i - 1) * 2 + 1;
        const wy = oy + (j - 1) * 2 + 1;
        let h = this.heightAt(wx, wy) * LEVEL_H;
        const tx = Math.floor(wx / TILE);
        const ty = Math.floor(wy / TILE);
        const f = m.inBounds(tx, ty) ? m.flags[ty * m.w + tx] : F_EDGE;
        // boulders on rock tiles
        let rm = 0;
        if (f & F_ROCK) {
          const n = fbm(wx / 26, wy / 26, seed + 3, 2);
          rm = Math.max(0, n - 0.32) * 2.2;
          h += rm * 26;
        }
        // rugged cliff faces
        if (f & F_CLIFF) h += (vnoise(wx / 9, wy / 9, seed + 9) - 0.5) * 10;
        h += (vnoise(wx / 23, wy / 23, seed + 1) - 0.5) * 3;
        hbuf[j * S + i] = h;
        rockMask[j * S + i] = rm;
      }
    }
    if (!this.shadeBuf) this.shadeBuf = new ImageData(HALF, HALF);
    const img = this.shadeBuf;
    const data = img.data;
    const cLow = hex(pal.low);
    const cMid = hex(pal.mid);
    const cHigh = hex(pal.high);
    const cRock = hex(pal.rock);
    const cWater = hex(pal.water);
    const cDeep = hex(pal.deep);
    const cEdge = hex(pal.edge);
    const cTA = hex(pal.tintA);
    const cTB = hex(pal.tintB);
    // light direction (from top-left, above)
    const lx = -0.55;
    const ly = -0.62;
    const lz = 0.56;
    for (let j = 0; j < HALF; j++) {
      for (let i = 0; i < HALF; i++) {
        const k = (j + 1) * S + (i + 1);
        const wx = ox + i * 2 + 1;
        const wy = oy + j * 2 + 1;
        const tx = Math.floor(wx / TILE);
        const ty = Math.floor(wy / TILE);
        const f = m.inBounds(tx, ty) ? m.flags[ty * m.w + tx] : F_EDGE;
        const gx = (hbuf[k + 1] - hbuf[k - 1]) / 4;
        const gy = (hbuf[k + S] - hbuf[k - S]) / 4;
        const nl = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const dot = (-gx * lx - gy * ly + lz) * nl;
        let sh = 0.42 + dot * 0.78;
        const steep = Math.min(1, Math.sqrt(gx * gx + gy * gy) * 0.9);
        const lev = Math.max(0, Math.min(2, hbuf[k] / LEVEL_H));
        let col: RGB = lev < 1 ? mix(cLow, cMid, lev) : mix(cMid, cHigh, lev - 1);
        // large-scale tint patches
        const t1 = fbm(wx / 160, wy / 160, seed + 21, 2);
        const t2 = fbm(wx / 110, wy / 110, seed + 33, 2);
        col = mix(col, cTA, Math.max(0, t1 - 0.5) * 0.9);
        col = mix(col, cTB, Math.max(0, t2 - 0.55) * 0.9);
        col = mix(col, cRock, steep * 0.75);
        const rm = rockMask[k];
        if (rm > 0) col = mix(col, cRock, Math.min(1, rm * 1.4));
        if (f & F_ROUGH) col = mix(col, cRock, 0.25);
        // fine grain
        const grain = vnoise(wx / 3.1, wy / 3.1, seed + 5) * 0.12 + vnoise(wx / 11, wy / 11, seed + 6) * 0.1 - 0.11;
        sh += grain;
        if (f & F_WATER) {
          // water: depth from distance to shore (approx by height dip)
          const depth = Math.max(0, Math.min(1, (this.heightAt(wx, wy) * -1 + (m.elev[ty * m.w + tx] - 0.0)) * 2));
          col = mix(cWater, cDeep, 0.35 + depth * 0.4);
          sh = 0.9 + (vnoise(wx / 14, wy / 6, seed + 40) - 0.5) * 0.25;
        }
        if (f & F_EDGE) {
          col = cEdge;
          sh = 1;
        }
        const o = (j * HALF + i) * 4;
        data[o] = Math.max(0, Math.min(255, col[0] * sh));
        data[o + 1] = Math.max(0, Math.min(255, col[1] * sh));
        data[o + 2] = Math.max(0, Math.min(255, col[2] * sh));
        data[o + 3] = 255;
      }
    }
    const sctx = this.shadeCanvas.getContext('2d')!;
    sctx.putImageData(img, 0, 0);
    const c = this.newCanvas();
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.shadeCanvas, 0, 0, CHUNK_PX, CHUNK_PX);
    this.drawDetails(ctx, cx, cy);
    return c;
  }

  /** Pebbles, cracks and debris at full resolution. */
  private drawDetails(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    const m = this.map;
    const pal = this.pal;
    const pebble = hex(pal.pebble);
    const seed = m.seed * 977 + 13;
    for (let ty = cy * CHUNK_TILES; ty < (cy + 1) * CHUNK_TILES && ty < m.h; ty++) {
      for (let tx = cx * CHUNK_TILES; tx < (cx + 1) * CHUNK_TILES && tx < m.w; tx++) {
        const f = m.flags[ty * m.w + tx];
        if (f & (F_EDGE | F_WATER)) continue;
        const rnd = mulberry((tx * 73856093) ^ (ty * 19349663) ^ seed);
        const lx = tx * TILE - cx * CHUNK_PX;
        const ly = ty * TILE - cy * CHUNK_PX;
        if (f & F_ROCK) {
          // boulder highlights
          if (rnd() < 0.55) {
            const bx = lx + 6 + rnd() * 20;
            const by = ly + 6 + rnd() * 20;
            const r = 4 + rnd() * 7;
            ctx.fillStyle = 'rgba(0,0,0,0.28)';
            ctx.beginPath();
            ctx.ellipse(bx + 3, by + 4, r, r * 0.8, 0, 0, Math.PI * 2);
            ctx.fill();
            const g = ctx.createRadialGradient(bx - r * 0.4, by - r * 0.4, 1, bx, by, r);
            g.addColorStop(0, rgb(mix(hex(pal.rock), [255, 255, 255], 0.35)));
            g.addColorStop(1, rgb(mix(hex(pal.rock), [0, 0, 0], 0.35)));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.ellipse(bx, by, r, r * 0.85, rnd() * 3, 0, Math.PI * 2);
            ctx.fill();
          }
          continue;
        }
        if (f & F_CLIFF) {
          if (rnd() < 0.5) {
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            const sx = lx + rnd() * 32;
            const sy = ly + rnd() * 32;
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + (rnd() - 0.5) * 16, sy + (rnd() - 0.5) * 16);
            ctx.stroke();
          }
          continue;
        }
        // pebbles
        const n = rnd() < 0.35 ? 1 + Math.floor(rnd() * 3) : 0;
        for (let i = 0; i < n; i++) {
          const px = lx + rnd() * 30 + 1;
          const py = ly + rnd() * 30 + 1;
          const r = 0.8 + rnd() * 1.8;
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.beginPath();
          ctx.arc(px + 0.8, py + 0.9, r, 0, Math.PI * 2);
          ctx.fill();
          const v = 0.75 + rnd() * 0.4;
          ctx.fillStyle = rgb([pebble[0] * v, pebble[1] * v, pebble[2] * v]);
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }
        // cracks
        if (!(f & F_RAMP) && rnd() < 0.06) {
          ctx.strokeStyle = 'rgba(20,12,6,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          let x = lx + rnd() * 32;
          let y = ly + rnd() * 32;
          ctx.moveTo(x, y);
          for (let s = 0; s < 4; s++) {
            x += (rnd() - 0.5) * 14;
            y += (rnd() - 0.5) * 14;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        // small craters
        if (!(f & F_RAMP) && rnd() < 0.012) {
          const x = lx + 16;
          const y = ly + 16;
          const r = 6 + rnd() * 6;
          const g = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, r);
          g.addColorStop(0, 'rgba(0,0,0,0.30)');
          g.addColorStop(0.7, 'rgba(0,0,0,0.12)');
          g.addColorStop(0.85, 'rgba(255,240,210,0.10)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    void hash2;
  }

  private renderComb(chunk: Chunk, cx: number, cy: number, comb: Comb): void {
    const ctx = chunk.final.getContext('2d')!;
    ctx.clearRect(0, 0, CHUNK_PX, CHUNK_PX);
    ctx.drawImage(chunk.base, 0, 0);
    const m = this.map;
    const pal = this.pal;
    const ox = cx * CHUNK_PX;
    const oy = cy * CHUNK_PX;
    // organic blobs: union of jittered circles, drawn in 3 layers for depth
    const layers: [string, number, number][] = [
      [pal.combDark, 1.0, 2],
      [pal.comb, 0.82, 0],
      [pal.combVein, 0.22, 0],
    ];
    for (const [color, scale, offset] of layers) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let ty = cy * CHUNK_TILES - 1; ty <= (cy + 1) * CHUNK_TILES; ty++) {
        for (let tx = cx * CHUNK_TILES - 1; tx <= (cx + 1) * CHUNK_TILES; tx++) {
          if (!comb.has(tx, ty)) continue;
          const h = hash2(tx, ty, 99);
          const jx = (h - 0.5) * 10;
          const jy = (hash2(ty, tx, 98) - 0.5) * 10;
          const x = tx * TILE + 16 + jx - ox + offset;
          const y = ty * TILE + 16 + jy - oy + offset;
          let r = (21 + h * 6) * scale;
          if (scale < 0.5) {
            // veins: only some tiles
            if (h > 0.45) continue;
            r = 3 + h * 6;
          }
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    // glossy speckles
    ctx.fillStyle = 'rgba(255,235,150,0.22)';
    for (let ty = cy * CHUNK_TILES; ty < (cy + 1) * CHUNK_TILES; ty++) {
      for (let tx = cx * CHUNK_TILES; tx < (cx + 1) * CHUNK_TILES; tx++) {
        if (!comb.has(tx, ty)) continue;
        const rnd = mulberry(tx * 31 + ty * 1013);
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.arc(tx * TILE - ox + rnd() * 32, ty * TILE - oy + rnd() * 32, 0.8 + rnd() * 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    void m;
    chunk.combVer = comb.chunkVer[cy * comb.cw + cx];
  }

  private getChunk(cx: number, cy: number, comb: Comb): Chunk {
    const key = cy * this.chunkCols + cx;
    let ch = this.chunks.get(key);
    if (!ch) {
      const base = this.renderBase(cx, cy);
      ch = { base, final: base, combVer: 0, used: this.frame };
      this.chunks.set(key, ch);
      this.evict();
    }
    ch.used = this.frame;
    const ver = comb.chunkVer[cy * comb.cw + cx];
    if (ver !== ch.combVer) {
      if (ch.final === ch.base) ch.final = this.newCanvas();
      this.renderComb(ch, cx, cy, comb);
    }
    return ch;
  }

  private evict(): void {
    if (this.chunks.size <= this.maxChunks) return;
    let oldestKey = -1;
    let oldest = Infinity;
    for (const [k, c] of this.chunks) {
      if (c.used < oldest) {
        oldest = c.used;
        oldestKey = k;
      }
    }
    const c = this.chunks.get(oldestKey);
    if (c) {
      this.pool.push(c.base);
      if (c.final !== c.base) this.pool.push(c.final);
      this.chunks.delete(oldestKey);
    }
  }

  /** Draw visible chunks. ctx must be in world coordinates. At most `budget` new chunks per frame. */
  /** ms of chunk generation allowed per frame (at least one chunk is always made) */
  budgetMs = 8;

  draw(ctx: CanvasRenderingContext2D, cam: Camera, comb: Comb, budget = 6): void {
    this.frame++;
    const t0 = performance.now();
    const x0 = Math.max(0, Math.floor(cam.x / CHUNK_PX));
    const y0 = Math.max(0, Math.floor(cam.y / CHUNK_PX));
    const x1 = Math.min(this.chunkCols - 1, Math.floor((cam.x + cam.viewW) / CHUNK_PX));
    const y1 = Math.min(this.chunkRows - 1, Math.floor((cam.y + cam.viewH) / CHUNK_PX));
    let made = 0;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = cy * this.chunkCols + cx;
        if (!this.chunks.has(key)) {
          if (made >= budget || (made > 0 && performance.now() - t0 > this.budgetMs)) {
            ctx.fillStyle = this.pal.low;
            ctx.fillRect(cx * CHUNK_PX, cy * CHUNK_PX, CHUNK_PX, CHUNK_PX);
            continue;
          }
          made++;
        }
        const ch = this.getChunk(cx, cy, comb);
        ctx.drawImage(ch.final, cx * CHUNK_PX, cy * CHUNK_PX, CHUNK_PX + 0.5, CHUNK_PX + 0.5);
      }
    }
    this.maxChunks = Math.max(64, (x1 - x0 + 2) * (y1 - y0 + 2) + 8);
  }

  /** Small overview image for the minimap (one pixel per tile, scaled up later). */
  minimapImage(scale = 2): HTMLCanvasElement {
    const m = this.map;
    const c = document.createElement('canvas');
    c.width = m.w * scale;
    c.height = m.h * scale;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(c.width, c.height);
    const pal = this.pal;
    const lv = [hex(pal.low), hex(pal.mid), hex(pal.high)];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const tx = Math.floor(x / scale);
        const ty = Math.floor(y / scale);
        const f = m.flags[ty * m.w + tx];
        let col: RGB = lv[Math.min(2, m.elev[ty * m.w + tx])];
        if (f & F_CLIFF) col = mix(col, [0, 0, 0], 0.45);
        if (f & F_ROCK) col = hex(pal.rock);
        if (f & F_WATER) col = hex(pal.water);
        if (f & F_EDGE) col = hex(pal.edge);
        if (f & F_RAMP) col = mix(col, [255, 255, 255], 0.08);
        const o = (y * c.width + x) * 4;
        img.data[o] = col[0];
        img.data[o + 1] = col[1];
        img.data[o + 2] = col[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
}

function computeHeights(m: GameMap): Float32Array {
  const { w, h } = m;
  const H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) H[i] = m.elev[i];
  // cliffs sit halfway down
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const i = ty * w + tx;
      if (!(m.flags[i] & F_CLIFF)) continue;
      let lo = m.elev[i];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          lo = Math.min(lo, m.elev[y * w + x]);
        }
      }
      H[i] = (m.elev[i] + lo) / 2;
    }
  }
  // ramps: relax towards the average of their neighbours (harmonic interpolation)
  const ramps: number[] = [];
  for (let i = 0; i < w * h; i++) if (m.flags[i] & F_RAMP) ramps.push(i);
  for (let it = 0; it < 40; it++) {
    for (const i of ramps) {
      const tx = i % w;
      const ty = (i - tx) / w;
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          s += H[y * w + x];
          n++;
        }
      }
      if (n) H[i] = s / n;
    }
  }
  for (let i = 0; i < w * h; i++) if (m.flags[i] & F_WATER) H[i] -= 0.45;
  return H;
}
