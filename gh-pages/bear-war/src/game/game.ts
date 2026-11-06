// The deterministic game simulation. Advance it with step(); feed it the same commands
// on every client and every client stays in sync.

import {
  CELL, CUB_MAX, MAX_SUPPLY, STARTING_WORKERS, TICK_RATE, TILE, VISION_INTERVAL, COMB_INTERVAL,
} from './constants.ts';
import { DEFS, MAX_STRUCT_REACH, MAX_UNIT_RADIUS, RACES, satisfies, validateData } from './data/index.ts';
import type { Cost, EntityDef } from './data/types.ts';
import { Entity } from './entity.ts';
import { PathGrid, clearanceFor } from './grid.ts';
import type { GameMap } from './map/gamemap.ts';
import { Player, type PlayerSetup } from './player.ts';
import { Rng } from './rng.ts';
import { SpatialHash } from './spatial.ts';
import { dist, hash32 } from './math.ts';
import type { AreaEffect, GameEvent, Projectile, TickCommand } from './types.ts';
import { maxHp, maxShields } from './stats.ts';
import { Vision } from './systems/vision.ts';
import { Comb } from './systems/comb.ts';
import { updateStructures, completeBuilding } from './systems/structures.ts';
import { updateUnits } from './systems/units.ts';
import { moveUnits } from './systems/movement.ts';
import { updateProjectiles } from './systems/combat.ts';
import { updateEffects } from './systems/abilities.ts';
import { applyCommand } from './commands.ts';
import { releaseCargo } from './systems/cargo.ts';
import { AIController } from './ai/ai.ts';

validateData();

export interface GameInit {
  map: GameMap;
  players: PlayerSetup[];
  seed: number;
}

export class Game {
  map: GameMap;
  grid: PathGrid;
  rng: Rng;
  seed: number;
  /** the setup the game was created with (for replays) */
  setups: PlayerSetup[];
  tick = 0;
  players: Player[];
  entities: Entity[] = [];
  byId = new Map<number, Entity>();
  nextId = 1;
  nextFxId = 1;
  groupSeq = 1;
  uhash: SpatialHash;
  bhash: SpatialHash;
  bhashDirty = true;
  vision: Vision;
  comb: Comb;
  effects: AreaEffect[] = [];
  projectiles: Projectile[] = [];
  events: GameEvent[] = [];
  over = false;
  winners: number[] = [];
  powerDirty = true;
  ais: AIController[] = [];
  /** recently computed paths, shared by units heading to the same place */
  pathCache = new Map<number, { pts: number[]; sx: number; sy: number; gx: number; gy: number; tick: number; ver: number }>();
  /** A* node expansions still allowed this tick */
  pathBudget = 0;
  /** scratch array for spatial queries (not re-entrant!) */
  tmp: Entity[] = [];
  tmp2: Entity[] = [];

  constructor(init: GameInit) {
    this.map = init.map;
    this.setups = init.players.map((p) => ({ ...p }));
    this.seed = init.seed >>> 0;
    this.rng = new Rng(this.seed);
    this.grid = new PathGrid(this.map);
    const ww = this.map.w * TILE;
    const wh = this.map.h * TILE;
    this.uhash = new SpatialHash(ww, wh, 64);
    this.bhash = new SpatialHash(ww, wh, 128);
    this.players = init.players.map((s, i) => new Player(i, s));
    const teamIds = [...new Set(this.players.map((p) => p.team))].sort((a, b) => a - b);
    // normalise team ids to 0..n-1
    for (const p of this.players) p.team = teamIds.indexOf(p.team);
    this.vision = new Vision(this.map.w, this.map.h, teamIds.length);
    this.comb = new Comb(this.map.w, this.map.h);
    this.setup(init.players);
  }

  // ------------------------------------------------------------------ setup

  private setup(setups: PlayerSetup[]): void {
    for (const r of this.map.resources) {
      const def = DEFS[r.kind];
      const e = this.addEntity(def, -1, (r.tx + def.size![0] / 2) * TILE, (r.ty + def.size![1] / 2) * TILE);
      e.tx = r.tx;
      e.ty = r.ty;
      e.amount = r.amount;
      this.grid.setFootprint(e.tx, e.ty, e.tw, e.th, true);
    }
    // assign start locations
    const starts = this.map.starts;
    const free = starts.map((_, i) => i);
    const assigned: number[] = new Array(this.players.length).fill(-1);
    setups.forEach((s, i) => {
      if (s.start !== undefined && s.start >= 0 && free.includes(s.start)) {
        assigned[i] = s.start;
        free.splice(free.indexOf(s.start), 1);
      }
    });
    this.rng.shuffle(free);
    for (let i = 0; i < assigned.length; i++) if (assigned[i] < 0) assigned[i] = free.shift() ?? 0;

    for (const p of this.players) {
      const base = starts[assigned[p.index]];
      p.startBase = this.map.bases.indexOf(base);
      const race = RACES[p.race];
      const hall = this.placeBuilding(race.townHall, p.index, base.tx, base.ty, true);
      completeBuilding(this, hall, true);
      const minerals = this.entities
        .filter((e) => e.def.kind === 'mineral' && dist(e.x, e.y, hall.x, hall.y) < 12 * TILE)
        .sort((a, b) => dist(a.x, a.y, hall.x, hall.y) - dist(b.x, b.y, hall.x, hall.y) || a.id - b.id);
      for (let i = 0; i < STARTING_WORKERS; i++) {
        const m = minerals[i % Math.max(1, minerals.length)];
        const ang = (i / STARTING_WORKERS) * 6.283185307179586;
        let wx = hall.x + (m ? (m.x - hall.x) * 0.45 : 0);
        let wy = hall.y + (m ? (m.y - hall.y) * 0.45 : 0);
        wx += ((hash32(i * 7 + 1) % 17) - 8) * 1.5 + ang;
        wy += ((hash32(i * 13 + 5) % 17) - 8) * 1.5;
        const w = this.spawnUnit(race.worker, p.index, wx, wy);
        if (m) w.orders.push({ t: 'gather', target: m.id });
      }
      if (p.race === 'horde') {
        this.spawnUnit('bumblebear', p.index, hall.x + (hall.x < this.map.w * TILE / 2 ? 3 : -3) * TILE, hall.y);
        for (let i = 0; i < CUB_MAX; i++) spawnCubFor(this, hall);
      }
    }
    this.comb.recomputeTarget(this);
    this.comb.fillToTarget();
    this.updateSupplyAndTech();
    this.updatePower();
    this.grid.recomputeClearance();
    this.rebuildBHash();
    this.vision.update(this);
    this.ais = this.players.filter((p) => p.ai).map((p) => new AIController(this, p.index, p.ai!));
  }

  // ------------------------------------------------------------------ entities

  addEntity(def: EntityDef, owner: number, x: number, y: number): Entity {
    const e = new Entity(this.nextId++, def, owner, x, y);
    e.spawnTick = this.tick;
    this.entities.push(e);
    this.byId.set(e.id, e);
    if (e.isBuilding || e.isResource) this.bhashDirty = true;
    return e;
  }

  get(id: number): Entity | undefined {
    if (!id) return undefined;
    const e = this.byId.get(id);
    return e && e.alive ? e : undefined;
  }

  spawnUnit(defId: string, owner: number, x: number, y: number): Entity {
    const def = DEFS[defId];
    if (!def.air) {
      const p = this.grid.nearestFreePoint(x, y, clearanceFor(def.radius ?? 8));
      if (p) {
        x = p.x;
        y = p.y;
      }
    }
    const e = this.addEntity(def, owner, x, y);
    const p = this.players[owner];
    e.hp = maxHp(e, p);
    e.lastProgressX = x;
    e.lastProgressY = y;
    if (def.lifetime) e.lifeT = Math.round(def.lifetime * TICK_RATE);
    return e;
  }

  placeBuilding(defId: string, owner: number, tx: number, ty: number, built: boolean): Entity {
    const def = DEFS[defId];
    const [w, h] = def.size!;
    const e = this.addEntity(def, owner, (tx + w / 2) * TILE, (ty + h / 2) * TILE);
    e.tx = tx;
    e.ty = ty;
    e.built = built;
    e.progress = built ? 1 : 0;
    const mh = maxHp(e, this.players[owner]);
    e.hp = built ? mh : Math.max(1, mh * 0.1);
    e.shields = built ? maxShields(e) : maxShields(e) * 0.1;
    if (def.refinery) {
      const gey = this.entities.find((g) => g.alive && g.def.kind === 'geyser' && g.tx === tx && g.ty === ty);
      if (gey) {
        gey.link = e.id;
        e.link = gey.id;
      }
    } else {
      this.grid.setFootprint(tx, ty, w, h, true);
    }
    this.bhashDirty = true;
    this.powerDirty = true;
    return e;
  }

  /** Remove without death effects (forager growing, cub morph, etc.). */
  removeSilently(e: Entity): void {
    if (!e.alive) return;
    e.alive = false;
    if (e.cargo.length) releaseCargo(this, e, undefined, false);
    this.onRemoved(e);
  }

  kill(e: Entity, killer?: Entity): void {
    if (!e.alive) return;
    e.alive = false;
    e.hp = 0;
    const owner = this.players[e.owner];
    if (owner) {
      if (e.isBuilding) owner.stats.buildingsLost++;
      else if (e.def.kind === 'unit') owner.stats.unitsLost++;
    }
    if (killer) {
      killer.kills++;
      const kp = this.players[killer.owner];
      if (kp && this.isEnemy(killer.owner, e.owner)) {
        if (e.isBuilding) kp.stats.buildingsKilled++;
        else if (e.def.kind === 'unit') kp.stats.unitsKilled++;
      }
    }
    this.events.push({
      k: 'death', id: e.id, def: e.def.id, owner: e.owner, x: e.x, y: e.y, air: e.air, building: e.isBuilding, r: e.r,
    });
    // bunkers let their units out; transports take theirs down with them
    if (e.cargo.length) releaseCargo(this, e, killer, true);
    this.onRemoved(e);
  }

  private onRemoved(e: Entity): void {
    // research in progress here is lost and can be started again elsewhere
    const p = this.players[e.owner];
    if (p) for (const q of e.queue) if (q.kind === 'research') p.researching[q.id] = Math.max(0, (p.researching[q.id] ?? 1) - 1);
    if (e.carrier) {
      const c = this.byId.get(e.carrier);
      const i = c ? c.cargo.indexOf(e.id) : -1;
      if (i >= 0) c!.cargo.splice(i, 1);
    }
    if (e.isBuilding || e.isResource) {
      if (e.isResource || !e.def.refinery) this.grid.setFootprint(e.tx, e.ty, e.tw, e.th, false);
      this.bhashDirty = true;
      this.powerDirty = true;
      if (e.def.refinery) {
        const gey = this.get(e.link);
        if (gey) gey.link = 0;
        if (e.occupiedBy) {
          const w = this.get(e.occupiedBy);
          if (w) w.inside = false;
        }
      }
      if (e.def.combRadius) this.comb.dirty = true;
      if (e.def.spawnsCubs) for (const lid of e.cubs) {
        const l = this.get(lid);
        if (l && l.def.kind === 'cub') this.kill(l);
      }
      if (e.def.kind === 'geyser' && e.link) {
        const ref = this.get(e.link);
        if (ref) ref.link = 0;
      }
    }
    if (e.def.kind === 'cub' || e.def.kind === 'cocoon') {
      const n = this.get(e.hive);
      if (n) {
        const i = n.cubs.indexOf(e.id);
        if (i >= 0) n.cubs.splice(i, 1);
      }
    }
    // release mineral occupancy
    if (e.res) {
      const r = this.byId.get(e.res);
      if (r && r.occupiedBy === e.id) r.occupiedBy = 0;
    }
    if (e.inside) {
      const r = this.byId.get(e.res);
      if (r && r.occupiedBy === e.id) r.occupiedBy = 0;
    }
  }

  rebuildBHash(): void {
    this.bhash.clear();
    for (const e of this.entities) if (e.alive && (e.isBuilding || e.isResource)) this.bhash.insert(e);
    this.bhashDirty = false;
  }

  rebuildUHash(): void {
    this.uhash.clear();
    for (const e of this.entities) if (e.alive && !e.isBuilding && !e.isResource && !e.inside) this.uhash.insert(e);
  }

  // ------------------------------------------------------------------ players

  isEnemy(a: number, b: number): boolean {
    if (a < 0 || b < 0 || a === b) return false;
    return this.players[a].team !== this.players[b].team;
  }
  isAlly(a: number, b: number): boolean {
    if (a < 0 || b < 0) return false;
    return a === b || this.players[a].team === this.players[b].team;
  }
  teamOf(owner: number): number {
    return owner < 0 ? -1 : this.players[owner].team;
  }

  canAfford(p: Player, c: Cost): boolean {
    return p.minerals >= c.m && p.gas >= c.g;
  }
  /** Returns an error message if the player can't afford it. */
  affordError(p: Player, c: Cost): string | null {
    if (p.minerals < c.m) return 'Not enough minerals';
    if (p.gas < c.g) return 'Not enough gas';
    return null;
  }
  spend(p: Player, c: Cost): void {
    p.minerals -= c.m;
    p.gas -= c.g;
    p.stats.mineralsSpent += c.m;
    p.stats.gasSpent += c.g;
  }
  refund(p: Player, c: Cost, pct = 1): void {
    p.minerals += Math.floor(c.m * pct);
    p.gas += Math.floor(c.g * pct);
    p.stats.mineralsSpent -= Math.floor(c.m * pct);
    p.stats.gasSpent -= Math.floor(c.g * pct);
  }
  techMet(p: Player, req: string[] | undefined): boolean {
    if (!req) return true;
    for (const r of req) if (!p.tech[r]) return false;
    return true;
  }
  missingTech(p: Player, req: string[] | undefined): string | null {
    if (!req) return null;
    for (const r of req) if (!p.tech[r]) return DEFS[r]?.name ?? r;
    return null;
  }
  error(owner: number, msg: string): void {
    this.events.push({ k: 'error', owner, msg });
  }

  // ------------------------------------------------------------------ tick

  step(cmds: TickCommand[]): void {
    this.events.length = 0;
    for (const e of this.entities) {
      e.px = e.x;
      e.py = e.y;
    }
    for (const pr of this.projectiles) {
      pr.px = pr.x;
      pr.py = pr.y;
    }
    this.updateSupplyAndTech();
    for (const tc of cmds) {
      const p = this.players[tc.p];
      if (!p || p.defeated) continue;
      p.stats.commands++;
      applyCommand(this, tc.p, tc.c);
    }
    if (!this.over) for (const ai of this.ais) ai.update();

    updateStructures(this);
    if (this.grid.dirty) this.grid.recomputeClearance();
    if (this.bhashDirty) this.rebuildBHash();
    if (this.powerDirty) this.updatePower();
    this.rebuildUHash();
    this.pathBudget = 24000;
    if (this.tick % 40 === 0) {
      for (const [k, v] of this.pathCache) if (this.tick - v.tick > 60 || v.ver !== this.grid.version) this.pathCache.delete(k);
    }
    updateUnits(this);
    moveUnits(this);
    updateProjectiles(this);
    updateEffects(this);
    this.cleanup();
    if (this.tick % VISION_INTERVAL === 0) this.vision.update(this);
    if (this.tick % COMB_INTERVAL === 0) this.comb.update(this);
    if (this.tick % 10 === 0) this.checkVictory();
    this.tick++;
  }

  private cleanup(): void {
    let w = 0;
    const ents = this.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.alive) ents[w++] = e;
      else this.byId.delete(e.id);
    }
    ents.length = w;
    let pw = 0;
    for (const pr of this.projectiles) if (pr.alive) this.projectiles[pw++] = pr;
    this.projectiles.length = pw;
  }

  updateSupplyAndTech(): void {
    for (const p of this.players) {
      p.supplyUsed = 0;
      p.supplyMax = 0;
      p.tech = {};
    }
    for (const e of this.entities) {
      if (!e.alive || e.owner < 0) continue;
      const p = this.players[e.owner];
      const d = e.def;
      if (e.isBuilding) {
        if (e.built) {
          p.supplyMax += d.provides ?? 0;
          for (const s of satisfies(d)) p.tech[s] = (p.tech[s] ?? 0) + 1;
        }
        const q = e.queue[0];
        if (q && q.started && q.kind === 'unit') {
          const ud = DEFS[q.id];
          p.supplyUsed += (ud.supply ?? 0) * (ud.count ?? 1);
        }
      } else {
        p.supplyMax += d.provides ?? 0;
        if (d.kind === 'cocoon' && e.morphTo) {
          const ud = DEFS[e.morphTo];
          p.supplyUsed += (ud.supply ?? 0) * (ud.count ?? 1);
        } else p.supplyUsed += d.supply ?? 0;
      }
    }
    for (const p of this.players) if (p.supplyMax > MAX_SUPPLY) p.supplyMax = MAX_SUPPLY;
  }

  updatePower(): void {
    const totems = this.entities.filter((e) => e.alive && e.built && e.def.powerRadius);
    for (const e of this.entities) {
      if (!e.alive || !e.def.needsPower) continue;
      let powered = false;
      for (const c of totems) {
        if (c.owner !== e.owner) continue;
        const r = c.def.powerRadius! * TILE;
        if (dist(c.x, c.y, e.x, e.y) <= r) {
          powered = true;
          break;
        }
      }
      e.powered = powered;
    }
    this.powerDirty = false;
  }

  /** Is (x,y) inside a power field of `owner`? */
  hasPower(owner: number, x: number, y: number): boolean {
    for (const c of this.entities) {
      if (!c.alive || !c.built || !c.def.powerRadius || c.owner !== owner) continue;
      if (dist(c.x, c.y, x, y) <= c.def.powerRadius * TILE) return true;
    }
    return false;
  }

  private checkVictory(): void {
    if (this.over) return;
    for (const p of this.players) {
      if (p.defeated) continue;
      let alive = false;
      let hall = false;
      for (const e of this.entities) {
        if (!e.alive || e.owner !== p.index || !e.isBuilding) continue;
        alive = true;
        if (e.def.townHall) {
          hall = true;
          break;
        }
      }
      if (!alive) {
        this.defeat(p.index);
        continue;
      }
      if (hall) {
        p.noHallSince = -1;
        p.revealed = false;
      } else if (p.noHallSince < 0) p.noHallSince = this.tick;
      else if (!p.revealed && this.tick - p.noHallSince > 30 * TICK_RATE) {
        p.revealed = true;
        this.events.push({ k: 'revealed', player: p.index });
      }
    }
    const teams = new Set(this.players.filter((p) => !p.defeated).map((p) => p.team));
    if (teams.size <= 1 && this.players.length > 1) {
      this.over = true;
      this.winners = this.players.filter((p) => !p.defeated).map((p) => p.index);
      this.events.push({ k: 'gameover', winners: this.winners });
    } else if (this.players.length === 1 && this.players[0].defeated) {
      this.over = true;
      this.events.push({ k: 'gameover', winners: [] });
    }
  }

  defeat(index: number): void {
    const p = this.players[index];
    if (p.defeated) return;
    p.defeated = true;
    for (const e of this.entities) if (e.alive && e.owner === index) this.kill(e);
    this.events.push({ k: 'defeat', player: index });
  }

  // ------------------------------------------------------------------ queries

  /** Units (incl. air) within r px of (x,y), exact by centre distance + their radius. */
  unitsNear(x: number, y: number, r: number, out: Entity[] = []): Entity[] {
    out.length = 0;
    this.uhash.query(x, y, r + MAX_UNIT_RADIUS, out);
    let w = 0;
    for (let i = 0; i < out.length; i++) {
      const e = out[i];
      if (!e.alive) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const rr = r + e.r;
      if (dx * dx + dy * dy <= rr * rr) out[w++] = e;
    }
    out.length = w;
    return out;
  }

  /** Buildings and resources whose footprint intersects the circle. */
  structuresNear(x: number, y: number, r: number, out: Entity[] = []): Entity[] {
    out.length = 0;
    this.bhash.query(x, y, r + MAX_STRUCT_REACH, out);
    let w = 0;
    for (let i = 0; i < out.length; i++) {
      const e = out[i];
      if (!e.alive) continue;
      const dx = x < e.x0 ? e.x0 - x : x > e.x1 ? x - e.x1 : 0;
      const dy = y < e.y0 ? e.y0 - y : y > e.y1 ? y - e.y1 : 0;
      if (dx * dx + dy * dy <= r * r) out[w++] = e;
    }
    out.length = w;
    return out;
  }

  /** Entity at a world point (for clicks). Prefers units over structures. */
  pick(x: number, y: number, slack = 6): Entity | undefined {
    let best: Entity | undefined;
    let bestD = 1e9;
    for (const e of this.unitsNear(x, y, slack + 24, [])) {
      if (e.def.hidden) continue;
      const d = dist(e.x, e.y, x, y) - e.r - (e.air ? 6 : 0);
      if (d <= slack && d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best) return best;
    for (const e of this.structuresNear(x, y, 1, [])) return e;
    return undefined;
  }

  nearestDepot(owner: number, x: number, y: number): Entity | undefined {
    let best: Entity | undefined;
    let bestD = 1e18;
    for (const e of this.entities) {
      if (!e.alive || e.owner !== owner || !e.def.depot || !e.built) continue;
      const d = dist(e.x, e.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** State checksum for desync detection. */
  hash(): number {
    let h = 0x811c9dc5 ^ this.tick;
    const mix = (v: number) => {
      // quantise floats so the hash only depends on the deterministic state
      const q = Math.round(v * 256) | 0;
      h = Math.imul(h ^ q, 0x01000193);
    };
    for (const e of this.entities) {
      if (!e.alive) continue;
      mix(e.id);
      mix(e.x);
      mix(e.y);
      mix(e.hp);
      mix(e.shields);
      mix(e.energy);
    }
    for (const p of this.players) {
      mix(p.minerals);
      mix(p.gas);
    }
    return h >>> 0;
  }

  get time(): number {
    return this.tick / TICK_RATE;
  }

  cellSize(): number {
    return CELL;
  }
}

/** Spawn a cub for a hive (used at setup and by the cub timer). */
export function spawnCubFor(g: Game, hive: Entity): Entity {
  const n = hive.cubs.length;
  const lx = hive.x + (((n * 37 + hive.id * 11) % 5) - 2) * 14;
  const ly = hive.y1 + 6 + ((n * 17) % 3) * 4;
  const l = g.addEntity(DEFS.cub, hive.owner, lx, ly);
  l.hive = hive.id;
  hive.cubs.push(l.id);
  return l;
}
