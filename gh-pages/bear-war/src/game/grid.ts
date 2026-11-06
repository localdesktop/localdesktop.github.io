// Walkability grid (16px cells) with clearance values and an A* pathfinder.
// Units only treat terrain and structures as obstacles; other units are handled by
// local collision avoidance, like modern RTS games.

import { CELL, CELLS_PER_TILE } from './constants.ts';
import type { GameMap } from './map/gamemap.ts';

const SQRT2 = 1.4142135623730951;
const HEUR_W = 1.25; // slightly greedy A*: far fewer expansions, near-optimal paths

export class PathGrid {
  cw: number;
  ch: number;
  terrain: Uint8Array;
  occ: Uint8Array;
  clear: Uint8Array;
  dirty = false;
  version = 0;
  /** node expansions performed by the most recent findPath (for budgeting) */
  lastExpanded = 0;

  private g: Float64Array;
  private parent: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heapNode: Int32Array;
  private heapF: Float64Array;
  private heapH: Float64Array;
  private heapLen = 0;

  constructor(map: GameMap) {
    this.cw = map.w * CELLS_PER_TILE;
    this.ch = map.h * CELLS_PER_TILE;
    const n = this.cw * this.ch;
    this.terrain = new Uint8Array(n);
    this.occ = new Uint8Array(n);
    this.clear = new Uint8Array(n);
    for (let cy = 0; cy < this.ch; cy++) {
      for (let cx = 0; cx < this.cw; cx++) {
        const tx = Math.floor(cx / CELLS_PER_TILE);
        const ty = Math.floor(cy / CELLS_PER_TILE);
        this.terrain[cy * this.cw + cx] = map.walkable(tx, ty) ? 0 : 1;
      }
    }
    this.g = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heapNode = new Int32Array(4096);
    this.heapF = new Float64Array(4096);
    this.heapH = new Float64Array(4096);
    this.recomputeClearance();
  }

  blockedIdx(i: number): boolean {
    return this.terrain[i] !== 0 || this.occ[i] !== 0;
  }

  /** Mark (or unmark) a building/resource footprint given in tiles. */
  setFootprint(tx: number, ty: number, tw: number, th: number, add: boolean): void {
    const x0 = tx * CELLS_PER_TILE;
    const y0 = ty * CELLS_PER_TILE;
    const x1 = (tx + tw) * CELLS_PER_TILE;
    const y1 = (ty + th) * CELLS_PER_TILE;
    for (let y = y0; y < y1; y++) {
      if (y < 0 || y >= this.ch) continue;
      for (let x = x0; x < x1; x++) {
        if (x < 0 || x >= this.cw) continue;
        const i = y * this.cw + x;
        this.occ[i] = add ? this.occ[i] + 1 : Math.max(0, this.occ[i] - 1);
      }
    }
    this.dirty = true;
  }

  /** Euclidean distance (in cells, floored) from each cell to the nearest blocked cell or the map edge. */
  recomputeClearance(): void {
    const { cw, ch, clear } = this;
    const W = cw + 2;
    const H = ch + 2;
    const INF = 1e9;
    const d2 = new Float64Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x > 0 && y > 0 && x <= cw && y <= ch;
        d2[y * W + x] = inside && !this.blockedIdx((y - 1) * cw + x - 1) ? INF : 0;
      }
    }
    const n = Math.max(W, H);
    const f = new Float64Array(n);
    const out = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    // Felzenszwalb's 1D squared distance transform, run over columns then rows
    const pass = (len: number) => {
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1; q < len; q++) {
        let sx = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (sx <= z[k]) {
          k--;
          sx = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = sx;
        z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    };
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = d2[y * W + x];
      pass(H);
      for (let y = 0; y < H; y++) d2[y * W + x] = out[y];
    }
    for (let y = 1; y <= ch; y++) {
      for (let x = 0; x < W; x++) f[x] = d2[y * W + x];
      pass(W);
      for (let x = 1; x <= cw; x++) {
        const c = Math.floor(Math.sqrt(out[x]));
        clear[(y - 1) * cw + x - 1] = c > 255 ? 255 : c;
      }
    }
    this.dirty = false;
    this.version++;
  }

  cellX(x: number): number {
    const c = Math.floor(x / CELL);
    return c < 0 ? 0 : c >= this.cw ? this.cw - 1 : c;
  }
  cellY(y: number): number {
    const c = Math.floor(y / CELL);
    return c < 0 ? 0 : c >= this.ch ? this.ch - 1 : c;
  }
  cellAt(x: number, y: number): number {
    return this.cellY(y) * this.cw + this.cellX(x);
  }
  passable(cx: number, cy: number, req: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.cw || cy >= this.ch) return false;
    return this.clear[cy * this.cw + cx] >= req;
  }
  passableAt(x: number, y: number, req: number): boolean {
    if (x < 0 || y < 0) return false;
    return this.passable(Math.floor(x / CELL), Math.floor(y / CELL), req);
  }

  /** Nearest passable cell to (cx, cy) within maxR rings, or -1. */
  nearestPassable(cx: number, cy: number, req: number, maxR: number): number {
    if (this.passable(cx, cy, req)) return cy * this.cw + cx;
    for (let r = 1; r <= maxR; r++) {
      let best = -1;
      let bestD = 1e18;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!this.passable(x, y, req)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = y * this.cw + x;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Nearest passable point (cell centre) to a world position. */
  nearestFreePoint(x: number, y: number, req: number, maxR = 40): { x: number; y: number } | null {
    const c = this.nearestPassable(this.cellX(x), this.cellY(y), req, maxR);
    if (c < 0) return null;
    const cx = c % this.cw;
    const cy = (c - cx) / this.cw;
    if (cx === this.cellX(x) && cy === this.cellY(y)) return { x, y };
    return { x: (cx + 0.5) * CELL, y: (cy + 0.5) * CELL };
  }

  /** Supercover line test: every cell touched by the segment must be passable. */
  lineClear(x0: number, y0: number, x1: number, y1: number, req: number): boolean {
    let cx = Math.floor(x0 / CELL);
    let cy = Math.floor(y0 / CELL);
    const ex = Math.floor(x1 / CELL);
    const ey = Math.floor(y1 / CELL);
    if (!this.passable(cx, cy, req)) return false;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const adx = dx < 0 ? -dx : dx;
    const ady = dy < 0 ? -dy : dy;
    let tMaxX = adx > 0 ? (stepX > 0 ? (cx + 1) * CELL - x0 : x0 - cx * CELL) / adx : 1e18;
    let tMaxY = ady > 0 ? (stepY > 0 ? (cy + 1) * CELL - y0 : y0 - cy * CELL) / ady : 1e18;
    const tdx = adx > 0 ? CELL / adx : 1e18;
    const tdy = ady > 0 ? CELL / ady : 1e18;
    let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 4;
    while ((cx !== ex || cy !== ey) && guard-- > 0) {
      if (tMaxX < tMaxY - 1e-12) {
        tMaxX += tdx;
        cx += stepX;
      } else if (tMaxY < tMaxX - 1e-12) {
        tMaxY += tdy;
        cy += stepY;
      } else {
        // passing exactly through a corner: both side cells must be open
        if (!this.passable(cx + stepX, cy, req) || !this.passable(cx, cy + stepY, req)) return false;
        tMaxX += tdx;
        tMaxY += tdy;
        cx += stepX;
        cy += stepY;
      }
      if (!this.passable(cx, cy, req)) return false;
    }
    return true;
  }

  private heapPush(node: number, f: number, h: number): void {
    if (this.heapLen >= this.heapNode.length) {
      const n = this.heapNode.length * 2;
      const a = new Int32Array(n);
      a.set(this.heapNode);
      this.heapNode = a;
      const b = new Float64Array(n);
      b.set(this.heapF);
      this.heapF = b;
      const c = new Float64Array(n);
      c.set(this.heapH);
      this.heapH = c;
    }
    const hn = this.heapNode;
    const hf = this.heapF;
    const hh = this.heapH;
    let i = this.heapLen++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] < f || (hf[p] === f && (hh[p] < h || (hh[p] === h && hn[p] < node)))) break;
      hn[i] = hn[p];
      hf[i] = hf[p];
      hh[i] = hh[p];
      i = p;
    }
    hn[i] = node;
    hf[i] = f;
    hh[i] = h;
  }

  private heapPop(): number {
    const hn = this.heapNode;
    const hf = this.heapF;
    const hh = this.heapH;
    const top = hn[0];
    const n = --this.heapLen;
    if (n > 0) {
      const node = hn[n];
      const f = hf[n];
      const h = hh[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        const r = c + 1;
        if (r < n && (hf[r] < hf[c] || (hf[r] === hf[c] && (hh[r] < hh[c] || (hh[r] === hh[c] && hn[r] < hn[c]))))) c = r;
        if (f < hf[c] || (f === hf[c] && (h < hh[c] || (h === hh[c] && node < hn[c])))) break;
        hn[i] = hn[c];
        hf[i] = hf[c];
        hh[i] = hh[c];
        i = c;
      }
      hn[i] = node;
      hf[i] = f;
      hh[i] = h;
    }
    return top;
  }

  /**
   * Find a path from (sx,sy) to (gx,gy) for a unit needing clearance `req`.
   * Returns smoothed waypoints as a flat [x0,y0,x1,y1,...] array (start excluded),
   * or null if no progress is possible. If the goal is unreachable, the path leads
   * to the closest reachable point.
   */
  findPath(sx: number, sy: number, gx: number, gy: number, req: number, maxNodes = 25000): number[] | null {
    const cw = this.cw;
    let s = this.nearestPassable(this.cellX(sx), this.cellY(sy), req, 4);
    if (s < 0) return null;
    let goalX = gx;
    let goalY = gy;
    let t = this.cellAt(gx, gy);
    if (this.clear[t] < req) {
      t = this.nearestPassable(this.cellX(gx), this.cellY(gy), req, 30);
      if (t < 0) return null;
      const tx = t % cw;
      goalX = (tx + 0.5) * CELL;
      goalY = ((t - tx) / cw + 0.5) * CELL;
    }
    this.lastExpanded = 0;
    if (s === t || this.lineClear(sx, sy, goalX, goalY, req)) return [goalX, goalY];

    const gen = ++this.gen;
    const g = this.g;
    const parent = this.parent;
    const seen = this.seen;
    const closed = this.closed;
    const tx = t % cw;
    const ty = (t - tx) / cw;
    const heur = (i: number) => {
      const x = i % cw;
      const y = (i - x) / cw;
      const dx = x > tx ? x - tx : tx - x;
      const dy = y > ty ? y - ty : ty - y;
      return dx > dy ? dx + (SQRT2 - 1) * dy : dy + (SQRT2 - 1) * dx;
    };
    this.heapLen = 0;
    g[s] = 0;
    seen[s] = gen;
    parent[s] = -1;
    const h0 = heur(s);
    this.heapPush(s, h0 * HEUR_W, h0);
    let best = s;
    let bestH = h0;
    let found = false;
    let expanded = 0;
    while (this.heapLen > 0) {
      const c = this.heapPop();
      if (closed[c] === gen) continue;
      closed[c] = gen;
      if (c === t) {
        found = true;
        break;
      }
      if (++expanded > maxNodes) break;
      const cx = c % cw;
      const cy = (c - cx) / cw;
      const gc = g[c];
      for (let dir = 0; dir < 8; dir++) {
        const dx = dir === 0 || dir === 4 || dir === 5 ? 1 : dir === 1 || dir === 6 || dir === 7 ? -1 : 0;
        const dy = dir === 2 || dir === 4 || dir === 6 ? 1 : dir === 3 || dir === 5 || dir === 7 ? -1 : 0;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= this.ch) continue;
        const n = ny * cw + nx;
        if (this.clear[n] < req || closed[n] === gen) continue;
        let cost = 1;
        if (dx !== 0 && dy !== 0) {
          if (this.clear[cy * cw + nx] < req || this.clear[ny * cw + cx] < req) continue;
          cost = SQRT2;
        }
        const ng = gc + cost;
        if (seen[n] !== gen || ng < g[n]) {
          seen[n] = gen;
          g[n] = ng;
          parent[n] = c;
          const h = heur(n);
          if (h < bestH) {
            bestH = h;
            best = n;
          }
          this.heapPush(n, ng + h * HEUR_W, h);
        }
      }
    }
    this.lastExpanded = expanded;
    const end = found ? t : best;
    if (end === s) return null;
    // reconstruct
    const cells: number[] = [];
    for (let c = end; c !== -1 && c !== s; c = parent[c]) cells.push(c);
    cells.reverse();
    const pts: number[] = [];
    for (const c of cells) {
      const x = c % cw;
      pts.push((x + 0.5) * CELL, ((c - x) / cw + 0.5) * CELL);
    }
    if (found) {
      pts[pts.length - 2] = goalX;
      pts[pts.length - 1] = goalY;
    }
    return this.smooth(sx, sy, pts, req);
  }

  /** Greedy string-pulling using line-of-sight checks. */
  private smooth(sx: number, sy: number, pts: number[], req: number): number[] {
    const n = pts.length / 2;
    const out: number[] = [];
    let curX = sx;
    let curY = sy;
    let i = -1;
    while (i < n - 1) {
      let j = i + 1;
      while (j + 1 < n && this.lineClear(curX, curY, pts[(j + 1) * 2], pts[(j + 1) * 2 + 1], req)) j++;
      curX = pts[j * 2];
      curY = pts[j * 2 + 1];
      out.push(curX, curY);
      i = j;
    }
    return out;
  }
}

/** Clearance (in cells) a unit of radius r needs. */
export function clearanceFor(radius: number): number {
  return radius <= 11 ? 1 : radius <= 24 ? 2 : 3;
}
