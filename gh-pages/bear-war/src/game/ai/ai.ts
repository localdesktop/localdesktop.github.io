// Computer opponent. Runs inside the deterministic simulation (identically on every
// client), reads the game state and issues ordinary player commands.

import { TILE } from '../constants.ts';
import { DEFS, PRODUCERS, RACES, RESEARCHED_AT, RESEARCH_DEFS } from '../data/index.ts';
import type { EntityDef } from '../data/types.ts';
import type { Entity } from '../entity.ts';
import type { Game } from '../game.ts';
import { F_RAMP, type BaseSpot } from '../map/gamemap.ts';
import { dist } from '../math.ts';
import type { AIDifficulty, Player } from '../player.ts';
import { Rng } from '../rng.ts';
import { applyCommand } from '../commands.ts';
import { canPlace } from '../systems/placement.ts';
import type { Command } from '../types.ts';
import { DIFFICULTY, PLANS, type DiffCfg, type RacePlan, type TechStep } from './plans.ts';

interface Snap {
  halls: Entity[];
  workers: Entity[];
  army: Entity[];
  structures: Entity[];
  byDef: Map<string, Entity[]>;
  cubs: number;
  pending: Map<string, number>;
  /** supply provided by unfinished supply sources */
  pendingSupply: number;
  armySupply: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => dist(a.x, a.y, b.x, b.y);
const centroid = (es: Entity[]) => ({ x: es.reduce((s, e) => s + e.x, 0) / es.length, y: es.reduce((s, e) => s + e.y, 0) / es.length });

export class AIController {
  g: Game;
  pi: number;
  difficulty: AIDifficulty;
  cfg: DiffCfg;
  plan: RacePlan;
  rng: Rng;
  step = 0;
  state: 'gather' | 'attack' | 'defend' = 'gather';
  attackStrength = 0;
  attackSupply: number;
  target: { x: number; y: number } | null = null;
  enemyMem = new Map<number, { x: number; y: number; def: string }>();
  enemyStarts: { x: number; y: number }[] = [];
  scoutId = 0;
  scoutDone = false;
  expandWorker = 0;
  private searchIdx = 0;
  /** ground distance from our main to each base location (tiles) */
  groundDist = new Map<number, number>();
  private expandTries = new Map<number, number>();
  home: { x: number; y: number };
  gather: { x: number; y: number };
  lastAmove = -1000;
  cmds = 0;
  enemyAir = 0;
  enemyLight = 0;
  enemyArmored = 0;
  /** largest enemy army (supply) seen recently */
  enemyArmy = 0;
  cloakSeen = false;
  private keepOut: Rect[] = [];
  private braceIdle = new Map<number, number>();

  constructor(g: Game, pi: number, difficulty: AIDifficulty) {
    this.g = g;
    this.pi = pi;
    this.difficulty = difficulty;
    this.cfg = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
    this.plan = PLANS[g.players[pi].race];
    this.rng = new Rng((g.seed ^ (pi * 0x9e3779b1)) >>> 0);
    this.attackSupply = this.cfg.attackSupply;
    const p = g.players[pi];
    p.incomeMult = this.cfg.income;
    const base = g.map.bases[p.startBase];
    this.home = { x: (base.tx + 2.5) * TILE, y: (base.ty + 2.5) * TILE };
    for (const q of g.players) {
      if (q.index === pi || !g.isEnemy(pi, q.index)) continue;
    }
    // every other start location might hold an enemy
    for (const s of g.map.starts) {
      const c = { x: (s.tx + 2.5) * TILE, y: (s.ty + 2.5) * TILE };
      if (near(c, this.home) > 10 * TILE) this.enemyStarts.push(c);
    }
    this.gather = this.home;
    // ground distance (in tiles) from our main to every base location, for choosing expansions
    const m = g.map;
    const dist = new Int32Array(m.w * m.h).fill(-1);
    const q: number[] = [];
    const sx = base.tx + 2;
    const sy = base.ty + 6 < m.h ? base.ty + 6 : base.ty - 2;
    for (let dy = -3; dy <= 7; dy++) {
      for (let dx = -3; dx <= 7; dx++) {
        const x = base.tx + dx;
        const y = base.ty + dy;
        if (m.walkable(x, y) && dist[y * m.w + x] < 0) {
          dist[y * m.w + x] = 0;
          q.push(y * m.w + x);
        }
      }
    }
    void sx;
    void sy;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const x = i % m.w;
      const y = (i - x) / m.w;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox;
        const ny = y + oy;
        if (!m.walkable(nx, ny)) continue;
        const j = ny * m.w + nx;
        if (dist[j] >= 0) continue;
        dist[j] = dist[i] + 1;
        q.push(j);
      }
    }
    m.bases.forEach((b, bi) => {
      const d = dist[(b.ty + 2) * m.w + b.tx + 2];
      this.groundDist.set(bi, d < 0 ? Infinity : d);
    });
  }

  get p(): Player {
    return this.g.players[this.pi];
  }

  private issue(cmd: Command): void {
    applyCommand(this.g, this.pi, cmd);
    this.cmds++;
  }

  update(): void {
    const g = this.g;
    if (this.p.defeated) return;
    if ((g.tick + this.pi * 5) % this.cfg.think !== 0) return;
    this.cmds = 0;
    const s = this.snapshot();
    this.observe(s);
    this.economy(s);
    this.supply(s);
    this.buildOrder(s);
    this.production(s);
    this.abilities(s);
    this.military(s);
    if (this.cfg.micro) this.micro(s);
    this.scout(s);
  }

  // ------------------------------------------------------------------ state

  private snapshot(): Snap {
    const g = this.g;
    const s: Snap = {
      halls: [], workers: [], army: [], structures: [], byDef: new Map(), cubs: 0, pending: new Map(), pendingSupply: 0, armySupply: 0,
    };
    for (const e of g.entities) {
      if (!e.alive || e.owner !== this.pi) continue;
      const list = s.byDef.get(e.def.id);
      if (list) list.push(e);
      else s.byDef.set(e.def.id, [e]);
      if (e.isBuilding) {
        s.structures.push(e);
        if (e.def.townHall) s.halls.push(e);
        if (!e.built && e.def.provides) s.pendingSupply += e.def.provides;
        if (e.def.spawnsCubs) s.cubs += e.cubs.length;
        continue;
      }
      if (e.def.kind === 'cocoon' && e.morphTo) {
        const d = DEFS[e.morphTo];
        s.pending.set(d.id, (s.pending.get(d.id) ?? 0) + 1);
        if (d.provides) s.pendingSupply += d.provides;
        continue;
      }
      if (e.def.kind !== 'unit') continue;
      if (e.def.worker) {
        s.workers.push(e);
        const o = e.orders[0];
        if (o && o.t === 'build') {
          s.pending.set(o.def, (s.pending.get(o.def) ?? 0) + 1);
          if (DEFS[o.def].provides) s.pendingSupply += DEFS[o.def].provides!;
        }
      } else if (e.def.id !== 'bumblebear' && e.def.id !== 'littledipper') {
        s.army.push(e);
        s.armySupply += e.def.supply ?? 0;
      }
    }
    // queued units count as pending too
    for (const b of s.structures) {
      for (const q of b.queue) if (q.kind === 'unit') s.pending.set(q.id, (s.pending.get(q.id) ?? 0) + 1);
      for (const q of b.queue) if (q.kind === 'morph') s.pending.set(q.id, (s.pending.get(q.id) ?? 0) + 1);
    }
    return s;
  }

  private count(s: Snap, id: string, includePending = true): number {
    let n = s.byDef.get(id)?.length ?? 0;
    // morphed structures count as their base (a Royal Hive is still a Hive)
    for (const [did, list] of s.byDef) if (did !== id && DEFS[did].counts?.includes(id)) n += list.length;
    if (includePending) n += s.pending.get(id) ?? 0;
    return n;
  }

  private hasTech(id: string): boolean {
    return (this.p.tech[id] ?? 0) > 0;
  }

  /** Remember enemy structures we have seen; gauge enemy composition. */
  private observe(s: Snap): void {
    const g = this.g;
    const team = this.p.team;
    let air = 0;
    let light = 0;
    let armored = 0;
    let army = 0;
    for (const e of g.entities) {
      if (!e.alive || e.owner < 0 || !g.isEnemy(this.pi, e.owner) || e.inside) continue;
      const vis = e.isBuilding
        ? g.vision.visibleAt(team, e.x, e.y) || g.vision.visibleAt(team, e.x0 + 4, e.y0 + 4) || g.vision.visibleAt(team, e.x1 - 4, e.y1 - 4)
        : g.vision.visibleAt(team, e.x, e.y);
      if (!vis) continue;
      if (e.isBuilding) this.enemyMem.set(e.id, { x: e.x, y: e.y, def: e.def.id });
      else if (e.def.kind === 'unit' && !e.def.worker) {
        army += e.def.supply ?? 1;
        if (e.air && e.def.weapons) air += e.def.supply ?? 1;
        if (e.def.attrs.includes('light')) light += e.def.supply ?? 1;
        if (e.def.attrs.includes('armored')) armored += e.def.supply ?? 1;
        if (e.def.cloaked && !g.vision.detectedAt(team, e.x, e.y)) {
          // close to our stuff? we "notice the shimmer"
          for (const o of s.structures) if (near(o, e) < 14 * TILE) this.cloakSeen = true;
          for (const o of s.army) if (near(o, e) < 9 * TILE) this.cloakSeen = true;
        }
      }
    }
    for (const [id, m] of this.enemyMem) {
      if (!g.get(id) && g.vision.visibleAt(team, m.x, m.y)) this.enemyMem.delete(id);
    }
    // blend with history so composition shifts gradually
    this.enemyAir = Math.max(air, this.enemyAir * 0.95);
    this.enemyLight = Math.max(light, this.enemyLight * 0.95);
    this.enemyArmored = Math.max(armored, this.enemyArmored * 0.95);
    this.enemyArmy = Math.max(army, this.enemyArmy * 0.985);
    // keep-out zones around our mineral lines
    this.keepOut = [];
    for (const h of s.halls) {
      let x0 = h.tx;
      let y0 = h.ty;
      let x1 = h.tx + h.tw;
      let y1 = h.ty + h.th;
      for (const r of g.structuresNear(h.x, h.y, 11 * TILE, g.tmp)) {
        if (!r.isResource) continue;
        x0 = Math.min(x0, r.tx);
        y0 = Math.min(y0, r.ty);
        x1 = Math.max(x1, r.tx + r.tw);
        y1 = Math.max(y1, r.ty + r.th);
      }
      this.keepOut.push({ x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 });
    }
  }

  // ------------------------------------------------------------------ economy

  private workerTarget(s: Snap): number {
    let t = 4;
    for (const h of s.halls) {
      if (!h.built) continue;
      let mins = 0;
      for (const r of this.g.structuresNear(h.x, h.y, 10 * TILE, this.g.tmp)) if (r.def.kind === 'mineral') mins++;
      t += mins * 2;
    }
    const refs = s.structures.filter((b) => b.def.refinery && b.built).length;
    t += refs * 3;
    return Math.min(this.cfg.maxWorkers, t);
  }

  private economy(s: Snap): void {
    const g = this.g;
    const race = RACES[this.p.race];
    // idle workers go mining
    const mineralLoad = new Map<number, number>();
    for (const w of s.workers) {
      const o = w.orders[0];
      if (o && o.t === 'gather') mineralLoad.set(o.target, (mineralLoad.get(o.target) ?? 0) + 1);
    }
    const halls = s.halls.filter((h) => h.built);
    for (const w of s.workers) {
      if (w.orders.length || w.inside || w.id === this.scoutId || w.morphTo) continue;
      const m = this.bestMineral(halls, mineralLoad, w);
      if (m) {
        this.issue({ c: 'gather', ids: [w.id], t: m.id });
        mineralLoad.set(m.id, (mineralLoad.get(m.id) ?? 0) + 1);
      }
    }
    // gas: up to 3 workers per finished refinery, fewer when gas is piling up
    const pl = this.p;
    let perGas = this.difficulty === 'easy' ? 2 : 3;
    if (pl.gas > 900 && pl.gas > pl.minerals * 2.5) perGas = 1;
    else if (pl.gas > 450 && pl.gas > pl.minerals * 1.5) perGas = 2;
    for (const r of s.structures) {
      if (!r.def.refinery || !r.built) continue;
      const gey = g.get(r.link);
      if (!gey || gey.amount <= 0) continue;
      let have = 0;
      for (const w of s.workers) {
        const o = w.orders[0];
        if ((o && o.t === 'gather' && (o.target === r.id || o.target === gey.id)) || (w.inside && w.res === r.id)) have++;
      }
      if (have > perGas) {
        const extra = s.workers.filter((w) => !w.inside && w.orders[0]?.t === 'gather' && (w.orders[0] as { target: number }).target === r.id).slice(0, have - perGas);
        for (const w of extra) {
          const m = this.bestMineral(halls, mineralLoad, w);
          if (m) this.issue({ c: 'gather', ids: [w.id], t: m.id });
        }
        continue;
      }
      if (have >= perGas) continue;
      const cands = s.workers
        .filter((w) => w.orders[0]?.t === 'gather' && !w.inside && g.get((w.orders[0] as { target: number }).target)?.def.kind === 'mineral' && w.id !== this.scoutId)
        .sort((a, b) => near(a, r) - near(b, r) || a.id - b.id);
      for (const w of cands.slice(0, perGas - have)) this.issue({ c: 'gather', ids: [w.id], t: r.id });
    }
    // worker production (the Horde uses cubs, see production)
    if (race.id !== 'horde') {
      const target = this.workerTarget(s);
      let total = s.workers.length + (s.pending.get(race.worker) ?? 0);
      // after the opening, keep some army around before droning harder
      const needArmy = this.g.time > 240 && total >= 16 && (s.armySupply < total * 0.45 || s.armySupply < this.enemyArmy * 0.8) && this.difficulty !== 'easy';
      if (needArmy && this.p.minerals < 400) total = target;
      for (const h of halls) {
        if (total >= target) break;
        if (h.queue.length >= 1) continue;
        if (this.p.minerals < 50) break;
        this.issue({ c: 'train', ids: [h.id], d: race.worker });
        total++;
      }
    }
    // ironpaw: resume abandoned construction
    if (race.id === 'ironpaw') {
      for (const b of s.structures) {
        if (b.built) continue;
        const builder = g.get(b.builder);
        if (builder && builder.orders[0]?.t === 'construct') continue;
        const w = this.pickWorker(s, b.x, b.y);
        if (w) this.issue({ c: 'repair', ids: [w.id], t: b.id });
      }
    }
  }

  private mineralsNear(h: Entity): number {
    let n = 0;
    for (const m of this.g.structuresNear(h.x, h.y, 10 * TILE, this.g.tmp)) if (m.def.kind === 'mineral') n++;
    return n;
  }

  private bestMineral(halls: Entity[], load: Map<number, number>, w: Entity): Entity | undefined {
    const g = this.g;
    let best: Entity | undefined;
    let bestScore = 1e18;
    for (const h of halls) {
      for (const m of g.structuresNear(h.x, h.y, 10 * TILE, g.tmp)) {
        if (m.def.kind !== 'mineral') continue;
        const l = load.get(m.id) ?? 0;
        if (l >= 3) continue;
        const score = l * 1000 + near(m, w) * 0.05 + near(m, h) * 0.5;
        if (score < bestScore) {
          bestScore = score;
          best = m;
        }
      }
    }
    return best;
  }

  private pickWorker(s: Snap, x: number, y: number): Entity | undefined {
    let best: Entity | undefined;
    let bd = 1e18;
    for (const w of s.workers) {
      if (w.inside || w.id === this.scoutId || w.morphTo) continue;
      const o = w.orders[0];
      if (o && o.t !== 'gather' && o.t !== 'return') continue;
      const d = dist(w.x, w.y, x, y) + (w.carry > 0 ? 64 : 0);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ supply

  private supply(s: Snap): void {
    const p = this.p;
    if (p.supplyMax >= 200) return;
    const race = RACES[p.race];
    const prod = s.halls.length + s.structures.filter((b) => b.def.produces && !b.def.townHall).length;
    const buffer = p.supplyUsed < 30 ? 1 + prod : 3 + prod * 2 + (p.supplyUsed > 80 ? 6 : 0);
    if (p.supplyMax + s.pendingSupply - p.supplyUsed >= buffer) return;
    if (race.id === 'horde') {
      if (s.cubs > 0 && p.minerals >= 100) this.trainCub(s, 'bumblebear');
      return;
    }
    if (p.minerals < DEFS[race.supplyUnit].cost.m) return;
    this.buildStructure(s, race.supplyUnit);
  }

  // ------------------------------------------------------------------ build order & macro

  private buildOrder(s: Snap): void {
    const op = this.plan.opening;
    while (this.step < op.length) {
      const st = op[this.step];
      if (this.p.supplyUsed < st.supply * this.cfg.slow && !(this.p.minerals > 500 && st.build)) break;
      const r = this.doStep(s, st, this.step);
      if (r === 'wait') break;
      this.step++;
    }
    if (this.step >= op.length || (this.step >= 4 && this.p.minerals > 450)) this.macro(s);
  }

  private doStep(s: Snap, st: TechStep, idx: number): 'done' | 'wait' {
    const p = this.p;
    if (st.expand) {
      const wanted = 1 + this.plan.opening.slice(0, idx + 1).filter((x) => x.expand).length;
      if (this.count(s, RACES[p.race].townHall, false) >= wanted || s.halls.length >= this.cfg.maxBases) return 'done';
      if (this.difficulty === 'easy' && p.supplyUsed < 36) return 'done';
      this.expand(s);
      // don't hold the whole build hostage if expanding keeps failing
      return p.supplyUsed > st.supply + 14 ? 'done' : 'wait';
    }
    if (st.build) {
      const d = DEFS[st.build];
      const wanted = this.plan.opening.slice(0, idx + 1).filter((x) => x.build === st.build).length;
      // only structures that actually exist count; pending orders just mean "keep waiting"
      if (this.count(s, st.build, false) >= wanted) return 'done';
      if (d.requires && !this.g.techMet(p, d.requires)) return this.p.supplyUsed > st.supply + 20 ? 'done' : 'wait';
      if (d.refinery && !this.freeGeyser(s) && !(s.pending.get(st.build) ?? 0)) return 'done';
      if (this.count(s, st.build) >= wanted) return 'wait';
      this.buildStructure(s, st.build);
      return 'wait';
    }
    if (st.research) {
      if (p.level(st.research) > 0 || (p.researching[st.research] ?? 0) > 0) return 'done';
      if (this.research(s, st.research)) return 'done';
      const at = RESEARCHED_AT[st.research];
      // research building lost or never built: don't stall the whole opening
      if (!this.count(s, at) && p.supplyUsed > st.supply + 10) return 'done';
      return 'wait';
    }
    if (st.morph) {
      if (this.count(s, st.morph) > 0) return 'done';
      const d = DEFS[st.morph];
      if (!this.g.techMet(p, d.requires)) return p.supplyUsed > st.supply + 24 ? 'done' : 'wait';
      if (!this.g.canAfford(p, d.cost)) return 'wait';
      const src = s.halls.find((h) => h.built && h.def.morphs?.includes(st.morph!) && !h.queue.some((q) => q.kind === 'morph'));
      if (src) this.issue({ c: 'morph', ids: [src.id], d: st.morph });
      return 'wait';
    }
    return 'done';
  }

  private macro(s: Snap): void {
    const p = this.p;
    // rebuild lost tech / ensure opening structures
    for (const st of this.plan.opening) {
      if (!st.build || DEFS[st.build].refinery) continue;
      if (this.count(s, st.build) === 0 && this.g.techMet(p, DEFS[st.build].requires) && this.g.canAfford(p, DEFS[st.build].cost)) {
        if (this.buildStructure(s, st.build)) return;
      }
    }
    // more production (and even more when money piles up)
    const bank = p.minerals > 800 ? 1 + Math.floor((p.minerals - 800) / 600) : 0;
    for (const [id, thresholds] of this.plan.production) {
      const want = Math.max(1, Math.round(thresholds.filter((t) => p.supplyUsed >= t).length * this.cfg.prodScale)) + (id === this.plan.production[0][0] ? bank : 0);
      if (this.count(s, id) < Math.min(10, want) && this.g.techMet(p, DEFS[id].requires) && p.minerals >= DEFS[id].cost.m) {
        if (this.buildStructure(s, id)) return;
      }
    }
    // replace bases that are running dry
    const active = s.halls.filter((h) => this.mineralsNear(h) >= 4).length;
    const maxBases = this.cfg.maxBases + Math.floor(this.g.time / 600);
    if (active < Math.min(maxBases, 2 + Math.floor(this.g.time / 420)) && s.halls.length < maxBases + 2 && p.minerals >= DEFS[RACES[p.race].townHall].cost.m) {
      if (this.expand(s)) return;
    }
    // horde: an extra hive for cubs when banking
    if (p.race === 'horde' && p.minerals > 700 && s.cubs < 2 && s.halls.length < this.cfg.maxBases + 2) {
      if (this.expand(s) || this.buildStructure(s, 'hive')) return;
    }
    // expand when rich
    const bases = this.count(s, RACES[p.race].townHall);
    if (bases < this.cfg.maxBases && ((p.minerals > 600 && p.supplyUsed > 50) || (p.supplyUsed > 90 && bases < 3))) {
      if (this.expand(s)) return;
    }
    // more gas when gas-starved
    if (p.gas < 150 && p.minerals > 400 && this.freeGeyser(s)) {
      const refs = s.structures.filter((b) => b.def.refinery).length;
      if (refs < s.halls.length * 2 && this.buildStructure(s, RACES[p.race].refinery)) return;
    }
    // a little static defence at the front for the stronger AIs
    if ((this.difficulty === 'hard' || this.difficulty === 'brutal') && this.g.time > 270) {
      const def = p.race === 'ironpaw' ? 'guntower' : p.race === 'horde' ? 'thornstump' : 'starlantern';
      const want = this.g.time > 600 ? 3 : 1;
      if (this.count(s, def) < want && this.g.techMet(p, DEFS[def].requires) && p.minerals > DEFS[def].cost.m + 100) {
        if (this.buildStructure(s, def, true)) return;
      }
    }
    // detection
    if (this.cloakSeen) {
      const det = this.plan.detector;
      if (this.count(s, det.building) < Math.min(3, s.halls.length + 1) && this.g.techMet(p, DEFS[det.building].requires)) {
        this.buildStructure(s, det.building, true);
      }
    }
    // upgrades
    if (p.minerals > 250 && p.gas > 150) {
      for (const r of this.plan.upgrades) if (this.research(s, r)) break;
    }
  }

  private research(s: Snap, id: string): boolean {
    const p = this.p;
    const rd = RESEARCH_DEFS[id];
    const lvl = p.level(id) + (p.researching[id] ?? 0);
    if (lvl >= rd.costs.length) return false;
    const reqs = rd.reqs?.[lvl];
    if (reqs && !this.g.techMet(p, reqs)) return false;
    const at = RESEARCHED_AT[id];
    const blds = (s.byDef.get(at) ?? []).concat(...[...s.byDef.entries()].filter(([k]) => DEFS[k].counts?.includes(at)).map(([, v]) => v));
    const b = blds.find((x) => x.built && x.queue.length === 0 && (!x.def.needsPower || x.powered));
    if (!b) return false;
    if (!this.g.canAfford(p, rd.costs[lvl])) return false;
    this.issue({ c: 'research', ids: [b.id], r: id });
    return true;
  }

  private freeGeyser(s: Snap): Entity | undefined {
    const g = this.g;
    for (const h of s.halls) {
      if (!h.built) continue;
      for (const r of g.structuresNear(h.x, h.y, 10 * TILE, g.tmp)) {
        if (r.def.kind === 'geyser' && !g.get(r.link) && r.amount > 0) {
          // not already targeted by a pending build
          if (s.workers.some((w) => w.orders[0]?.t === 'build' && (w.orders[0] as { tx: number }).tx === r.tx && (w.orders[0] as { ty: number }).ty === r.ty)) continue;
          return r;
        }
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------------ placement

  private buildStructure(s: Snap, id: string, defensive = false): boolean {
    const p = this.p;
    const d = DEFS[id];
    if (!this.g.canAfford(p, d.cost) || !this.g.techMet(p, d.requires)) return false;
    if ((s.pending.get(id) ?? 0) > 0 && !d.provides) return false;
    let spot: { tx: number; ty: number } | null = null;
    if (d.refinery) {
      const gey = this.freeGeyser(s);
      if (gey) spot = { tx: gey.tx, ty: gey.ty };
    } else spot = this.findSpot(d, s, defensive);
    if (!spot) return false;
    const w = this.pickWorker(s, (spot.tx + d.size![0] / 2) * TILE, (spot.ty + d.size![1] / 2) * TILE);
    if (!w) return false;
    this.issue({ c: 'build', ids: [w.id], d: id, tx: spot.tx, ty: spot.ty });
    s.pending.set(id, (s.pending.get(id) ?? 0) + 1);
    if (d.provides) s.pendingSupply += d.provides;
    return true;
  }

  private expand(s: Snap): boolean {
    const g = this.g;
    const p = this.p;
    const hallId = RACES[p.race].townHall;
    if ((s.pending.get(hallId) ?? 0) > 0) return true;
    const d = DEFS[hallId];
    if (!g.canAfford(p, d.cost)) return false;
    const gd = (b: BaseSpot) => this.groundDist.get(g.map.bases.indexOf(b)) ?? Infinity;
    const spots = g.map.bases
      .filter((b) => !this.baseTaken(b) && gd(b) < Infinity && (this.expandTries.get(g.map.bases.indexOf(b)) ?? 0) < 40)
      .sort((a, b) => gd(a) - gd(b));
    for (const b of spots) {
      const bi = g.map.bases.indexOf(b);
      const c = this.spotCenter(b);
      let danger = false;
      for (const m of this.enemyMem.values()) if (near(m, c) < 16 * TILE) danger = true;
      if (danger) continue;
      const explored = g.vision.explored[p.team][(b.ty + 2) * g.map.w + b.tx + 2] && g.vision.explored[p.team][b.ty * g.map.w + b.tx];
      let w = g.get(this.expandWorker);
      if (!w || !w.def.worker) {
        w = this.pickWorker(s, c.x, c.y);
        if (!w) return false;
        this.expandWorker = w.id;
      }
      if (!explored) {
        // walk there first; the build order is issued once the site has been seen
        if (w.orders[0]?.t !== 'move') {
          this.issue({ c: 'move', ids: [w.id], x: c.x, y: c.y });
          this.expandTries.set(bi, (this.expandTries.get(bi) ?? 0) + 1);
        }
        return true;
      }
      if (canPlace(g, this.pi, hallId, b.tx, b.ty, w.id) === null) {
        this.issue({ c: 'build', ids: [w.id], d: hallId, tx: b.tx, ty: b.ty });
        this.expandWorker = 0;
        return true;
      }
    }
    return false;
  }

  private spotCenter(b: BaseSpot): { x: number; y: number } {
    return { x: (b.tx + 2.5) * TILE, y: (b.ty + 2.5) * TILE };
  }

  private baseTaken(b: BaseSpot): boolean {
    const c = this.spotCenter(b);
    for (const e of this.g.structuresNear(c.x, c.y, 4 * TILE, this.g.tmp)) if (e.def.townHall) return true;
    return false;
  }

  private findSpot(d: EntityDef, s: Snap, defensive: boolean): { tx: number; ty: number } | null {
    const g = this.g;
    const [w, h] = d.size!;
    const anchors: { x: number; y: number }[] = [];
    const halls = s.halls.filter((x) => x.built);
    const main = halls.find((x) => near(x, this.home) < 4 * TILE) ?? halls[0];
    if (!main) return null;
    const away = this.awayFromMinerals(main);
    if (defensive) {
      // between our front base and the enemy
      const front = this.frontBase(s) ?? main;
      const en = this.enemyStarts[0] ?? { x: g.map.w * TILE / 2, y: g.map.h * TILE / 2 };
      const dd = near(front, en) || 1;
      anchors.push({ x: front.x + ((en.x - front.x) / dd) * 7 * TILE, y: front.y + ((en.y - front.y) / dd) * 7 * TILE });
    }
    if (d.needsPower) {
      for (const c of s.byDef.get('startotem') ?? []) if (c.built) anchors.push(c);
    }
    if (d.needsComb) {
      for (const h of halls) {
        if (h === main) continue;
        const aw = this.awayFromMinerals(h);
        anchors.push({ x: h.x + aw.x * 6 * TILE, y: h.y + aw.y * 6 * TILE });
      }
    }
    anchors.push({ x: main.x + away.x * 7 * TILE, y: main.y + away.y * 7 * TILE });
    anchors.push({ x: main.x + away.y * 7 * TILE, y: main.y - away.x * 7 * TILE });
    anchors.push({ x: main.x - away.y * 7 * TILE, y: main.y + away.x * 7 * TILE });
    for (const a of anchors) {
      const spot = this.spiral(d, a.x, a.y, w, h, d.id === 'startotem' ? s : null);
      if (spot) return spot;
    }
    return null;
  }

  private awayFromMinerals(hall: Entity): { x: number; y: number } {
    let mx = 0;
    let my = 0;
    let n = 0;
    for (const r of this.g.structuresNear(hall.x, hall.y, 10 * TILE, this.g.tmp)) {
      if (!r.isResource) continue;
      mx += r.x;
      my += r.y;
      n++;
    }
    if (!n) return { x: 0, y: 1 };
    const dx = hall.x - mx / n;
    const dy = hall.y - my / n;
    const l = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / l, y: dy / l };
  }

  private spiral(d: EntityDef, cx: number, cy: number, w: number, h: number, conduitSpread: Snap | null): { tx: number; ty: number } | null {
    const g = this.g;
    const map = g.map;
    const ctx = Math.floor(cx / TILE);
    const cty = Math.floor(cy / TILE);
    for (let r = 0; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = ctx + dx - Math.floor(w / 2);
          const ty = cty + dy - Math.floor(h / 2);
          if (tx < 2 || ty < 2 || tx + w > map.w - 2 || ty + h > map.h - 2) continue;
          if (this.inKeepOut(tx, ty, w, h)) continue;
          if (!this.gapOk(tx, ty, w, h)) continue;
          if (conduitSpread) {
            let close = false;
            for (const c of conduitSpread.byDef.get('startotem') ?? []) if (dist(c.x, c.y, (tx + 1) * TILE, (ty + 1) * TILE) < 6 * TILE) close = true;
            if (close) continue;
          }
          if (canPlace(g, this.pi, d.id, tx, ty, 0) === null) return { tx, ty };
        }
      }
    }
    return null;
  }

  private inKeepOut(tx: number, ty: number, w: number, h: number): boolean {
    for (const k of this.keepOut) if (tx < k.x1 && tx + w > k.x0 && ty < k.y1 && ty + h > k.y0) return true;
    return false;
  }

  /** Leave a one-tile corridor around structures and stay clear of ramps. */
  private gapOk(tx: number, ty: number, w: number, h: number): boolean {
    const g = this.g;
    const map = g.map;
    const cw = g.grid.cw;
    for (let y = ty - 1; y <= ty + h; y++) {
      for (let x = tx - 1; x <= tx + w; x++) {
        if (!map.inBounds(x, y)) return false;
        const inside = x >= tx && x < tx + w && y >= ty && y < ty + h;
        if (map.flags[y * map.w + x] & F_RAMP) return false;
        if (inside) continue;
        if (g.grid.occ[y * 2 * cw + x * 2]) return false;
        if (!map.walkable(x, y)) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ production

  private production(s: Snap): void {
    const p = this.p;
    if (p.race === 'horde') {
      this.hordeProduction(s);
      return;
    }
    // reserve money for the next opening structure
    const reserve = this.reserve(s);
    const queueMax = this.difficulty === 'hard' || this.difficulty === 'brutal' ? 2 : 1;
    for (const b of s.structures) {
      if (!b.built || !b.def.produces || b.def.townHall) continue;
      if (b.queue.length >= queueMax || (b.def.needsPower && !b.powered)) continue;
      if (this.cmds >= this.cfg.apm) return;
      let u = this.pickUnit(s, b.def.produces);
      if (!u) continue;
      let d = DEFS[u];
      if (p.gas - reserve.g < d.cost.g && p.minerals - reserve.m > 300) {
        // gas-starved but rich in minerals: build whatever we can afford instead
        const alt = this.pickUnit(s, b.def.produces.filter((x) => DEFS[x].cost.g <= p.gas - reserve.g));
        if (alt) {
          u = alt;
          d = DEFS[u];
        }
      }
      if (p.minerals - reserve.m < d.cost.m || p.gas - reserve.g < d.cost.g) continue;
      if (p.supplyUsed + (d.supply ?? 0) > p.supplyMax) return;
      this.issue({ c: 'train', ids: [b.id], d: u });
      s.pending.set(u, (s.pending.get(u) ?? 0) + 1);
      s.armySupply += d.supply ?? 0;
    }
  }

  private reserve(s: Snap): { m: number; g: number } {
    const st = this.plan.opening[this.step];
    if (!st || this.p.supplyUsed < st.supply * this.cfg.slow - 2) return { m: 0, g: 0 };
    if (st.build) return DEFS[st.build].cost;
    if (st.expand) return DEFS[RACES[this.p.race].townHall].cost;
    if (st.research) {
      const r = RESEARCH_DEFS[st.research];
      return r.costs[Math.min(r.costs.length - 1, this.p.level(st.research))];
    }
    if (st.morph) return DEFS[st.morph].cost;
    void s;
    return { m: 0, g: 0 };
  }

  /** Pick the unit (from `options`) most under-represented relative to the target composition. */
  private pickUnit(s: Snap, options: string[]): string | null {
    const p = this.p;
    let best: string | null = null;
    let bestDef = -1e9;
    let totalW = 0;
    const weights = new Map<string, number>();
    for (const c of this.plan.comp) {
      const d = DEFS[c.unit];
      if (!this.g.techMet(p, d.requires)) continue;
      if (!PRODUCERS[c.unit]?.some((b) => this.hasTech(b)) && !d.morphFrom) continue;
      let w = c.weight;
      // lean on gas-heavy units when gas is piling up (and vice versa)
      const gasHeavy = d.cost.g >= d.cost.m * 0.5;
      if (gasHeavy && p.gas > 500 && p.gas > p.minerals) w *= 1.8;
      if (gasHeavy && p.gas < 100 && p.minerals > 400) w *= 0.4;
      if (this.enemyAir > 4) w += c.vsAir ?? 0;
      if (this.enemyLight > 10) w += c.vsLight ?? 0;
      if (this.enemyArmored > 10) w += c.vsArmored ?? 0;
      if (w <= 0) continue;
      weights.set(c.unit, w);
      totalW += w;
    }
    const total = Math.max(1, s.armySupply);
    for (const u of options) {
      const w = weights.get(u);
      if (!w) continue;
      const c = this.plan.comp.find((x) => x.unit === u)!;
      const have = this.count(s, u);
      if (c.max !== undefined && have >= c.max) continue;
      const share = (have * (DEFS[u].supply ?? 1)) / total;
      const deficit = w / totalW - share + this.rng.next() * 0.04;
      if (deficit > bestDef) {
        bestDef = deficit;
        best = u;
      }
    }
    // detection unit when cloaked enemies were seen
    const det = this.plan.detector.unit;
    if (det && this.cloakSeen && options.includes(det) && this.count(s, det) < 2 && this.g.techMet(p, DEFS[det].requires)) return det;
    return best;
  }

  private hordeProduction(s: Snap): void {
    const p = this.p;
    if (s.cubs <= 0) {
      this.growUnits(s);
      return;
    }
    const target = this.workerTarget(s);
    const reserve = this.reserve(s);
    let cubs = s.cubs;
    let workers = s.workers.length + (s.pending.get('forager') ?? 0);
    const threatened = this.state === 'defend';
    while (cubs > 0 && this.cmds < this.cfg.apm) {
      // supply first
      if (p.supplyMax + s.pendingSupply - p.supplyUsed < 2 && p.supplyMax < 200) {
        if (p.minerals < 100) return;
        this.trainCub(s, 'bumblebear');
        cubs--;
        continue;
      }
      const wantWorker = workers < target && (!threatened || workers < 16) && (s.armySupply > workers * 0.35 || workers < 20 || this.difficulty === 'easy') && (s.armySupply >= this.enemyArmy * 0.8 || workers < 20);
      if (wantWorker) {
        if (p.minerals - reserve.m < 50) return;
        this.trainCub(s, 'forager');
        workers++;
        cubs--;
        continue;
      }
      const opts = this.plan.comp.map((c) => c.unit);
      const u = this.pickUnit(s, opts);
      if (!u) return;
      const d = DEFS[u];
      if (p.minerals - reserve.m < d.cost.m || p.gas - reserve.g < d.cost.g) {
        // can't afford the ideal unit: fall back to scrappers if minerals are plentiful
        if (p.minerals - reserve.m > 150 && this.g.techMet(p, DEFS.scrapper.requires)) {
          this.trainCub(s, 'scrapper');
          cubs--;
          continue;
        }
        return;
      }
      this.trainCub(s, u);
      s.armySupply += (d.supply ?? 0) * (d.count ?? 1);
      cubs--;
    }
    this.growUnits(s);
  }

  private trainCub(s: Snap, unit: string): void {
    const hives = s.halls.filter((h) => h.built && h.def.spawnsCubs && h.cubs.length > 0);
    if (!hives.length) return;
    this.issue({ c: 'train', ids: hives.map((n) => n.id), d: unit });
    s.pending.set(unit, (s.pending.get(unit) ?? 0) + 1);
    if (DEFS[unit].provides) s.pendingSupply += DEFS[unit].provides!;
  }

  private growUnits(s: Snap): void {
    this.growInto(s, 'scrapper', 'buzzbomb', 0.4, 2);
    this.growInto(s, 'stinger', 'bombardier', 0.35, 1);
    this.growInto(s, 'stinger', 'burrower', 0.3, 1);
  }

  /** Grow some `from` units into `to` until there are `ratio` of them per remaining `from`. */
  private growInto(s: Snap, from: string, to: string, ratio: number, n: number): void {
    const p = this.p;
    const d = DEFS[to];
    if (!this.g.techMet(p, d.requires) || !this.g.canAfford(p, { m: d.cost.m + 35, g: d.cost.g + 15 })) return;
    const src = s.byDef.get(from) ?? [];
    if (this.count(s, to) >= src.length * ratio) return;
    const pick = src.filter((e) => !e.morphTo).slice(0, n);
    if (pick.length) this.issue({ c: 'morph', ids: pick.map((e) => e.id), d: to });
  }

  // ------------------------------------------------------------------ abilities

  private abilities(s: Snap): void {
    const p = this.p;
    if (p.race === 'horde') {
      for (const n of s.halls) if (n.built && n.energy >= 25 && n.jellyT === 0) this.issue({ c: 'ability', ids: [n.id], a: 'royaljelly' });
    }
    if (p.race === 'starborn') {
      const sanct = s.halls.find((h) => h.built && h.energy >= 50);
      if (sanct) {
        const busy = s.structures.find((b) => b.built && b.queue.length > 0 && b.hasteT === 0 && !b.def.townHall) ?? s.halls.find((h) => h.queue.length > 0 && h.hasteT === 0);
        if (busy) this.issue({ c: 'ability', ids: [sanct.id], a: 'haste', t: busy.id, x: busy.x, y: busy.y });
      }
    }
    if (p.race === 'ironpaw' && this.cloakSeen) {
      // scan cloaked attackers near our forces
      const hub = s.halls.find((h) => h.built && h.energy >= 50);
      if (hub) {
        const team = p.team;
        for (const e of this.g.entities) {
          if (!e.alive || !e.def.cloaked || !this.g.isEnemy(this.pi, e.owner) || this.g.vision.detectedAt(team, e.x, e.y)) continue;
          const close = s.army.some((a) => near(a, e) < 7 * TILE) || s.structures.some((b) => near(b, e) < 8 * TILE);
          if (close && this.g.vision.visibleAt(team, e.x, e.y)) {
            this.issue({ c: 'ability', ids: [hub.id], a: 'sniff', x: e.x, y: e.y });
            break;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ military

  private frontBase(s: Snap): Entity | undefined {
    const en = this.enemyStarts[0];
    if (!en) return s.halls[0];
    let best: Entity | undefined;
    let bd = 1e18;
    for (const h of s.halls) {
      const d = near(h, en);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  private military(s: Snap): void {
    const g = this.g;
    const p = this.p;
    const front = this.frontBase(s);
    if (front) {
      const en = this.enemyStarts[0] ?? { x: g.map.w * TILE / 2, y: g.map.h * TILE / 2 };
      const d = near(front, en) || 1;
      const gx = front.x + ((en.x - front.x) / d) * 8 * TILE;
      const gy = front.y + ((en.y - front.y) / d) * 8 * TILE;
      const free = g.grid.nearestFreePoint(gx, gy, 2, 20);
      if (free) this.gather = free;
    }
    // threats near our structures
    const team = p.team;
    let threatX = 0;
    let threatY = 0;
    let threatN = 0;
    let threatSupply = 0;
    for (const e of g.entities) {
      if (!e.alive || e.owner < 0 || !g.isEnemy(this.pi, e.owner) || e.isBuilding || e.inside || e.def.kind !== 'unit') continue;
      if (!g.vision.visibleAt(team, e.x, e.y)) continue;
      if (e.def.cloaked && !g.vision.detectedAt(team, e.x, e.y)) continue;
      let close = false;
      for (const b of s.structures) {
        if (near(b, e) < 18 * TILE) {
          close = true;
          break;
        }
      }
      if (!close) continue;
      threatX += e.x;
      threatY += e.y;
      threatN++;
      threatSupply += e.def.worker ? 0.5 : e.def.supply ?? 1;
    }
    const army = s.army.filter((e) => !e.morphTo);
    const ids = army.map((e) => e.id);
    if (threatN > 0 && (this.state !== 'attack' || threatSupply > s.armySupply * 0.4)) {
      if (this.state === 'attack') this.attackSupply += 6;
      this.state = 'defend';
      const tx = threatX / threatN;
      const ty = threatY / threatN;
      if (g.tick - this.lastAmove > 40 && ids.length) {
        this.issue({ c: 'amove', ids, x: tx, y: ty });
        this.lastAmove = g.tick;
      }
      // emergency: workers fight back when there is no army (hard+)
      if (s.armySupply < threatSupply * 0.5 && threatSupply >= 3 && (this.difficulty === 'hard' || this.difficulty === 'brutal')) {
        const pull = s.workers.filter((w) => near(w, { x: tx, y: ty }) < 12 * TILE).slice(0, Math.ceil(threatSupply * 2));
        if (pull.length && g.tick % 40 < this.cfg.think) this.issue({ c: 'amove', ids: pull.map((w) => w.id), x: tx, y: ty });
      }
      return;
    }
    if (this.state === 'defend') {
      this.state = 'gather';
      if (ids.length) this.issue({ c: 'move', ids, x: this.gather.x, y: this.gather.y });
      // workers that were pulled go back to work
      for (const w of s.workers) if (w.orders[0]?.t === 'amove') this.issue({ c: 'stop', ids: [w.id] });
      return;
    }
    if (this.state === 'gather') {
      const idle = army.filter((e) => e.orders.length === 0 && near(e, this.gather) > 7 * TILE);
      if (idle.length) this.issue({ c: 'amove', ids: idle.map((e) => e.id), x: this.gather.x, y: this.gather.y });
      const outnumbered = this.difficulty !== 'easy' && this.enemyArmy > s.armySupply * 1.25 && p.supplyUsed < 170;
      const ready = (s.armySupply >= this.attackSupply && !outnumbered) || p.supplyUsed >= 185;
      if (ready && g.time >= this.cfg.firstAttackTime * (this.difficulty === 'easy' ? 1 : 0.6)) {
        this.state = 'attack';
        this.attackStrength = s.armySupply;
        this.target = this.pickTarget(s);
        this.lastAmove = -1000;
      }
      return;
    }
    // attacking
    if (s.armySupply < this.attackStrength * 0.35 && p.supplyUsed < 170) {
      this.state = 'gather';
      this.attackSupply = Math.min(150, this.attackSupply + 12);
      if (ids.length) this.issue({ c: 'move', ids, x: this.gather.x, y: this.gather.y });
      return;
    }
    // re-target when the current objective is gone, or when the army has arrived and stands idle
    const idleAtTarget = this.target && army.length > 0 && army.filter((e) => e.orders.length === 0).length > army.length * 0.6 && army.some((e) => near(e, this.target!) < 8 * TILE);
    if (!this.target || this.targetCleared(this.target) || idleAtTarget) this.target = this.pickTarget(s);
    if (!this.target) return;
    if (g.tick - this.lastAmove > 80 && ids.length) {
      // only re-issue to units that are idle or far behind, so fights aren't interrupted
      const send = army.filter((e) => e.orders.length === 0 || (e.orders[0].t === 'amove' && !e.target));
      if (send.length) this.issue({ c: 'amove', ids: send.map((e) => e.id), x: this.target.x, y: this.target.y });
      this.lastAmove = g.tick;
    }
  }

  private targetCleared(t: { x: number; y: number }): boolean {
    const g = this.g;
    if (!g.vision.visibleAt(this.p.team, t.x, t.y)) return false;
    for (const m of this.enemyMem.values()) if (near(m, t) < 10 * TILE) return false;
    return true;
  }

  private pickTarget(s: Snap): { x: number; y: number } | null {
    let from: { x: number; y: number } = s.halls[0] ?? this.home;
    if (s.army.length) {
      let ax = 0;
      let ay = 0;
      for (const a of s.army) {
        ax += a.x;
        ay += a.y;
      }
      from = { x: ax / s.army.length, y: ay / s.army.length };
    }
    let best: { x: number; y: number } | null = null;
    let bd = 1e18;
    for (const m of this.enemyMem.values()) {
      const d = near(m, from) + (DEFS[m.def]?.townHall ? -6 * TILE : 0);
      if (d < bd) {
        bd = d;
        best = { x: m.x, y: m.y };
      }
    }
    if (best) return best;
    // unexplored enemy starts first, then sweep every base location in turn
    const team = this.p.team;
    for (const st of this.enemyStarts) if (!this.g.vision.exploredAt(team, st.x, st.y)) return st;
    const bases = this.g.map.bases.map((b) => this.spotCenter(b));
    for (let k = 0; k < bases.length; k++) {
      const c = bases[(this.searchIdx + k) % bases.length];
      if (!this.g.vision.visibleAt(team, c.x, c.y)) {
        this.searchIdx = (this.searchIdx + k + 1) % bases.length;
        return c;
      }
    }
    return this.enemyStarts[0] ?? null;
  }

  // ------------------------------------------------------------------ micro

  private micro(s: Snap): void {
    const g = this.g;
    const p = this.p;
    const team = p.team;
    const enemiesNear = (e: Entity, r: number, groundOnly = false): Entity[] => {
      const out: Entity[] = [];
      for (const u of g.unitsNear(e.x, e.y, r, g.tmp2)) {
        if (!g.isEnemy(this.pi, u.owner) || u.inside || (groundOnly && u.air)) continue;
        if (!g.vision.visibleAt(team, u.x, u.y)) continue;
        if (u.def.cloaked && !g.vision.detectedAt(team, u.x, u.y)) continue;
        out.push(u);
      }
      return out;
    };
    for (const e of s.army) {
      if (this.cmds >= this.cfg.apm * 2) return;
      switch (e.def.id) {
        case 'kodiak':
        case 'burrower': {
          if (e.morphTo) break;
          const r = e.def.id === 'kodiak' ? 12 : 8;
          const en = enemiesNear(e, r * TILE, true);
          const blds = e.def.id === 'kodiak' && g.structuresNear(e.x, e.y, r * TILE, g.tmp).some((b) => g.isEnemy(this.pi, b.owner) && g.vision.visibleAt(team, b.x, b.y));
          if (en.length >= 2 || blds) this.issue({ c: 'ability', ids: [e.id], a: e.def.id === 'kodiak' ? 'brace' : 'hibernate' });
          break;
        }
        case 'sapper':
          if (!e.morphTo && enemiesNear(e, 8 * TILE).length) this.issue({ c: 'ability', ids: [e.id], a: 'digin' });
          break;
        case 'hoverbear': {
          if (e.morphTo) break;
          const en = enemiesNear(e, 10 * TILE, true);
          if (en.length >= 3) {
            const c = centroid(en);
            this.issue({ c: 'ability', ids: [e.id], a: 'anchor', x: c.x, y: c.y });
          }
          break;
        }
        case 'kodiak_b':
        case 'sapper_b':
        case 'burrower_b':
        case 'hoverbear_a': {
          if (e.morphTo) break;
          const en = enemiesNear(e, 14 * TILE, e.def.id !== 'sapper_b');
          const blds = e.def.id === 'kodiak_b' && g.structuresNear(e.x, e.y, 13 * TILE, g.tmp).some((b) => g.isEnemy(this.pi, b.owner) && g.vision.visibleAt(team, b.x, b.y));
          const idleT = (this.braceIdle.get(e.id) ?? 0) + (en.length || blds ? -1000 : this.cfg.think);
          this.braceIdle.set(e.id, Math.max(0, idleT));
          if (idleT > 100 && (this.state === 'attack' || near(e, this.gather) > 10 * TILE)) {
            this.issue({ c: 'ability', ids: [e.id], a: e.def.abilities![0] });
            this.braceIdle.set(e.id, 0);
          }
          break;
        }
        case 'blazerider':
          if (!e.morphTo && this.hasTech('armory') && this.enemyLight > 10 && enemiesNear(e, 6 * TILE, true).length >= 3) this.issue({ c: 'ability', ids: [e.id], a: 'hopoff' });
          break;
        case 'tracker':
          if (!e.lockT && !(e.cooldowns.lockon > 0)) {
            const en = enemiesNear(e, 7 * TILE).sort((a, b) => b.hp + b.shields - (a.hp + a.shields) || a.id - b.id);
            if (en.length) this.issue({ c: 'ability', ids: [e.id], a: 'lockon', t: en[0].id, x: en[0].x, y: en[0].y });
          }
          break;
        case 'denmother':
          if (!(e.cooldowns.releasecubs > 0)) {
            const en = enemiesNear(e, 14 * TILE, true);
            if (en.length) this.issue({ c: 'ability', ids: [e.id], a: 'releasecubs', x: en[0].x, y: en[0].y });
          }
          break;
        case 'bombardier':
          if (!(e.cooldowns.scaldinghoney > 0)) this.castOnCluster(e, 'scaldinghoney', 9, 0.75, 2, enemiesNear(e, 10 * TILE), false);
          break;
        case 'longtongue': {
          const en = enemiesNear(e, 10 * TILE);
          if (e.energy >= 75) {
            const big = en.filter((u) => (u.def.supply ?? 0) >= 3).sort((a, b) => (b.def.supply ?? 0) - (a.def.supply ?? 0) || a.id - b.id)[0];
            if (big) {
              this.issue({ c: 'ability', ids: [e.id], a: 'yank', t: big.id, x: big.x, y: big.y });
              break;
            }
          }
          if (e.energy >= 125) {
            const flyers = en.filter((u) => u.air);
            if (flyers.length >= 3) {
              this.issue({ c: 'ability', ids: [e.id], a: 'hornetbomb', t: flyers[0].id, x: flyers[0].x, y: flyers[0].y });
              break;
            }
          }
          if (e.energy >= 100) this.castOnCluster(e, 'pollen', 11, 2, 4, en.filter((u) => !u.air && u.def.weapons?.some((w) => !w.melee)), false);
          break;
        }
        case 'seer':
          if (e.energy >= 60 && enemiesNear(e, 6 * TILE, true).some((u) => u.def.attrs.includes('light'))) this.issue({ c: 'ability', ids: [e.id], a: 'sunlanceon' });
          break;
        case 'seer_b':
          if (!enemiesNear(e, 9 * TILE, true).length) this.issue({ c: 'ability', ids: [e.id], a: 'sunlanceoff' });
          break;
        case 'snowballer':
          if (!(e.cooldowns.snowball > 0)) this.castOnCluster(e, 'snowball', 8, 1.5, 3, enemiesNear(e, 10 * TILE, true), true);
          break;
        case 'ranger':
        case 'grizzly':
          if (p.has('honeyrush') && e.rushT === 0 && e.target && e.hp > (e.def.id === 'ranger' ? 30 : 60) && enemiesNear(e, 7 * TILE).length >= 3) {
            this.issue({ c: 'ability', ids: [e.id], a: 'honeyrush' });
          }
          break;
        case 'pandasage':
          if (p.has('starfall') && e.energy >= 75) this.castOnCluster(e, 'starfall', 9, 1.5, 4, enemiesNear(e, 11 * TILE), true);
          break;
        case 'swarmcaller':
          if (e.energy >= 100) {
            const en = enemiesNear(e, 9 * TILE).filter((u) => u.def.weapons?.some((w) => !w.melee));
            if (en.length >= 4) {
              const mine = s.army.filter((a) => !a.air && near(a, e) < 8 * TILE);
              if (mine.length >= 3) {
                let mx = 0;
                let my = 0;
                for (const a of mine) {
                  mx += a.x;
                  my += a.y;
                }
                this.issue({ c: 'ability', ids: [e.id], a: 'beecloud', x: mx / mine.length, y: my / mine.length });
                break;
              }
            }
          }
          if (p.has('stingswarm') && e.energy >= 75) this.castOnCluster(e, 'stingswarm', 9, 2, 4, enemiesNear(e, 11 * TILE), false);
          break;
        case 'lookout':
          if (e.energy >= 100) {
            const hurt = s.army.filter((a) => near(a, e) < 9 * TILE && a.bubble <= 0 && a.target && a.hp < (a.def.hp * 0.6));
            if (hurt.length) this.issue({ c: 'ability', ids: [e.id], a: 'bubble', t: hurt[0].id, x: hurt[0].x, y: hurt[0].y });
          }
          if (p.has('staticburst') && e.energy >= 75) {
            const en = enemiesNear(e, 11 * TILE).filter((u) => u.shields > 30 || u.energy > 50);
            this.castOnCluster(e, 'staticburst', 10, 1.5, 3, en, false);
          }
          break;
        case 'ironmama':
          if (p.has('grandcannon') && e.energy >= 125) {
            const en = enemiesNear(e, 10 * TILE).filter((u) => u.hp + u.shields >= 150).sort((a, b) => b.hp + b.shields - (a.hp + a.shields));
            if (en.length) this.issue({ c: 'ability', ids: [e.id], a: 'grandcannon', t: en[0].id, x: en[0].x, y: en[0].y });
          }
          break;
      }
    }
  }

  private castOnCluster(caster: Entity, ab: string, range: number, radius: number, minHits: number, enemies: Entity[], avoidFriendly: boolean): void {
    let best: Entity | null = null;
    let bestN = 0;
    const r = radius * TILE;
    for (const c of enemies) {
      if (near(c, caster) > (range + 1) * TILE) continue;
      let n = 0;
      for (const o of enemies) if (near(o, c) <= r) n++;
      if (avoidFriendly) {
        for (const f of this.g.unitsNear(c.x, c.y, r, this.g.tmp)) if (f.owner === this.pi) n -= 1.5;
      }
      if (n > bestN) {
        bestN = n;
        best = c;
      }
    }
    if (best && bestN >= minHits) this.issue({ c: 'ability', ids: [caster.id], a: ab, x: best.x, y: best.y });
  }

  // ------------------------------------------------------------------ scouting

  private scout(s: Snap): void {
    if (!this.cfg.scout || this.scoutDone) return;
    const g = this.g;
    if (!this.scoutId) {
      if (this.p.supplyUsed < 15 || !this.enemyStarts.length) return;
      const w = this.pickWorker(s, this.home.x, this.home.y);
      if (!w) return;
      this.scoutId = w.id;
    }
    const w = g.get(this.scoutId);
    if (!w) {
      this.scoutDone = true;
      return;
    }
    const team = this.p.team;
    const next = this.enemyStarts.find((st) => !g.vision.exploredAt(team, st.x, st.y));
    if (!next || this.enemyMem.size > 0) {
      // found them: back to work
      this.scoutDone = true;
      this.scoutId = 0;
      this.issue({ c: 'stop', ids: [w.id] });
      return;
    }
    if (w.orders[0]?.t !== 'move') this.issue({ c: 'move', ids: [w.id], x: next.x, y: next.y });
  }
}
