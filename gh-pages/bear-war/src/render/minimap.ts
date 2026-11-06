import { TEAM_COLORS, TILE } from '../game/constants.ts';
import type { Game } from '../game/game.ts';
import type { Camera } from './camera.ts';
import type { TerrainRenderer } from './terrain.ts';

export interface Ping {
  x: number;
  y: number;
  t: number;
  color: string;
}

export class Minimap {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  base: HTMLCanvasElement | null = null;
  fog = document.createElement('canvas');
  pings: Ping[] = [];
  size = 160;
  dpr = 1;
  private worldW = 1;
  private worldH = 1;
  private fogVer = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  setGame(g: Game, terrain: TerrainRenderer): void {
    this.base = terrain.minimapImage(2);
    this.worldW = g.map.w * TILE;
    this.worldH = g.map.h * TILE;
    this.fog.width = g.map.w;
    this.fog.height = g.map.h;
    this.fogVer = -1;
  }

  resize(cssSize: number): void {
    this.size = cssSize;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssSize * this.dpr);
    this.canvas.height = Math.round(cssSize * this.dpr);
    this.canvas.style.width = cssSize + 'px';
    this.canvas.style.height = cssSize + 'px';
  }

  /** Map screen-space offset inside the minimap to world coordinates. */
  toWorld(ox: number, oy: number): { x: number; y: number } {
    const s = this.scale();
    const { offX, offY } = this.offsets();
    return { x: (ox - offX) / s, y: (oy - offY) / s };
  }

  private scale(): number {
    return this.size / Math.max(this.worldW, this.worldH);
  }
  private offsets(): { offX: number; offY: number } {
    const s = this.scale();
    return { offX: (this.size - this.worldW * s) / 2, offY: (this.size - this.worldH * s) / 2 };
  }

  draw(g: Game, team: number, player: number, cam: Camera, dt: number): void {
    const ctx = this.ctx;
    const s = this.scale();
    const { offX, offY } = this.offsets();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.size, this.size);
    ctx.translate(offX, offY);
    ctx.scale(s, s);
    ctx.imageSmoothingEnabled = true;
    if (this.base) ctx.drawImage(this.base, 0, 0, this.worldW, this.worldH);
    // comb
    const cr = g.comb;
    ctx.fillStyle = 'rgba(205,145,40,0.75)';
    for (let ty = 0; ty < cr.h; ty++) {
      for (let tx = 0; tx < cr.w; tx++) {
        if (cr.grid[ty * cr.w + tx] && (team < 0 || g.vision.explored[team][ty * cr.w + tx])) ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      }
    }
    const minDot = 2.2 / s;
    for (const e of g.entities) {
      if (!e.alive || e.inside || e.def.kind === 'cub') continue;
      const own = e.owner >= 0 && team >= 0 && g.players[e.owner].team === team;
      if (!own && team >= 0) {
        if (e.isResource) {
          if (!g.vision.exploredAt(team, e.x, e.y)) continue;
        } else if (e.isBuilding) {
          if (!g.vision.visibleAt(team, e.x, e.y) && !g.vision.visibleAt(team, e.x0 + 4, e.y0 + 4)) continue;
        } else {
          if (!g.vision.visibleAt(team, e.x, e.y)) continue;
          if (e.def.cloaked && !g.vision.detectedAt(team, e.x, e.y)) continue;
        }
      }
      if (e.isResource) {
        ctx.fillStyle = e.def.kind === 'mineral' ? '#7fdcff' : '#4fd06a';
        ctx.fillRect(e.x0, e.y0, e.x1 - e.x0, e.y1 - e.y0);
        continue;
      }
      const col = e.owner === player ? '#3dff5a' : (TEAM_COLORS[g.players[e.owner]?.color ?? 0] ?? TEAM_COLORS[0]).main;
      ctx.fillStyle = col;
      if (e.isBuilding) {
        ctx.fillRect(e.x0, e.y0, e.x1 - e.x0, e.y1 - e.y0);
      } else {
        const r = Math.max(minDot, e.r * 1.2);
        ctx.fillRect(e.x - r, e.y - r, r * 2, r * 2);
      }
    }
    // fog
    if (team >= 0) {
      const v = g.vision;
      if (this.fogVer !== v.version) {
        this.fogVer = v.version;
        const fctx = this.fog.getContext('2d')!;
        const img = fctx.createImageData(v.w, v.h);
        const vis = v.vis[team];
        const exp = v.explored[team];
        for (let i = 0; i < vis.length; i++) img.data[i * 4 + 3] = vis[i] ? 0 : exp[i] ? 110 : 220;
        fctx.putImageData(img, 0, 0);
      }
      ctx.drawImage(this.fog, 0, 0, this.worldW, this.worldH);
    }
    // camera rect
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5 / s;
    ctx.strokeRect(cam.x, cam.y, cam.viewW, cam.viewH);
    // pings
    for (const p of this.pings) {
      p.t -= dt;
      const k = Math.max(0, p.t / 2.5);
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = Math.min(1, k * 2);
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (1 - (p.t % 0.8) / 0.8) * 30 / s + 4 / s, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.pings = this.pings.filter((p) => p.t > 0);
  }
}
