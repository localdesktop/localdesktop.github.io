// Fog of war. Per-team visibility at tile resolution, recomputed every few ticks.
// Ground units cannot see up cliffs: a tile is only visible if its elevation is not
// higher than the viewer's. Air units, scans and detection ignore elevation.

import { TILE } from '../constants.ts';
import type { Game } from '../game.ts';

export class Vision {
  w: number;
  h: number;
  teams: number;
  vis: Uint8Array[];
  explored: Uint8Array[];
  det: Uint8Array[];
  version = 0;
  private circles = new Map<number, Int16Array>();

  constructor(w: number, h: number, teams: number) {
    this.w = w;
    this.h = h;
    this.teams = teams;
    this.vis = [];
    this.explored = [];
    this.det = [];
    for (let t = 0; t < teams; t++) {
      this.vis.push(new Uint8Array(w * h));
      this.explored.push(new Uint8Array(w * h));
      this.det.push(new Uint8Array(w * h));
    }
  }

  private circle(r: number): Int16Array {
    const key = Math.round(r * 4);
    let c = this.circles.get(key);
    if (!c) {
      const pts: number[] = [];
      const rr = (key / 4) * (key / 4);
      const R = Math.ceil(key / 4);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= rr) pts.push(dx, dy);
      c = new Int16Array(pts);
      this.circles.set(key, c);
    }
    return c;
  }

  /** Stamp a vision circle (radius in tiles) centred at world (x, y). */
  stamp(team: number, x: number, y: number, r: number, elev: number, ignoreElev: boolean, detect: boolean, detectR: number, elevMap: Uint8Array): void {
    const cx = Math.floor(x / TILE);
    const cy = Math.floor(y / TILE);
    const vis = this.vis[team];
    const exp = this.explored[team];
    const c = this.circle(r);
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < c.length; i += 2) {
      const tx = cx + c[i];
      const ty = cy + c[i + 1];
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const t = ty * w + tx;
      if (!ignoreElev && elevMap[t] > elev) continue;
      vis[t] = 1;
      exp[t] = 1;
    }
    if (detect) {
      const det = this.det[team];
      const d = this.circle(detectR);
      for (let i = 0; i < d.length; i += 2) {
        const tx = cx + d[i];
        const ty = cy + d[i + 1];
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        det[ty * w + tx] = 1;
      }
    }
  }

  update(g: Game): void {
    for (let t = 0; t < this.teams; t++) {
      this.vis[t].fill(0);
      this.det[t].fill(0);
    }
    const elev = g.map.elev;
    const w = this.w;
    for (const e of g.entities) {
      if (!e.alive || e.owner < 0 || e.inside) continue;
      const team = g.players[e.owner].team;
      let sight = e.def.sight;
      if (e.isBuilding && !e.built) sight = Math.min(sight, 5);
      const tx = Math.floor(e.x / TILE);
      const ty = Math.floor(e.y / TILE);
      const el = tx >= 0 && ty >= 0 && tx < w && ty < this.h ? elev[ty * w + tx] : 0;
      const isDet = !!e.def.detector && (e.built || !e.isBuilding);
      this.stamp(team, e.x, e.y, sight, el, e.air, isDet, e.def.detector ?? 0, elev);
    }
    for (const fx of g.effects) {
      if (fx.kind === 'sniff') this.stamp(fx.team, fx.x, fx.y, fx.r / TILE, 0, true, true, fx.r / TILE, elev);
      else if (fx.kind === 'spirit') this.stamp(fx.team, fx.x, fx.y, 4, 0, true, false, 0, elev);
    }
    // players without a town hall are revealed to all
    for (const p of g.players) {
      if (!p.revealed || p.defeated) continue;
      for (const e of g.entities) {
        if (!e.alive || e.owner !== p.index || !e.isBuilding) continue;
        for (let t = 0; t < this.teams; t++) if (t !== p.team) this.stamp(t, e.x, e.y, 3, 0, true, false, 0, elev);
      }
    }
    this.version++;
  }

  visibleTile(team: number, tx: number, ty: number): boolean {
    if (team < 0) return true;
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.vis[team][ty * this.w + tx] !== 0;
  }
  visibleAt(team: number, x: number, y: number): boolean {
    return this.visibleTile(team, Math.floor(x / TILE), Math.floor(y / TILE));
  }
  exploredAt(team: number, x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (team < 0) return true;
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    return this.explored[team][ty * this.w + tx] !== 0;
  }
  detectedAt(team: number, x: number, y: number): boolean {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return false;
    const i = ty * this.w + tx;
    return this.det[team][i] !== 0 && this.vis[team][i] !== 0;
  }
}
