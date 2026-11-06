import {
  BURN_RATE, ENERGY_REGEN, HORDE_REGEN, CUB_CAP, CUB_INTERVAL, CUB_MAX, SHIELD_DELAY, SHIELD_REGEN, TICK_RATE, TILE, CELL,
} from '../constants.ts';
import { DEFS, RESEARCH_DEFS } from '../data/index.ts';
import type { Entity, QueueItem } from '../entity.ts';
import { spawnCubFor, type Game } from '../game.ts';
import { clearanceFor } from '../grid.ts';
import type { Player } from '../player.ts';
import { maxHp, maxShields } from '../stats.ts';
import { dist } from '../math.ts';
import { drainUpdate } from './abilities.ts';

const SUPPLY_ALERT_COOLDOWN = 10 * TICK_RATE;

export function updateStructures(g: Game): void {
  const ents = g.entities;
  // iterate by index: spawning appends to the array; new entities start next tick
  const n = ents.length;
  for (let i = 0; i < n; i++) {
    const e = ents[i];
    if (!e.alive || e.isResource) continue;
    const p = g.players[e.owner];
    regen(g, e, p);
    if (e.isBuilding) updateBuilding(g, e, p);
    else updateUnitTimers(g, e, p);
  }
}

function regen(g: Game, e: Entity, p: Player | undefined): void {
  const d = e.def;
  if (d.energy && (e.built || !e.isBuilding)) {
    e.energy += ENERGY_REGEN;
    if (e.energy > d.energy) e.energy = d.energy;
  }
  if (d.shields && e.shields < d.shields && g.tick - e.lastHit > SHIELD_DELAY && (e.built || !e.isBuilding)) {
    e.shields += SHIELD_REGEN;
    if (e.shields > d.shields) e.shields = d.shields;
  }
  if (d.race === 'horde' && (e.built || !e.isBuilding)) {
    const mh = maxHp(e, p);
    if (e.hp < mh) e.hp = Math.min(mh, e.hp + HORDE_REGEN);
  }
}

export function advanceConstruction(g: Game, e: Entity, amount: number): void {
  if (e.built) return;
  const total = e.def.time * TICK_RATE;
  const before = e.progress;
  e.progress = Math.min(1, e.progress + amount / total);
  const p = g.players[e.owner];
  const mh = maxHp(e, p);
  e.hp = Math.min(mh, e.hp + mh * 0.9 * (e.progress - before));
  const ms = maxShields(e);
  if (ms) e.shields = Math.min(ms, e.shields + ms * 0.9 * (e.progress - before));
  if (e.progress >= 1) completeBuilding(g, e, false);
}

export function completeBuilding(g: Game, e: Entity, silent: boolean): void {
  e.built = true;
  e.progress = 1;
  e.builder = 0;
  const p = g.players[e.owner];
  if (p) {
    p.stats.buildingsBuilt += silent ? 0 : 1;
    for (const id of [e.def.id, ...(e.def.counts ?? [])]) p.tech[id] = (p.tech[id] ?? 0) + 1;
  }
  if (e.def.combRadius) g.comb.dirty = true;
  g.powerDirty = true;
  if (e.def.townHall && !e.rally) {
    // default rally: nearest mineral, so new workers mine automatically
    let best: Entity | undefined;
    let bd = 12 * TILE;
    for (const m of g.entities) {
      if (!m.alive || m.def.kind !== 'mineral') continue;
      const d = dist(m.x, m.y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (best) e.rally = { x: best.x, y: best.y, target: best.id };
  }
  if (!silent) g.events.push({ k: 'built', id: e.id, owner: e.owner, def: e.def.id, x: e.x, y: e.y });
}

function updateBuilding(g: Game, e: Entity, p: Player | undefined): void {
  if (!p) return;
  if (!e.built) {
    // ironpaw structures only progress while an hardhat works on them
    if (e.def.race !== 'ironpaw') advanceConstruction(g, e, 1);
    return;
  }
  // burning (ironpaw)
  if (e.def.race === 'ironpaw') {
    const mh = maxHp(e, p);
    if (e.hp < mh / 3) {
      e.hp -= BURN_RATE;
      if (e.hp <= 0) {
        g.kill(e);
        return;
      }
    }
  }
  if (e.hasteT > 0) e.hasteT--;
  if (e.def.spawnsCubs) updateCubs(g, e);
  if (e.def.needsPower && !e.powered) return;
  // tower weapons are handled in units.ts (buildings with weapons)
  const item = e.queue[0];
  if (!item) return;
  if (!item.started) {
    if (item.kind === 'unit') {
      const ud = DEFS[item.id];
      const sup = (ud.supply ?? 0) * (ud.count ?? 1);
      if (sup > 0 && p.supplyUsed + sup > p.supplyMax) {
        if (g.tick - p.lastSupplyAlert > SUPPLY_ALERT_COOLDOWN) {
          p.lastSupplyAlert = g.tick;
          g.events.push({ k: 'alert', owner: p.index, kind: 'supply', x: e.x, y: e.y });
        }
        return;
      }
      p.supplyUsed += sup;
    }
    item.started = true;
  }
  item.progress += e.hasteT > 0 ? 1.5 : 1;
  if (item.progress >= item.total) {
    e.queue.shift();
    finishItem(g, e, item, p);
  }
}

function updateCubs(g: Game, e: Entity): void {
  if (e.cubs.length < CUB_MAX) {
    e.cubT++;
    if (e.cubT >= CUB_INTERVAL) {
      e.cubT = 0;
      spawnCubFor(g, e);
    }
  } else e.cubT = 0;
  if (e.jellyT > 0) {
    e.jellyT--;
    if (e.jellyT === 0) for (let i = 0; i < 3 && e.cubs.length < CUB_CAP; i++) spawnCubFor(g, e);
  }
}

function finishItem(g: Game, e: Entity, item: QueueItem, p: Player): void {
  if (item.kind === 'unit') {
    const ud = DEFS[item.id];
    for (let i = 0; i < (ud.count ?? 1); i++) {
      const u = spawnNear(g, e, item.id);
      applyRally(g, e, u);
      g.events.push({ k: 'trained', id: u.id, owner: p.index, def: ud.id, x: u.x, y: u.y });
    }
    p.stats.unitsProduced += ud.count ?? 1;
  } else if (item.kind === 'research') {
    p.upgrades[item.id] = item.level;
    p.researching[item.id] = Math.max(0, (p.researching[item.id] ?? 1) - 1);
    if (item.id === 'thickfur') {
      for (const u of g.entities) if (u.alive && u.owner === p.index && u.def.id === 'ranger') u.hp += 10;
    }
    g.events.push({ k: 'researched', owner: p.index, id: item.id, level: item.level });
  } else if (item.kind === 'morph') {
    const oldMax = maxHp(e, p);
    e.def = DEFS[item.id];
    const newMax = maxHp(e, p);
    e.hp += newMax - oldMax;
    if (e.def.combRadius) g.comb.dirty = true;
    for (const id of e.def.counts ?? []) p.tech[id] = p.tech[id] ?? 1;
    p.tech[e.def.id] = (p.tech[e.def.id] ?? 0) + 1;
    g.events.push({ k: 'built', id: e.id, owner: p.index, def: e.def.id, x: e.x, y: e.y });
  }
}

/** Spawn a unit next to a structure, on the side facing its rally point. */
export function spawnNear(g: Game, b: Entity, defId: string): Entity {
  const def = DEFS[defId];
  if (def.air) {
    return g.spawnUnit(defId, b.owner, b.x + (b.id % 3 - 1) * 6, b.y + (g.tick % 3 - 1) * 6);
  }
  const req = clearanceFor(def.radius ?? 8);
  const tx = b.rally ? b.rally.x : b.x;
  const ty = b.rally ? b.rally.y : b.y1 + 64;
  // candidate points around the footprint perimeter
  let best: { x: number; y: number } | null = null;
  let bestScore = 1e18;
  const r = def.radius ?? 8;
  const off = Math.max(r + 2, (req - 0.5) * CELL + 4);
  const x0 = b.x0 - off;
  const x1 = b.x1 + off;
  const y0 = b.y0 - off;
  const y1 = b.y1 + off;
  const step = 8;
  const pts: number[] = [];
  for (let x = x0; x <= x1; x += step) pts.push(x, y0, x, y1);
  for (let y = y0 + step; y < y1; y += step) pts.push(x0, y, x1, y);
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i];
    const py = pts[i + 1];
    if (!g.grid.passableAt(px, py, req)) continue;
    let crowd = 0;
    for (const u of g.unitsNear(px, py, r + 2, g.tmp)) if (!u.air) crowd++;
    const score = dist(px, py, tx, ty) + crowd * 40;
    if (score < bestScore) {
      bestScore = score;
      best = { x: px, y: py };
    }
  }
  const sx = best ? best.x : b.x;
  const sy = best ? best.y : b.y1 + r;
  return g.spawnUnit(defId, b.owner, sx, sy);
}

export function applyRally(g: Game, b: Entity, u: Entity): void {
  const r = b.rally;
  if (!r) return;
  const t = g.get(r.target);
  if (u.def.worker && t && (t.def.kind === 'mineral' || (t.def.refinery && t.owner === u.owner && t.built))) {
    u.orders = [{ t: 'gather', target: t.id }];
    u.ost = 0;
    return;
  }
  if (t && t !== b) u.orders = [{ t: 'move', x: t.x, y: t.y, target: t.isUnit ? t.id : 0 }];
  else u.orders = [{ t: 'move', x: r.x, y: r.y, target: 0 }];
  u.ost = 0;
}

function updateUnitTimers(g: Game, e: Entity, p: Player | undefined): void {
  if (e.rushT > 0) e.rushT--;
  if (e.slowT > 0) e.slowT--;
  if (e.bubbleT > 0) {
    e.bubbleT--;
    if (e.bubbleT === 0) e.bubble = 0;
  }
  for (const k in e.cooldowns) if (e.cooldowns[k] > 0) e.cooldowns[k]--;
  if (e.blindT > 0) e.blindT--;
  if (e.def.drain) drainUpdate(g, e);
  if (e.lifeT > 0 && --e.lifeT === 0) {
    g.events.push({ k: 'death', id: e.id, def: e.def.id, owner: e.owner, x: e.x, y: e.y, air: e.air, building: false, r: e.r });
    g.removeSilently(e);
    return;
  }
  if (e.morphTo) {
    e.morphT++;
    if (e.morphT >= e.morphTotal) finishMorph(g, e, p);
  }
}

export function finishMorph(g: Game, e: Entity, p: Player | undefined): void {
  const to = e.morphTo!;
  const td = DEFS[to];
  if (e.def.kind === 'cocoon') {
    const hive = g.get(e.hive);
    for (let i = 0; i < (td.count ?? 1); i++) {
      const u = g.spawnUnit(to, e.owner, e.x + (i ? 8 : 0), e.y + (i ? 4 : 0));
      if (hive) applyRally(g, hive, u);
      g.events.push({ k: 'trained', id: u.id, owner: e.owner, def: to, x: u.x, y: u.y });
    }
    if (p) p.stats.unitsProduced += td.count ?? 1;
    g.removeSilently(e);
    return;
  }
  const oldMax = maxHp(e, p);
  const ratio = e.hp / Math.max(1, oldMax);
  e.def = td;
  e.r = td.radius ?? e.r;
  e.air = !!td.air;
  e.hp = Math.max(1, ratio * maxHp(e, p));
  e.morphTo = null;
  e.morphCost = null;
  e.cds = [0, 0];
  if (td.morphFrom) g.events.push({ k: 'trained', id: e.id, owner: e.owner, def: to, x: e.x, y: e.y });
}

/** Queue production/research/morph on a building. Returns an error message or null. */
export function enqueue(g: Game, b: Entity, kind: QueueItem['kind'], id: string): string | null {
  const p = g.players[b.owner];
  if (!b.built) return 'Structure is not finished';
  if (b.queue.length >= 5) return 'Queue is full';
  let cost: { m: number; g: number };
  let time: number;
  let level = 0;
  if (kind === 'unit') {
    const d = DEFS[id];
    if (!g.techMet(p, d.requires)) return `Requires ${g.missingTech(p, d.requires)}`;
    cost = d.cost;
    time = d.time;
    const sup = (d.supply ?? 0) * (d.count ?? 1);
    if (b.queue.length === 0 && sup > 0 && p.supplyUsed + sup > p.supplyMax) {
      return supplyError(g, p);
    }
  } else if (kind === 'research') {
    const r = RESEARCH_DEFS[id];
    const done = p.level(id);
    const inProgress = p.researching[id] ?? 0;
    level = done + inProgress + 1;
    if (level > r.costs.length) return 'Already researched';
    if (inProgress > 0) return 'Already researching';
    const reqs = r.reqs?.[level - 1];
    if (reqs && !g.techMet(p, reqs)) return `Requires ${g.missingTech(p, reqs)}`;
    cost = r.costs[level - 1];
    time = r.times[level - 1];
  } else {
    const d = DEFS[id];
    if (!g.techMet(p, d.requires)) return `Requires ${g.missingTech(p, d.requires)}`;
    if (b.queue.some((q) => q.kind === 'morph')) return 'Already evolving';
    cost = d.cost;
    time = d.time;
  }
  const err = g.affordError(p, cost);
  if (err) return err;
  g.spend(p, cost);
  if (kind === 'research') p.researching[id] = (p.researching[id] ?? 0) + 1;
  b.queue.push({ kind, id, level, progress: 0, total: Math.round(time * TICK_RATE), started: false, cost });
  return null;
}

export function supplyError(g: Game, p: Player): string {
  void g;
  switch (p.race) {
    case 'ironpaw':
      return 'Not enough supply: build more Larders';
    case 'horde':
      return 'Not enough supply: raise more Bumblebears';
    default:
      return 'Not enough supply: call down more Star Totems';
  }
}

/** Cancel a queue slot (refund). slot -1 cancels construction / morph in progress. */
export function cancelSlot(g: Game, b: Entity, slot: number): void {
  const p = g.players[b.owner];
  if (slot < 0) {
    if (!b.built) {
      const cost = b.def.cost;
      g.refund(p, cost, 0.75);
      if (b.fromWorker) {
        const d = g.spawnUnit('forager', b.owner, b.x, b.y);
        d.orders = [];
      }
      g.removeSilently(b);
      g.events.push({ k: 'death', id: b.id, def: b.def.id, owner: b.owner, x: b.x, y: b.y, air: false, building: true, r: b.r });
      return;
    }
    if (b.morphTo && b.morphCost) {
      g.refund(p, b.morphCost, 1);
      if (b.def.kind === 'cocoon') {
        // the cub returns to its hive (and dies with it if the hive is gone)
        b.def = DEFS.cub;
        b.morphTo = null;
        b.morphCost = null;
        b.r = DEFS.cub.radius ?? 8;
        b.hp = DEFS.cub.hp;
        const hive = g.get(b.hive);
        if (hive) hive.cubs.push(b.id);
        else g.removeSilently(b);
        return;
      }
      b.morphTo = null;
      b.morphCost = null;
    }
    return;
  }
  const item = b.queue[slot];
  if (!item) return;
  b.queue.splice(slot, 1);
  g.refund(p, item.cost, 1);
  if (item.kind === 'research') p.researching[item.id] = Math.max(0, (p.researching[item.id] ?? 1) - 1);
}
