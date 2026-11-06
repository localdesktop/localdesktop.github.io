// Draws the game world: terrain, structures, units, projectiles, effects, fog of war
// and world-space UI (selection rings, health bars, rally points, placement ghost).

import { cargoUsed } from '../game/systems/cargo.ts';
import { TEAM_COLORS, TILE } from '../game/constants.ts';
import { DEFS, switchingMode } from '../game/data/index.ts';
import type { EntityDef } from '../game/data/types.ts';
import type { Entity } from '../game/entity.ts';
import type { Game } from '../game/game.ts';
import { maxHp, maxShields } from '../game/stats.ts';
import type { AreaEffect, Projectile } from '../game/types.ts';
import { Camera } from './camera.ts';
import { Effects, glowSprite } from './effects.ts';
import { SpriteCache, teamPal } from './sprites.ts';
import { TerrainRenderer } from './terrain.ts';
import type { ArtDef } from './art/index.ts';

export interface Marker {
  x: number;
  y: number;
  t: number;
  color: string;
}

export interface Placement {
  def: EntityDef;
  tx: number;
  ty: number;
  ok: boolean;
  bad: boolean[];
}

export interface ViewState {
  player: number;
  team: number;
  selection: Entity[];
  hover: Entity | null;
  placement: Placement | null;
  showPower: boolean;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null;
  markers: Marker[];
  showAllBars: boolean;
  /** world-space range circle for targeting */
  rangeRing: { x: number; y: number; r: number } | null;
}

interface Memory {
  def: EntityDef;
  owner: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  built: boolean;
  progress: number;
}

interface RState {
  walk: number;
  lx: number;
  ly: number;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cam = new Camera();
  dpr = 1;
  sprites: SpriteCache;
  fx = new Effects();
  terrain: TerrainRenderer | null = null;
  time = 0;
  private fogCanvas = document.createElement('canvas');
  private fogVer = -1;
  private fogTeam = -2;
  private memory = new Map<number, Memory>();
  private rstate = new Map<number, RState>();
  private game: Game | null = null;
  maxDpr = 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.sprites = new SpriteCache(2, 1.5);
  }

  setGame(g: Game): void {
    this.game = g;
    this.terrain = new TerrainRenderer(g.map);
    this.cam.worldW = g.map.w * TILE;
    this.cam.worldH = g.map.h * TILE;
    this.memory.clear();
    this.rstate.clear();
    this.fogCanvas.width = g.map.w;
    this.fogCanvas.height = g.map.h;
    this.fogVer = -1;
    this.fx = new Effects();
  }

  resize(cssW: number, cssH: number): void {
    this.dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.cam.w = cssW;
    this.cam.h = cssH;
    this.cam.clamp();
  }

  /** Can the viewer see entity e right now? Returns 0 hidden, 1 visible, 2 cloaked-shimmer. */
  visibility(g: Game, e: Entity, team: number): number {
    if (e.inside) return 0;
    if (team < 0) return 1;
    if (e.owner >= 0 && g.players[e.owner].team === team) return 1;
    if (e.isBuilding || e.isResource) {
      const v = g.vision;
      return v.visibleAt(team, e.x, e.y) || v.visibleAt(team, e.x0 + 4, e.y0 + 4) || v.visibleAt(team, e.x1 - 4, e.y1 - 4) ||
        v.visibleAt(team, e.x1 - 4, e.y0 + 4) || v.visibleAt(team, e.x0 + 4, e.y1 - 4) ? 1 : 0;
    }
    if (!g.vision.visibleAt(team, e.x, e.y)) return 0;
    if (e.def.cloaked && !g.vision.detectedAt(team, e.x, e.y)) return 2;
    return 1;
  }

  private updateMemory(g: Game, team: number): void {
    if (team < 0) return;
    for (const e of g.entities) {
      if (!e.alive || !(e.isBuilding || e.isResource)) continue;
      if (e.owner >= 0 && g.players[e.owner].team === team) continue;
      if (this.visibility(g, e, team)) {
        this.memory.set(e.id, { def: e.def, owner: e.owner, x: e.x, y: e.y, tx: e.tx, ty: e.ty, built: e.built, progress: e.progress });
      }
    }
    // forget remembered structures whose location is visible but which are gone
    for (const [id, m] of this.memory) {
      const e = g.get(id);
      if (e) continue;
      if (g.vision.visibleAt(team, m.x, m.y)) this.memory.delete(id);
    }
  }

  draw(g: Game, alpha: number, v: ViewState, dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    const cam = this.cam;
    const k = this.dpr * cam.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.wk = k;
    this.wox = -cam.x * k;
    this.woy = -cam.y * k;
    ctx.setTransform(k, 0, 0, k, this.wox, this.woy);
    ctx.imageSmoothingEnabled = true;
    if (!this.terrain) return;
    this.terrain.draw(ctx, cam, g.comb, 6);
    this.fx.update(dt);
    this.fx.drawDecals(ctx);

    const team = v.team;
    if (g.tick % 4 === 0 || this.memory.size === 0) this.updateMemory(g, team);
    const vx0 = cam.x - 120;
    const vy0 = cam.y - 120;
    const vx1 = cam.x + cam.viewW + 120;
    const vy1 = cam.y + cam.viewH + 120;
    const inView = (x: number, y: number) => x > vx0 && x < vx1 && y > vy0 && y < vy1;

    // power fields
    if (v.showPower) this.drawPowerFields(g, v.player);

    // area effects on the ground
    for (const fx of g.effects) this.drawArea(fx, team, g);

    // remembered (fogged) structures
    for (const [id, m] of this.memory) {
      if (!inView(m.x, m.y)) continue;
      const e = g.get(id);
      if (e && this.visibility(g, e, team)) continue;
      this.drawStructureSprite(m.def, m.owner < 0 ? -1 : g.players[m.owner].color, m.x, m.y, m.built ? 1 : m.progress, 0.55, null);
    }

    const sel = new Set(v.selection.map((e) => e.id));
    const visible: Entity[] = [];
    const air: Entity[] = [];
    for (const e of g.entities) {
      if (!e.alive) continue;
      const ix = e.px + (e.x - e.px) * alpha;
      const iy = e.py + (e.y - e.py) * alpha;
      if (!inView(ix, iy)) continue;
      const vis = this.visibility(g, e, team);
      if (!vis) continue;
      if (e.air) air.push(e);
      else visible.push(e);
    }

    // selection rings (ground)
    for (const e of visible) if (sel.has(e.id) || v.hover === e) this.drawSelRing(g, e, alpha, v, sel.has(e.id));

    // structures & resources
    for (const e of visible) {
      if (!(e.isBuilding || e.isResource)) continue;
      this.drawStructure(g, e, team);
    }
    // ground units
    for (const e of visible) {
      if (e.isBuilding || e.isResource) continue;
      this.drawUnit(g, e, alpha, team);
    }
    this.drawProjectiles(g, alpha, false, team);
    this.fx.draw(ctx, false);

    // air units with shadows
    for (const e of air) {
      const ix = e.px + (e.x - e.px) * alpha;
      const iy = e.py + (e.y - e.py) * alpha;
      ctx.globalAlpha = 0.3;
      ctx.drawImage(glowSprite(0, 0, 0), ix - e.r + 10, iy - e.r * 0.8 + 16, e.r * 2, e.r * 1.6);
      ctx.globalAlpha = 1;
    }
    for (const e of air) if (sel.has(e.id) || v.hover === e) this.drawSelRing(g, e, alpha, v, sel.has(e.id));
    for (const e of air) this.drawUnit(g, e, alpha, team);
    this.drawProjectiles(g, alpha, true, team);
    this.fx.draw(ctx, true);

    // fog of war
    if (team >= 0) this.drawFog(g, team);

    // overlays
    for (const e of [...visible, ...air]) {
      const show = v.showAllBars || sel.has(e.id) || v.hover === e || this.damaged(g, e);
      if (show && (e.isUnit || e.isBuilding) && e.def.kind !== 'cub') this.drawBars(g, e, alpha, sel.has(e.id), v.player);
    }
    this.drawRallies(g, v);
    if (v.placement) this.drawPlacement(g, v.placement, v.player);
    if (v.rangeRing) {
      ctx.strokeStyle = 'rgba(120,220,255,0.5)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.5 / cam.zoom;
      ctx.beginPath();
      ctx.arc(v.rangeRing.x, v.rangeRing.y, v.rangeRing.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.drawMarkers(v.markers, dt);

    // screen-space overlays
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (v.dragBox) {
      const b = v.dragBox;
      ctx.strokeStyle = 'rgba(80,255,120,0.9)';
      ctx.fillStyle = 'rgba(80,255,120,0.08)';
      ctx.lineWidth = 1;
      const x = Math.min(b.x0, b.x1);
      const y = Math.min(b.y0, b.y1);
      ctx.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
  }

  private damaged(g: Game, e: Entity): boolean {
    if (e.isResource) return false;
    const p = g.players[e.owner];
    return e.hp < maxHp(e, p) - 0.5 || e.shields < maxShields(e) - 0.5 || (e.isBuilding && !e.built);
  }

  private colorOf(g: Game, owner: number): number {
    return owner < 0 ? -1 : g.players[owner].color;
  }

  // ------------------------------------------------------------------ units

  private drawUnit(g: Game, e: Entity, alpha: number, team: number): void {
    const ctx = this.ctx;
    const ix = e.px + (e.x - e.px) * alpha;
    const iy = e.py + (e.y - e.py) * alpha;
    const color = this.colorOf(g, e.owner);
    const art = this.sprites.art(e.def);
    let rs = this.rstate.get(e.id);
    if (!rs) {
      rs = { walk: 0, lx: ix, ly: iy };
      this.rstate.set(e.id, rs);
    }
    const moved = Math.abs(ix - rs.lx) + Math.abs(iy - rs.ly);
    if (moved < 40) rs.walk += moved;
    rs.lx = ix;
    rs.ly = iy;
    const frames = art.frames ?? 1;
    let frame = 0;
    if (frames > 1) {
      if (e.def.kind === 'cub' || e.def.kind === 'cocoon' || e.air) frame = Math.floor(this.time * 6 + e.id) % frames;
      else frame = Math.floor(rs.walk / Math.max(4, e.r * 0.9)) % frames;
    }
    const vis = this.visibility(g, e, team);
    const own = team >= 0 && e.owner >= 0 && g.players[e.owner].team === team;
    let a = 1;
    if (e.def.cloaked) a = vis === 2 ? 0.14 : own ? 0.5 : 0.85;
    const bob = e.air ? Math.sin(this.time * 2 + e.id) * 1.5 : 0;
    ctx.globalAlpha = a;
    if (e.morphTo && e.def.kind === 'unit' && !switchingMode(e.morphTo, e.def)) {
      // cocoon
      this.drawCocoon(ix, iy, e.r * 1.2, e.morphT / Math.max(1, e.morphTotal));
      ctx.globalAlpha = 1;
      return;
    }
    // ground shadow for ground units
    if (!e.air && e.def.kind === 'unit') {
      ctx.globalAlpha = 0.28 * a;
      ctx.drawImage(glowSprite(0, 0, 0), ix - e.r * 1.1 + 2, iy - e.r * 0.9 + 3, e.r * 2.2, e.r * 1.9);
      ctx.globalAlpha = a;
    }
    const s = this.sprites.get(e.def, color, 'body', frame);
    if (s) this.blit(s.canvas, s.w, s.h, ix, iy + bob, e.def.kind === 'cub' || e.def.kind === 'cocoon' ? 0 : e.angle);
    const t = art.turret ? this.sprites.get(e.def, color, 'turret', frame) : null;
    if (t) this.blit(t.canvas, t.w, t.h, ix, iy + bob, e.turret);
    if (e.carry > 0 && e.def.worker) this.drawCargo(e, ix, iy);
    if (art.overlay) {
      ctx.save();
      ctx.translate(ix, iy + bob);
      ctx.rotate(e.angle);
      art.overlay(ctx, teamPal(color < 0 ? 0 : color), { t: this.time, built: true, powered: true, working: g.tick - e.lastAttackTick < 10, seed: e.id }, e.def);
      ctx.restore();
    }
    const fl = this.fx.flash.get(e.id);
    if (fl) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, fl * 6);
      ctx.drawImage(glowSprite(255, 255, 255), ix - e.r, iy - e.r, e.r * 2, e.r * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (e.rushT > 0) {
      ctx.globalAlpha = 0.25 + 0.15 * Math.sin(this.time * 20);
      ctx.drawImage(glowSprite(255, 60, 40), ix - e.r * 1.4, iy - e.r * 1.4, e.r * 2.8, e.r * 2.8);
    }
    if (e.def.weapons?.[0]?.zone && (own || vis)) {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = Renderer.colorCss(color < 0 ? 0 : color);
      ctx.lineWidth = 1.5 / this.cam.zoom;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(e.zoneX, e.zoneY, e.def.weapons[0].zone * TILE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (e.bubble > 0) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#7fd0ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ix, iy, e.r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (switchingMode(e.morphTo, e.def)) {
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = '#ffd36b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ix, iy, e.r + 3, this.time * 4, this.time * 4 + 2 * Math.PI * (e.morphT / Math.max(1, e.morphTotal)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** world transform (scale and offset) of the current frame */
  private wk = 1;
  private wox = 0;
  private woy = 0;

  /** Draw a sprite centred at (x,y) rotated by ang, without save/restore (hot path). */
  private blit(c: HTMLCanvasElement, w: number, h: number, x: number, y: number, ang: number): void {
    const ctx = this.ctx;
    if (ang === 0) {
      ctx.drawImage(c, x - w / 2, y - h / 2, w, h);
      return;
    }
    const k = this.wk;
    const cs = Math.cos(ang) * k;
    const sn = Math.sin(ang) * k;
    ctx.setTransform(cs, sn, -sn, cs, x * k + this.wox, y * k + this.woy);
    ctx.drawImage(c, -w / 2, -h / 2, w, h);
    ctx.setTransform(k, 0, 0, k, this.wox, this.woy);
  }

  private drawCargo(e: Entity, x: number, y: number): void {
    const ctx = this.ctx;
    const ox = x + Math.cos(e.angle + 2.6) * e.r * 0.6;
    const oy = y + Math.sin(e.angle + 2.6) * e.r * 0.6;
    if (e.carryKind === 1) {
      ctx.fillStyle = '#7fe3ff';
      ctx.strokeStyle = '#1d6f8f';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(ox, oy - 4);
      ctx.lineTo(ox + 3, oy);
      ctx.lineTo(ox, oy + 4);
      ctx.lineTo(ox - 3, oy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (e.carryKind === 2) {
      ctx.fillStyle = '#5fdc6a';
      ctx.strokeStyle = '#1f6a2a';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(ox, oy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private drawCocoon(x: number, y: number, r: number, p: number): void {
    const ctx = this.ctx;
    const pulse = 1 + Math.sin(this.time * 5) * 0.05;
    const gr = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r * pulse);
    gr.addColorStop(0, '#f2c36b');
    gr.addColorStop(0.6, '#c98a2c');
    gr.addColorStop(1, '#5a3510');
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.ellipse(x, y, r * pulse, r * 0.85 * pulse, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,110,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, r + 3, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.stroke();
  }

  // ------------------------------------------------------------------ structures

  private drawStructure(g: Game, e: Entity, team: number): void {
    const color = this.colorOf(g, e.owner);
    const art = this.sprites.art(e.def);
    const working = !!e.queue.length || (e.def.spawnsCubs && e.cubs.length < 3) || g.tick - e.lastAttackTick < 10;
    this.drawStructureSprite(e.def, color, e.x, e.y, e.built ? 1 : e.progress, 1, art, e, working);
    const ctx = this.ctx;
    if (e.isBuilding && e.built && e.def.needsPower && !e.powered) {
      ctx.fillStyle = 'rgba(0,0,10,0.45)';
      ctx.fillRect(e.x0, e.y0, e.x1 - e.x0, e.y1 - e.y0);
      ctx.fillStyle = '#ffcf4a';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡', e.x, e.y + 5);
    }
    // turret layer (towers)
    if (e.built && art.turret) {
      const t = this.sprites.get(e.def, color, 'turret', 0);
      if (t) this.blit(t.canvas, t.w, t.h, e.x, e.y, e.turret);
    }
    // burning
    if (e.isBuilding && e.built && e.def.race === 'ironpaw' && e.hp < maxHp(e, g.players[e.owner]) / 3 && Math.random() < 0.3) {
      this.fx.add({ x: e.x + (Math.random() - 0.5) * (e.x1 - e.x0) * 0.6, y: e.y + (Math.random() - 0.5) * (e.y1 - e.y0) * 0.6, vy: -20, vx: 5, life: 0.6, max: 0.6, size: 5, grow: 6, r: 255, g: 130, b: 40 });
      if (Math.random() < 0.5) this.fx.add({ x: e.x, y: e.y - 10, vy: -25, vx: 10, life: 1.4, max: 1.4, size: 6, grow: 10, r: 40, g: 38, b: 36, a: 0.5, kind: 1 });
    }
    // geyser steam
    if (e.def.kind === 'geyser' && e.amount > 0 && Math.random() < 0.08) {
      this.fx.add({ x: e.x + (Math.random() - 0.5) * 20, y: e.y + (Math.random() - 0.5) * 20, vy: -14, vx: 6, life: 2, max: 2, size: 6, grow: 8, r: 140, g: 200, b: 150, a: 0.35, kind: 1 });
    }
    void team;
  }

  private drawStructureSprite(def: EntityDef, color: number, x: number, y: number, progress: number, alpha: number, art: ArtDef | null, e?: Entity, working = false): void {
    const ctx = this.ctx;
    const s = this.sprites.get(def, color, 'body', def.kind === 'mineral' && e ? mineralStage(e) : 0);
    if (!s) return;
    if (progress >= 1) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(s.canvas, x - s.w / 2, y - s.h / 2, s.w, s.h);
      if (art?.overlay && e) {
        ctx.save();
        ctx.translate(x, y);
        art.overlay(ctx, teamPal(color < 0 ? 0 : color), { t: this.time, built: true, powered: e.powered, working, seed: e.id }, def);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      return;
    }
    // under construction
    const race = def.race;
    const W = (def.size?.[0] ?? 2) * TILE;
    const H = (def.size?.[1] ?? 2) * TILE;
    if (race === 'ironpaw') {
      ctx.globalAlpha = 0.3 * alpha;
      ctx.drawImage(s.canvas, x - s.w / 2, y - s.h / 2, s.w, s.h);
      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.beginPath();
      const ch = s.h * progress;
      ctx.rect(x - s.w / 2, y + s.h / 2 - ch, s.w, ch);
      ctx.clip();
      ctx.drawImage(s.canvas, x - s.w / 2, y - s.h / 2, s.w, s.h);
      ctx.restore();
      // scaffolding
      ctx.strokeStyle = 'rgba(255,210,90,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= W; i += 8) {
        ctx.moveTo(x - W / 2 + i, y - H / 2);
        ctx.lineTo(x - W / 2 + i, y + H / 2);
      }
      ctx.stroke();
      ctx.strokeRect(x - W / 2, y - H / 2, W, H);
    } else if (race === 'horde') {
      const sc = 0.45 + 0.55 * progress;
      ctx.globalAlpha = alpha * (0.4 + 0.6 * progress);
      ctx.drawImage(s.canvas, x - (s.w * sc) / 2, y - (s.h * sc) / 2, s.w * sc, s.h * sc);
      ctx.globalAlpha = alpha;
      this.drawCocoon(x, y, Math.min(W, H) * 0.32 * (1 - progress * 0.5), progress);
    } else {
      ctx.globalAlpha = alpha * (0.25 + 0.6 * progress);
      ctx.drawImage(s.canvas, x - s.w / 2, y - s.h / 2, s.w, s.h);
      ctx.globalAlpha = alpha * 0.6;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(glowSprite(90, 170, 255), x - W * 0.7, y - H * 0.7, W * 1.4, H * 1.4);
      const scan = y - H / 2 + ((this.time * 40) % H);
      ctx.fillStyle = 'rgba(140,210,255,0.5)';
      ctx.fillRect(x - W / 2, scan, W, 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  private drawPowerFields(g: Game, player: number): void {
    const ctx = this.ctx;
    for (const e of g.entities) {
      if (!e.alive || e.owner !== player || !e.def.powerRadius || !e.built) continue;
      const r = e.def.powerRadius * TILE;
      ctx.fillStyle = 'rgba(70,150,255,0.12)';
      ctx.strokeStyle = 'rgba(110,190,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ misc world elements

  private drawSelRing(g: Game, e: Entity, alpha: number, v: ViewState, selected: boolean): void {
    const ctx = this.ctx;
    const ix = e.px + (e.x - e.px) * alpha;
    const iy = e.py + (e.y - e.py) * alpha;
    let col = '#45ff6a';
    if (e.owner < 0) col = '#f0e070';
    else if (g.isEnemy(v.player < 0 ? 0 : v.player, e.owner) && v.player >= 0) col = '#ff4a3c';
    else if (e.owner !== v.player) col = '#f0e070';
    ctx.strokeStyle = col;
    ctx.globalAlpha = selected ? 0.95 : 0.45;
    ctx.lineWidth = Math.max(1, 1.6 / this.cam.zoom);
    ctx.beginPath();
    if (e.isBuilding || e.isResource) {
      const w = e.x1 - e.x0;
      const h = e.y1 - e.y0;
      ctx.ellipse(ix, iy + 2, w * 0.58, h * 0.58, 0, 0, Math.PI * 2);
    } else {
      const yo = e.air ? 14 : 2;
      ctx.ellipse(ix, iy + yo, e.r + 3, (e.r + 3) * 0.8, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawBars(g: Game, e: Entity, alpha: number, selected: boolean, viewer: number): void {
    const ctx = this.ctx;
    const p = g.players[e.owner];
    const mh = maxHp(e, p);
    const ms = maxShields(e);
    const me = e.def.energy ?? 0;
    const ix = e.px + (e.x - e.px) * alpha;
    const iy = e.py + (e.y - e.py) * alpha;
    const isS = e.isBuilding;
    const w = isS ? (e.x1 - e.x0) * 0.7 : Math.max(18, e.r * 2.2);
    const top = isS ? e.y0 - 6 : iy - e.r - (e.air ? 10 : 7);
    const z = this.cam.zoom;
    const bh = Math.max(2.5, 3.5 / z);
    let y = top;
    const x0 = ix - w / 2;
    const bar = (frac: number, col: string, yy: number) => {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x0 - 0.5, yy - 0.5, w + 1, bh + 1);
      ctx.fillStyle = col;
      ctx.fillRect(x0, yy, w * Math.max(0, Math.min(1, frac)), bh);
    };
    if (me && selected) {
      bar(e.energy / me, '#c56cff', y);
      y -= bh + 1;
    }
    const f = e.hp / mh;
    bar(f, f > 0.6 ? '#46e05a' : f > 0.3 ? '#f2c94c' : '#ef4b3b', y);
    y -= bh + 1;
    if (ms) bar(e.shields / ms, '#4fb7ff', y);
    if (isS && !e.built) {
      y -= bh + 1;
      bar(e.progress, '#ffffff', y);
    }
    if (e.bubble > 0) {
      ctx.fillStyle = '#9fe0ff';
      ctx.fillRect(x0, top + bh + 1, w * Math.min(1, e.bubble / 100), 1.5);
    }
    // cargo pips under the health bar (own side only: enemy cargo is hidden, as in the classics)
    if (e.cargo.length && e.def.cargo && (viewer < 0 || g.isAlly(e.owner, viewer))) {
      const used = cargoUsed(g, e);
      const n = e.def.cargo;
      const pw = Math.max(2, (w - (n - 1)) / n);
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i < used ? '#ffe08a' : 'rgba(0,0,0,0.55)';
        ctx.fillRect(x0 + i * (pw + 1), top + bh + 2, pw, Math.max(1.5, bh * 0.6));
      }
    }
  }

  private drawRallies(g: Game, v: ViewState): void {
    const ctx = this.ctx;
    for (const e of v.selection) {
      if (!e.alive || e.owner !== v.player) continue;
      if (e.isBuilding && e.rally) {
        const t = g.get(e.rally.target);
        const rx = t ? t.x : e.rally.x;
        const ry = t ? t.y : e.rally.y;
        ctx.strokeStyle = 'rgba(120,255,140,0.6)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.2 / this.cam.zoom;
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(rx, ry);
        ctx.stroke();
        ctx.setLineDash([]);
        this.drawFlag(rx, ry, '#5f5');
      } else if (e.isUnit && e.orders.length > 0) {
        let px = e.x;
        let py = e.y;
        ctx.lineWidth = 1 / this.cam.zoom;
        for (const o of e.orders.slice(0, 8)) {
          let tx: number | undefined;
          let ty: number | undefined;
          let col = 'rgba(120,255,140,0.45)';
          if ('x' in o && o.t !== 'ability') {
            tx = o.x;
            ty = o.y;
          } else if ('target' in o && o.target) {
            const t = g.get(o.target);
            if (t) {
              tx = t.x;
              ty = t.y;
            }
          } else if (o.t === 'ability') {
            tx = o.x;
            ty = o.y;
          }
          if (o.t === 'amove' || o.t === 'attack' || o.t === 'patrol') col = 'rgba(255,110,90,0.5)';
          if (o.t === 'build') {
            const d = DEFS[o.def];
            tx = (o.tx + d.size![0] / 2) * TILE;
            ty = (o.ty + d.size![1] / 2) * TILE;
            col = 'rgba(255,220,90,0.5)';
            const s = this.sprites.get(d, g.players[e.owner].color, 'body', 0);
            if (s) {
              ctx.globalAlpha = 0.35;
              ctx.drawImage(s.canvas, tx - s.w / 2, ty - s.h / 2, s.w, s.h);
              ctx.globalAlpha = 1;
            }
          }
          if (tx === undefined || ty === undefined) continue;
          if (e.orders.length > 1 || o.t === 'build') {
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(tx, ty, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
          px = tx;
          py = ty;
        }
      }
    }
  }

  private drawFlag(x: number, y: number, col: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 14);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x, y - 14);
    ctx.lineTo(x + 9, y - 11);
    ctx.lineTo(x, y - 8);
    ctx.fill();
  }

  private drawPlacement(g: Game, pl: Placement, player: number): void {
    const ctx = this.ctx;
    const d = pl.def;
    const [w, h] = d.size!;
    const color = player >= 0 ? g.players[player].color : 0;
    const s = this.sprites.get(d, color, 'body', 0);
    const x = (pl.tx + w / 2) * TILE;
    const y = (pl.ty + h / 2) * TILE;
    if (s) {
      ctx.globalAlpha = 0.55;
      ctx.drawImage(s.canvas, x - s.w / 2, y - s.h / 2, s.w, s.h);
      ctx.globalAlpha = 1;
    }
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const bad = pl.bad[j * w + i];
        ctx.fillStyle = bad ? 'rgba(255,50,40,0.38)' : 'rgba(60,255,90,0.22)';
        ctx.fillRect((pl.tx + i) * TILE + 1, (pl.ty + j) * TILE + 1, TILE - 2, TILE - 2);
      }
    }
    ctx.strokeStyle = pl.ok ? 'rgba(80,255,110,0.9)' : 'rgba(255,70,60,0.9)';
    ctx.lineWidth = 1.5 / this.cam.zoom;
    ctx.strokeRect(pl.tx * TILE, pl.ty * TILE, w * TILE, h * TILE);
    if (d.townHall) {
      // show the resource exclusion zone
      ctx.strokeStyle = 'rgba(255,220,90,0.25)';
      ctx.strokeRect((pl.tx - 3) * TILE, (pl.ty - 3) * TILE, (w + 6) * TILE, (h + 6) * TILE);
    }
  }

  private drawMarkers(markers: Marker[], dt: number): void {
    const ctx = this.ctx;
    for (const m of markers) {
      m.t -= dt;
      if (m.t <= 0) continue;
      const k = m.t / 0.5;
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = k;
      ctx.lineWidth = 2 / this.cam.zoom;
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, 4 + (1 - k) * 12, (4 + (1 - k) * 12) * 0.75, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (let i = markers.length - 1; i >= 0; i--) if (markers[i].t <= 0) markers.splice(i, 1);
  }

  private drawProjectiles(g: Game, alpha: number, air: boolean, team: number): void {
    const ctx = this.ctx;
    for (const pr of g.projectiles) {
      if (!pr.alive && pr.age === 0) continue;
      if (pr.air !== air) continue;
      const x = pr.px + (pr.x - pr.px) * alpha;
      const y = pr.py + (pr.y - pr.py) * alpha;
      if (team >= 0 && !g.vision.visibleAt(team, x, y)) continue;
      this.drawProjectile(pr, x, y);
    }
  }

  private drawProjectile(pr: Projectile, x: number, y: number): void {
    const ctx = this.ctx;
    const ang = Math.atan2(pr.ty - pr.y, pr.tx - pr.x);
    switch (pr.w.proj) {
      case 'keg':
        ctx.fillStyle = '#6b4320';
        ctx.strokeStyle = '#2a1a0c';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.ellipse(x, y, 3.6, 3, this.time * 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.drawImage(glowSprite(255, 200, 90), x - 3, y - 6, 6, 6);
        break;
      case 'honey':
        ctx.drawImage(glowSprite(255, 190, 60), x - 6, y - 6, 12, 12);
        ctx.fillStyle = '#f0b030';
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'frost':
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glowSprite(150, 220, 255), x - 7, y - 7, 14, 14);
        ctx.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.time * 16);
        ctx.fillStyle = '#e8f8ff';
        ctx.fillRect(-4, -1, 8, 2);
        ctx.restore();
        break;
      case 'sap':
        ctx.fillStyle = '#7a5418';
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.7;
        ctx.drawImage(glowSprite(255, 190, 90), x - 5, y - 5, 10, 10);
        ctx.globalAlpha = 1;
        break;
      case 'missile':
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(-4, -1.2, 7, 2.4);
        ctx.restore();
        ctx.drawImage(glowSprite(255, 170, 70), x - Math.cos(ang) * 5 - 4, y - Math.sin(ang) * 5 - 4, 8, 8);
        if (Math.random() < 0.6) this.fx.add({ x: x - Math.cos(ang) * 5, y: y - Math.sin(ang) * 5, life: 0.5, max: 0.5, size: 2.5, grow: 5, r: 200, g: 200, b: 200, a: 0.4, kind: 1, air: pr.air });
        break;
      case 'quill':
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.fillStyle = '#d8ec8a';
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(-4, -1.3);
        ctx.lineTo(-4, 1.3);
        ctx.fill();
        ctx.restore();
        break;
      case 'glaive':
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.time * 20);
        ctx.fillStyle = '#c58bff';
        ctx.beginPath();
        ctx.moveTo(5, 0);
        ctx.lineTo(0, 1.5);
        ctx.lineTo(-5, 0);
        ctx.lineTo(0, -1.5);
        ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 0.6;
        ctx.drawImage(glowSprite(190, 110, 255), x - 6, y - 6, 12, 12);
        ctx.globalAlpha = 1;
        break;
      case 'sting':
        ctx.drawImage(glowSprite(150, 255, 90), x - 6, y - 6, 12, 12);
        ctx.fillStyle = '#b8ff7a';
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'moonorb':
      case 'lantern':
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glowSprite(90, 170, 255), x - 8, y - 8, 16, 16);
        ctx.drawImage(glowSprite(220, 240, 255), x - 3, y - 3, 6, 6);
        ctx.globalCompositeOperation = 'source-over';
        break;
      case 'starbolt':
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glowSprite(255, 200, 90), x - 13, y - 13, 26, 26);
        ctx.drawImage(glowSprite(255, 250, 220), x - 5, y - 5, 10, 10);
        ctx.globalCompositeOperation = 'source-over';
        break;
      default:
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }

  private drawArea(fx: AreaEffect, team: number, g: Game): void {
    const ctx = this.ctx;
    const t = fx.t / fx.total;
    const time = this.time;
    switch (fx.kind) {
      case 'sniff':
        if (fx.team !== team && team >= 0) return;
        ctx.strokeStyle = `rgba(110,200,255,${0.5 * Math.min(1, t * 4)})`;
        ctx.lineWidth = 2 / this.cam.zoom;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(110,200,255,0.05)';
        ctx.fill();
        ctx.save();
        ctx.translate(fx.x, fx.y);
        ctx.rotate(time * 2);
        const gr = ctx.createLinearGradient(0, 0, fx.r, 0);
        gr.addColorStop(0, 'rgba(110,200,255,0.0)');
        gr.addColorStop(1, 'rgba(110,200,255,0.25)');
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, fx.r, 0, 0.5);
        ctx.fill();
        ctx.restore();
        return;
      case 'beecloud': {
        if (team >= 0 && !g.vision.visibleAt(team, fx.x, fx.y)) return;
        const a = Math.min(1, t * 5, (1 - t) * 10);
        for (let i = 0; i < 9; i++) {
          const ang = i * 0.7 + time * 0.3;
          const rr = fx.r * (0.3 + ((i * 37) % 7) / 10);
          const x = fx.x + Math.cos(ang) * rr * 0.6;
          const y = fx.y + Math.sin(ang) * rr * 0.6;
          ctx.globalAlpha = 0.35 * a;
          ctx.drawImage(glowSprite(110, 120, 90), x - rr, y - rr, rr * 2, rr * 2);
        }
        ctx.globalAlpha = 1;
        return;
      }
      case 'stingswarm': {
        if (team >= 0 && !g.vision.visibleAt(team, fx.x, fx.y)) return;
        ctx.globalAlpha = 0.45 * Math.min(1, t * 6);
        ctx.drawImage(glowSprite(150, 60, 170), fx.x - fx.r, fx.y - fx.r, fx.r * 2, fx.r * 2);
        ctx.globalAlpha = 1;
        if (Math.random() < 0.5) this.fx.add({ x: fx.x + (Math.random() - 0.5) * fx.r * 1.5, y: fx.y + (Math.random() - 0.5) * fx.r * 1.5, vy: -10, life: 0.6, max: 0.6, size: 3, r: 190, g: 90, b: 210 });
        return;
      }
      case 'starfall': {
        if (team >= 0 && !g.vision.visibleAt(team, fx.x, fx.y)) return;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5;
        ctx.drawImage(glowSprite(120, 110, 255), fx.x - fx.r * 1.2, fx.y - fx.r * 1.2, fx.r * 2.4, fx.r * 2.4);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(200,220,255,0.85)';
        ctx.lineWidth = 1.2;
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          let x = fx.x + (Math.random() - 0.5) * fx.r * 1.6;
          let y = fx.y + (Math.random() - 0.5) * fx.r * 1.6;
          ctx.moveTo(x, y);
          for (let s = 0; s < 4; s++) {
            x += (Math.random() - 0.5) * 14;
            y += (Math.random() - 0.5) * 14;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
      case 'staticburst':
        ctx.strokeStyle = `rgba(140,200,255,${t})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.r * (1.2 - t * 0.5), 0, Math.PI * 2);
        ctx.stroke();
        return;
      case 'pollen': {
        if (team >= 0 && !g.vision.visibleAt(team, fx.x, fx.y)) return;
        const a = Math.min(1, t * 5, (1 - t) * 10);
        ctx.globalAlpha = 0.4 * a;
        ctx.drawImage(glowSprite(255, 225, 90), fx.x - fx.r * 1.2, fx.y - fx.r * 1.2, fx.r * 2.4, fx.r * 2.4);
        ctx.fillStyle = 'rgba(255,240,150,0.8)';
        for (let i = 0; i < 18; i++) {
          const ang = i * 2.4 + time * (0.4 + (i % 3) * 0.2);
          const rr = fx.r * (0.2 + ((i * 53) % 10) / 12);
          ctx.fillRect(fx.x + Math.cos(ang) * rr, fx.y + Math.sin(ang) * rr, 1.6, 1.6);
        }
        ctx.globalAlpha = 1;
        return;
      }
      case 'hornets': {
        if (team >= 0 && !g.vision.visibleAt(team, fx.x, fx.y)) return;
        for (let i = 0; i < 10; i++) {
          const ang = i * 0.63 + time * (3 + (i % 4));
          const rr = 6 + ((i * 37) % 9) + Math.sin(time * 5 + i) * 3;
          const x = fx.x + Math.cos(ang) * rr;
          const y = fx.y + Math.sin(ang) * rr * 0.8 - 10;
          ctx.fillStyle = i % 2 ? '#2a1d0a' : '#f2c230';
          ctx.fillRect(x - 1.2, y - 1, 2.4, 2);
        }
        ctx.strokeStyle = 'rgba(255,200,60,0.25)';
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.r, 0, Math.PI * 2);
        ctx.stroke();
        return;
      }
      case 'honeyglob': {
        if (team >= 0 && !g.vision.visibleAt(team, fx.x, fx.y)) return;
        ctx.strokeStyle = `rgba(255,190,60,${0.4 + 0.4 * (1 - t)})`;
        ctx.lineWidth = 1.5 / this.cam.zoom;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.r, 0, Math.PI * 2);
        ctx.stroke();
        const h = t * 160;
        ctx.drawImage(glowSprite(255, 190, 60), fx.x - 7, fx.y - h - 7, 14, 14);
        return;
      }
      case 'spirit': {
        const src = g.get(fx.src);
        if (!src || (team >= 0 && fx.team !== team && !g.vision.visibleAt(team, fx.x, fx.y))) return;
        const s = this.sprites.get(src.def, this.colorOf(g, src.owner), 'body', Math.floor(time * 8) % 4);
        ctx.globalAlpha = 0.45;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glowSprite(140, 210, 255), fx.x - 14, fx.y - 14, 28, 28);
        ctx.globalCompositeOperation = 'source-over';
        if (s) ctx.drawImage(s.canvas, fx.x - s.w / 2, fx.y - s.h / 2, s.w, s.h);
        ctx.globalAlpha = 1;
        return;
      }
      case 'snowball': {
        if (team >= 0 && !g.vision.visibleAt(team, fx.x, fx.y)) return;
        const r = 7 + (1 - t) * 3;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glowSprite(150, 220, 255), fx.x - r * 2.2, fx.y - r * 2.2, r * 4.4, r * 4.4);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#eef9ff';
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(120,200,255,0.5)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, fx.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      case 'grandshot': {
        const src = g.get(fx.src);
        const tgt = g.get(fx.target);
        if (!src || !tgt) return;
        ctx.globalCompositeOperation = 'lighter';
        const s = 6 + (1 - t) * 14;
        ctx.drawImage(glowSprite(120, 180, 255), src.x - s, src.y - s, s * 2, s * 2);
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
    }
  }

  private drawFog(g: Game, team: number): void {
    const v = g.vision;
    if (this.fogVer !== v.version || this.fogTeam !== team) {
      this.fogVer = v.version;
      this.fogTeam = team;
      const fctx = this.fogCanvas.getContext('2d')!;
      const img = fctx.createImageData(v.w, v.h);
      const vis = v.vis[team];
      const exp = v.explored[team];
      for (let i = 0; i < vis.length; i++) {
        const o = i * 4;
        img.data[o] = 0;
        img.data[o + 1] = 0;
        img.data[o + 2] = 0;
        img.data[o + 3] = vis[i] ? 0 : exp[i] ? 125 : 235;
      }
      fctx.putImageData(img, 0, 0);
    }
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fogCanvas, 0, 0, v.w * TILE, v.h * TILE);
  }

  /** Team colour as CSS string. */
  static colorCss(color: number): string {
    return (TEAM_COLORS[color] ?? TEAM_COLORS[0]).main;
  }
}

function mineralStage(e: Entity): number {
  return e.amount > 1000 ? 0 : e.amount > 500 ? 1 : 2;
}
