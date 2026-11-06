import { CELLS_PER_TILE, TILE } from '../game/constants.ts';
import { ABILITY_DEFS, DEFS, RACES, family } from '../game/data/index.ts';
import type { EntityDef } from '../game/data/types.ts';
import type { Entity } from '../game/entity.ts';
import type { Game } from '../game/game.ts';
import type { Command } from '../game/types.ts';
import { canPlace } from '../game/systems/placement.ts';
import type { Session } from '../net/session.ts';
import type { Renderer, ViewState } from '../render/renderer.ts';
import type { Action, Page, TargetMode } from './commandcard.ts';
import { Selection } from './selection.ts';

export interface Feedback {
  ack(kind: 'move' | 'attack' | 'select' | 'build' | 'error' | 'click', e?: Entity): void;
  message(text: string, kind?: 'error' | 'info'): void;
}

export class Controller {
  g: Game;
  session: Session;
  r: Renderer;
  sel = new Selection();
  view: ViewState;
  fb: Feedback;
  page: Page = 'main';
  targeting: TargetMode | null = null;
  placing: EntityDef | null = null;
  placeTx = 0;
  placeTy = 0;
  /** mobile: placement ghost waits for explicit confirmation */
  placeConfirm = false;
  lastAlert: { x: number; y: number } | null = null;
  private idleCursor = 0;
  private baseCursor = 0;
  version = 0;

  constructor(g: Game, session: Session, r: Renderer, fb: Feedback) {
    this.g = g;
    this.session = session;
    this.r = r;
    this.fb = fb;
    const p = g.players[session.localPlayer];
    this.view = {
      player: session.localPlayer,
      team: p ? p.team : -1,
      selection: [],
      hover: null,
      placement: null,
      showPower: false,
      dragBox: null,
      markers: [],
      showAllBars: false,
      rangeRing: null,
    };
  }

  get player(): number {
    return this.session.localPlayer;
  }

  issue(cmd: Command): void {
    if (this.player < 0) return;
    this.session.issue(cmd);
  }

  bump(): void {
    this.version++;
  }

  // ------------------------------------------------------------------ selection

  selected(): Entity[] {
    return this.sel.entities(this.g);
  }
  ownSelected(): Entity[] {
    return this.selected().filter((e) => e.owner === this.player);
  }

  select(es: Entity[], add = false): void {
    if (add) this.sel.add(this.g, es);
    else this.sel.set(this.g, es);
    this.page = 'main';
    this.cancelModes();
    if (es.length) this.fb.ack('select', es[0]);
    this.bump();
  }

  clickSelect(wx: number, wy: number, shift: boolean, sameType: boolean, slack: number): void {
    const e = this.pickVisible(wx, wy, slack);
    if (!e) {
      if (!shift) {
        this.sel.clear();
        this.page = 'main';
        this.bump();
      }
      return;
    }
    if (sameType && e.owner === this.player) {
      this.select(this.onScreenOfType(e.def.id), shift);
      return;
    }
    if (shift && e.owner === this.player && this.selected().every((s) => s.owner === this.player)) {
      if (this.sel.has(e.id)) {
        this.sel.remove(this.g, [e]);
        this.bump();
      } else this.select([e], true);
      return;
    }
    this.select([e]);
  }

  /** Box in world coords. */
  boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean): void {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const units: Entity[] = [];
    const blds: Entity[] = [];
    for (const e of this.g.entities) {
      if (!e.alive || e.owner !== this.player || e.inside || e.def.kind === 'cub') continue;
      const pad = e.isBuilding ? 0 : e.r * 0.6;
      if (e.x + pad < minX || e.x - pad > maxX || e.y + pad < minY || e.y - pad > maxY) continue;
      if (e.isBuilding) blds.push(e);
      else if (e.def.kind !== 'cocoon') units.push(e);
    }
    const pick = units.length ? units : blds;
    if (!pick.length) {
      if (!shift) this.clickSelect((x0 + x1) / 2, (y0 + y1) / 2, false, false, 12);
      return;
    }
    this.select(pick, shift);
  }

  onScreenOfType(defId: string): Entity[] {
    const cam = this.r.cam;
    const fam = family(DEFS[defId]);
    return this.g.entities.filter(
      (e) => e.alive && e.owner === this.player && family(e.def) === fam && !e.inside &&
        e.x >= cam.x && e.x <= cam.x + cam.viewW && e.y >= cam.y && e.y <= cam.y + cam.viewH,
    );
  }

  pickVisible(wx: number, wy: number, slack: number): Entity | undefined {
    const g = this.g;
    const team = this.view.team;
    let best: Entity | undefined;
    let bestD = Infinity;
    for (const e of g.unitsNear(wx, wy, slack + 26, [])) {
      if (e.def.hidden || !this.r.visibility(g, e, team) || this.r.visibility(g, e, team) === 2) continue;
      const d = Math.hypot(e.x - wx, e.y - wy + (e.air ? 8 : 0)) - e.r;
      // prefer own units when tapping in a crowd
      const bias = e.owner === this.player ? -2 : 0;
      if (d <= slack && d + bias < bestD) {
        bestD = d + bias;
        best = e;
      }
    }
    if (best) return best;
    for (const e of g.structuresNear(wx, wy, slack * 0.5, [])) {
      if (this.r.visibility(g, e, team)) return e;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ commands

  /** Right-click / tap with a selection. */
  smart(wx: number, wy: number, target: Entity | undefined, queue: boolean): void {
    const own = this.ownSelected();
    if (!own.length) return;
    const ids = own.map((e) => e.id);
    this.issue({ c: 'smart', ids, x: wx, y: wy, t: target?.id, q: queue || undefined });
    const enemy = target && this.g.isEnemy(this.player, target.owner);
    this.view.markers.push({ x: target ? target.x : wx, y: target ? target.y : wy, t: 0.5, color: enemy ? '#ff5040' : '#50ff70' });
    if (own.some((e) => e.isUnit)) this.fb.ack(enemy ? 'attack' : 'move', own[0]);
  }

  startTargeting(mode: TargetMode): void {
    this.targeting = mode;
    this.placing = null;
    this.view.placement = null;
    if (mode.t === 'ability') {
      const ab = ABILITY_DEFS[mode.ab];
      const caster = this.sel.activeEntities(this.g)[0];
      this.view.rangeRing = caster && ab.range ? { x: caster.x, y: caster.y, r: ab.range * TILE } : null;
    }
    this.bump();
  }

  /** Execute the pending targeted command at a world point. */
  targetAt(wx: number, wy: number, target: Entity | undefined, queue: boolean): void {
    const mode = this.targeting;
    if (!mode) return;
    const own = this.ownSelected();
    const ids = own.map((e) => e.id);
    const act = this.sel.activeEntities(this.g).filter((e) => e.owner === this.player).map((e) => e.id);
    let color = '#50ff70';
    switch (mode.t) {
      case 'move':
        if (target && target !== own[0]) this.issue({ c: 'smart', ids, x: wx, y: wy, t: target.isUnit && !this.g.isEnemy(this.player, target.owner) ? target.id : undefined, q: queue || undefined });
        else this.issue({ c: 'move', ids, x: wx, y: wy, q: queue || undefined });
        this.fb.ack('move', own[0]);
        break;
      case 'amove':
        color = '#ff5040';
        if (target && this.g.isEnemy(this.player, target.owner)) this.issue({ c: 'attack', ids, t: target.id, q: queue || undefined });
        else this.issue({ c: 'amove', ids, x: wx, y: wy, q: queue || undefined });
        this.fb.ack('attack', own[0]);
        break;
      case 'patrol':
        this.issue({ c: 'patrol', ids, x: wx, y: wy, q: queue || undefined });
        this.fb.ack('move', own[0]);
        break;
      case 'gather':
        if (target) this.issue({ c: 'gather', ids, t: target.id, q: queue || undefined });
        break;
      case 'repair':
        if (target) this.issue({ c: 'repair', ids, t: target.id, q: queue || undefined });
        break;
      case 'rally':
        this.issue({ c: 'rally', ids: act, x: wx, y: wy, t: target?.id });
        break;
      case 'load':
        if (target) this.issue({ c: 'load', ids: act, t: target.id, q: queue || undefined });
        this.fb.ack('move', own[0]);
        break;
      case 'unload':
        this.issue({ c: 'unload', ids: act, x: wx, y: wy, q: queue || undefined });
        this.fb.ack('move', own[0]);
        break;
      case 'ability': {
        const ab = ABILITY_DEFS[mode.ab];
        color = '#9ad0ff';
        this.issue({ c: 'ability', ids: act, a: mode.ab, x: wx, y: wy, t: target?.id, q: queue || undefined });
        void ab;
        break;
      }
    }
    this.view.markers.push({ x: target ? target.x : wx, y: target ? target.y : wy, t: 0.5, color });
    if (!queue) this.cancelModes();
    this.bump();
  }

  doAction(a: Action): void {
    switch (a.kind) {
      case 'cmd':
        this.issue(a.cmd);
        if (a.cmd.c === 'train' || a.cmd.c === 'research' || a.cmd.c === 'morph') this.fb.ack('click');
        if (a.cmd.c === 'stop' || a.cmd.c === 'hold') this.fb.ack('move', this.ownSelected()[0]);
        break;
      case 'target':
        this.startTargeting(a.mode);
        break;
      case 'page':
        this.page = a.page;
        this.cancelModes();
        break;
      case 'place':
        this.startPlacement(DEFS[a.def]);
        break;
    }
    this.fb.ack('click');
    this.bump();
  }

  cancelModes(): void {
    this.targeting = null;
    this.placing = null;
    this.placeConfirm = false;
    this.view.placement = null;
    this.view.rangeRing = null;
    this.view.showPower = false;
  }

  /** Escape: leave the innermost mode. */
  escape(): void {
    if (this.targeting || this.placing) this.cancelModes();
    else if (this.page !== 'main') this.page = 'main';
    else {
      // cancel last queued item of a selected structure
      const b = this.sel.activeEntities(this.g).find((e) => e.owner === this.player && (e.queue.length || !e.built || e.morphTo));
      if (b) {
        if (!b.built || b.morphTo) this.issue({ c: 'cancel', id: b.id, slot: -1 });
        else this.issue({ c: 'cancel', id: b.id, slot: b.queue.length - 1 });
      }
    }
    this.bump();
  }

  // ------------------------------------------------------------------ placement

  startPlacement(def: EntityDef): void {
    this.placing = def;
    this.targeting = null;
    this.view.showPower = def.race === 'starborn';
    const cam = this.r.cam;
    this.updatePlacement(cam.centerX, cam.centerY);
    this.bump();
  }

  updatePlacement(wx: number, wy: number): void {
    const def = this.placing;
    if (!def) return;
    const [w, h] = def.size!;
    let tx = Math.round(wx / TILE - w / 2);
    let ty = Math.round(wy / TILE - h / 2);
    if (def.refinery) {
      // snap to the nearest geyser
      let best: Entity | undefined;
      let bd = 6 * TILE;
      for (const e of this.g.structuresNear(wx, wy, 6 * TILE, [])) {
        if (e.def.kind !== 'geyser') continue;
        const d = Math.hypot(e.x - wx, e.y - wy);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      if (best) {
        tx = best.tx;
        ty = best.ty;
      }
    }
    this.placeTx = tx;
    this.placeTy = ty;
    this.view.placement = { def, tx, ty, ...this.placementMask(def, tx, ty) };
  }

  placementMask(def: EntityDef, tx: number, ty: number): { ok: boolean; bad: boolean[] } {
    const g = this.g;
    const [w, h] = def.size!;
    const builder = this.ownSelected().find((e) => e.def.worker);
    const err = canPlace(g, this.player, def.id, tx, ty, builder?.id ?? 0);
    const bad: boolean[] = [];
    const team = this.view.team;
    let anyBad = false;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = tx + i;
        const y = ty + j;
        let b = false;
        if (!def.refinery) {
          if (!g.map.buildable(x, y)) b = true;
          else {
            const ci = y * CELLS_PER_TILE * g.grid.cw + x * CELLS_PER_TILE;
            if (g.grid.occ[ci]) b = true;
            if (team >= 0 && !g.vision.explored[team][y * g.map.w + x]) b = true;
            const comb = g.comb.has(x, y);
            if (def.needsComb && !comb) b = true;
            if (def.race !== 'horde' && comb) b = true;
          }
        }
        bad.push(b);
        anyBad ||= b;
      }
    }
    if (err && !anyBad) bad.fill(true);
    return { ok: !err, bad };
  }

  /** Place the current ghost. Returns true if a build order was issued. */
  confirmPlacement(queue: boolean): boolean {
    const def = this.placing;
    if (!def) return false;
    const workers = this.ownSelected().filter((e) => e.def.worker);
    const { ok } = this.placementMask(def, this.placeTx, this.placeTy);
    if (!ok) {
      const err = canPlace(this.g, this.player, def.id, this.placeTx, this.placeTy, workers[0]?.id ?? 0);
      this.fb.message(err ?? "Can't build there", 'error');
      this.fb.ack('error');
      return false;
    }
    const p = this.g.players[this.player];
    if (p.minerals < def.cost.m) {
      this.fb.message('Not enough minerals', 'error');
      this.fb.ack('error');
      return false;
    }
    if (p.gas < def.cost.g) {
      this.fb.message('Not enough gas', 'error');
      this.fb.ack('error');
      return false;
    }
    this.issue({ c: 'build', ids: workers.map((e) => e.id), d: def.id, tx: this.placeTx, ty: this.placeTy, q: queue || undefined });
    this.fb.ack('build', workers[0]);
    if (!queue) {
      this.cancelModes();
      this.page = 'main';
    }
    this.bump();
    return true;
  }

  // ------------------------------------------------------------------ groups & shortcuts

  groupSelect(i: number): boolean {
    const es = this.sel.loadGroup(i, this.g);
    if (!es.length) return false;
    this.select(es);
    return true;
  }
  groupSet(i: number): void {
    this.sel.saveGroup(i, this.g);
    this.fb.message(`Control group ${i} set`, 'info');
    this.bump();
  }
  groupAdd(i: number): void {
    this.sel.addToGroup(i, this.g);
    this.bump();
  }

  centerOnSelection(): void {
    const es = this.selected();
    if (!es.length) return;
    let x = 0;
    let y = 0;
    for (const e of es) {
      x += e.x;
      y += e.y;
    }
    this.r.cam.centerOn(x / es.length, y / es.length);
  }

  selectArmy(): void {
    const army = this.g.entities.filter(
      (e) => e.alive && e.owner === this.player && e.isUnit && e.def.kind === 'unit' && !e.def.worker && e.def.id !== 'bumblebear' && !e.inside,
    );
    if (army.length) this.select(army);
    else this.fb.message('No army units', 'info');
  }

  selectIdleWorker(all = false): void {
    const idle = this.g.entities.filter((e) => e.alive && e.owner === this.player && e.def.worker && e.orders.length === 0 && !e.inside);
    if (!idle.length) {
      this.fb.message('No idle workers', 'info');
      return;
    }
    if (all) {
      this.select(idle);
      return;
    }
    const e = idle[this.idleCursor++ % idle.length];
    this.select([e]);
    this.r.cam.centerOn(e.x, e.y);
  }

  cycleBase(): void {
    const halls = this.g.entities.filter((e) => e.alive && e.owner === this.player && e.def.townHall);
    if (!halls.length) return;
    const e = halls[this.baseCursor++ % halls.length];
    this.select([e]);
    this.r.cam.centerOn(e.x, e.y);
  }

  jumpToAlert(): void {
    if (this.lastAlert) this.r.cam.centerOn(this.lastAlert.x, this.lastAlert.y);
  }

  /** Is the current selection something we can command? */
  hasOwnSelection(): boolean {
    return this.ownSelected().length > 0;
  }

  raceDef() {
    const p = this.g.players[this.player];
    return p ? RACES[p.race] : null;
  }
}
