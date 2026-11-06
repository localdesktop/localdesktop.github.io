import { TICK_RATE, TILE } from './constants.ts';
import { ABILITY_DEFS, DEFS, RESEARCH_DEFS } from './data/index.ts';
import type { Entity, Order } from './entity.ts';
import type { Game } from './game.ts';
import { dist } from './math.ts';
import { maxHp } from './stats.ts';
import type { Command } from './types.ts';
import { weaponFor } from './systems/combat.ts';
import { cancelSlot, enqueue, supplyError } from './systems/structures.ts';
import { canPlace } from './systems/placement.ts';
import { castAbility, useInstant } from './systems/abilities.ts';
import { canRepairTarget } from './systems/units.ts';
import { canBoard, canCarry, focusBunker, unloadAll, unloadOne } from './systems/cargo.ts';

const MAX_IDS = 400;
/** queued (shift) orders per unit */
const MAX_ORDERS = 32;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Apply a player command. Every client runs this identically (lockstep). */
export function applyCommand(g: Game, pi: number, cmd: Command): void {
  const p = g.players[pi];
  if (!cmd || typeof cmd !== 'object') return;
  if (cmd.c === 'surrender' || cmd.c === 'leave') {
    if (cmd.c === 'leave') p.left = true;
    g.defeat(pi);
    return;
  }
  const own = (ids: unknown): Entity[] => {
    if (!Array.isArray(ids)) return [];
    const out: Entity[] = [];
    for (const id of ids.slice(0, MAX_IDS)) {
      if (!isNum(id)) continue;
      const e = g.get(id);
      if (e && e.owner === pi && !e.inside && !out.includes(e)) out.push(e);
    }
    return out;
  };
  const mobile = (es: Entity[]) =>
    es.filter((e) => e.isUnit && e.def.kind === 'unit' && (e.def.speed ?? 0) > 0 && !e.morphTo);

  const setOrder = (e: Entity, o: Order, q: boolean | undefined) => {
    if (q && e.orders.length > 0) {
      if (e.orders.length < MAX_ORDERS) e.orders.push(o);
      return;
    }
    e.orders = [o];
    e.ost = 0;
    e.path = null;
    e.target = 0;
    e.holdPos = false;
    e.arrived = false;
    e.stuckT = 0;
  };

  switch (cmd.c) {
    case 'move':
    case 'amove':
    case 'patrol': {
      if (!isNum(cmd.x) || !isNum(cmd.y)) return;
      const units = mobile(own(cmd.ids));
      const pts = formation(units, cmd.x, cmd.y);
      const gid = g.groupSeq++;
      units.forEach((u, i) => {
        const [x, y] = pts[i];
        u.group = gid;
        u.groupN = units.length;
        if (cmd.c === 'move') setOrder(u, { t: 'move', x, y, target: 0 }, cmd.q);
        else if (cmd.c === 'amove') setOrder(u, { t: 'amove', x, y }, cmd.q);
        else setOrder(u, { t: 'patrol', x, y, x2: u.x, y2: u.y }, cmd.q);
      });
      return;
    }
    case 'smart': {
      if (!isNum(cmd.x) || !isNum(cmd.y)) return;
      const all = own(cmd.ids);
      const t = isNum(cmd.t) ? g.get(cmd.t) : undefined;
      // structures: set rally; bunkers focus fire
      for (const b of all) {
        if (b.isBuilding && b.built && (b.def.produces || b.def.spawnsCubs)) b.rally = { x: cmd.x, y: cmd.y, target: t && t !== b ? t.id : 0 };
        if (t && g.isEnemy(pi, t.owner)) {
          if (b.def.bunker) focusBunker(g, b, t);
          else if (b.isUnit && !(b.def.speed ?? 0) && b.def.weapons && weaponFor(b, t) >= 0) b.target = t.id;
        }
      }
      const units = mobile(all);
      const movers: Entity[] = [];
      for (const u of units) {
        if (!t) {
          movers.push(u);
          continue;
        }
        if (t.isResource || (t.def.refinery && t.owner === pi)) {
          if (u.def.worker && (t.def.kind === 'mineral' || t.def.refinery || (t.def.kind === 'geyser' && g.get(t.link)?.owner === pi))) {
            setOrder(u, { t: 'gather', target: t.id }, cmd.q);
          } else movers.push(u);
          continue;
        }
        if (g.isEnemy(pi, t.owner)) {
          if (weaponFor(u, t) >= 0) setOrder(u, { t: 'attack', target: t.id }, cmd.q);
          else setOrder(u, { t: 'move', x: t.x, y: t.y, target: t.id }, cmd.q);
          continue;
        }
        if (u.def.worker && t.owner === pi) {
          if (u.def.race === 'ironpaw' && t.isBuilding && !t.built && t.def.race === 'ironpaw') {
            setOrder(u, { t: 'construct', target: t.id }, cmd.q);
            continue;
          }
          if (u.carry > 0 && t.def.depot && t.built) {
            setOrder(u, { t: 'return' }, cmd.q);
            continue;
          }
        }
        if (u.def.id === 'hardhat' && canRepairTarget(g, u, t) && t.hp < maxHp(t, g.players[t.owner])) {
          setOrder(u, { t: 'repair', target: t.id }, cmd.q);
          continue;
        }
        // board a friendly transport or bunker, or (transport) pick up a friendly unit
        if (t.owner === pi && t !== u) {
          if (t.def.cargo && canBoard(g, u, t)) {
            setOrder(u, { t: 'load', target: t.id }, cmd.q);
            continue;
          }
          if (u.def.cargo && canBoard(g, t, u)) {
            setOrder(u, { t: 'pickup', target: t.id }, cmd.q);
            continue;
          }
        }
        if (t.isUnit && t !== u) setOrder(u, { t: 'move', x: t.x, y: t.y, target: t.id }, cmd.q);
        else movers.push(u);
      }
      if (movers.length) {
        const pts = formation(movers, cmd.x, cmd.y);
        const gid = g.groupSeq++;
        movers.forEach((u, i) => {
          u.group = gid;
          u.groupN = movers.length;
          setOrder(u, { t: 'move', x: pts[i][0], y: pts[i][1], target: 0 }, cmd.q);
        });
      }
      return;
    }
    case 'attack': {
      const t = isNum(cmd.t) ? g.get(cmd.t) : undefined;
      if (!t) return;
      for (const u of mobile(own(cmd.ids))) {
        if (weaponFor(u, t) >= 0 && g.isEnemy(pi, t.owner)) setOrder(u, { t: 'attack', target: t.id }, cmd.q);
        else setOrder(u, { t: 'move', x: t.x, y: t.y, target: t.isUnit ? t.id : 0 }, cmd.q);
      }
      if (!g.isEnemy(pi, t.owner)) return;
      for (const b of own(cmd.ids)) {
        // structures and immobile units (braced Kodiaks) just switch targets
        if ((b.isBuilding || !(b.def.speed ?? 0)) && b.def.weapons && weaponFor(b, t) >= 0) {
          b.target = t.id;
          if (b.isUnit) b.orders = [];
        }
        if (b.def.bunker) focusBunker(g, b, t);
      }
      return;
    }
    case 'stop':
      for (const u of own(cmd.ids)) {
        if (u.def.bunker) focusBunker(g, u, undefined);
        if (!u.isUnit) continue;
        u.orders = [];
        u.ost = 0;
        u.path = null;
        u.target = 0;
        u.holdPos = false;
      }
      return;
    case 'hold':
      for (const u of own(cmd.ids)) {
        if (!u.isUnit || u.def.kind !== 'unit') continue;
        setOrder(u, { t: 'hold' }, false);
        u.holdPos = true;
      }
      return;
    case 'gather': {
      const t = isNum(cmd.t) ? g.get(cmd.t) : undefined;
      if (!t || !gatherable(g, pi, t)) return;
      for (const u of own(cmd.ids)) if (u.def.worker && !u.morphTo) setOrder(u, { t: 'gather', target: t.id }, cmd.q);
      return;
    }
    case 'return':
      for (const u of own(cmd.ids)) if (u.def.worker && u.carry > 0) setOrder(u, { t: 'return' }, cmd.q);
      return;
    case 'repair': {
      const t = isNum(cmd.t) ? g.get(cmd.t) : undefined;
      if (!t) return;
      for (const u of own(cmd.ids)) {
        if (u.def.id !== 'hardhat') continue;
        if (t.isBuilding && !t.built && t.owner === pi && t.def.race === 'ironpaw') setOrder(u, { t: 'construct', target: t.id }, cmd.q);
        else if (canRepairTarget(g, u, t)) setOrder(u, { t: 'repair', target: t.id }, cmd.q);
      }
      return;
    }
    case 'build': {
      const d = DEFS[cmd.d];
      if (!d || d.kind !== 'building' || d.race !== p.race || !isNum(cmd.tx) || !isNum(cmd.ty)) return;
      if (d.counts) return; // morph-only structures can't be placed
      const workers = own(cmd.ids).filter((u) => u.def.worker && u.def.race === p.race && !u.morphTo);
      if (!workers.length) return;
      const cx = (cmd.tx + d.size![0] / 2) * TILE;
      const cy = (cmd.ty + d.size![1] / 2) * TILE;
      workers.sort((a, b) => dist(a.x, a.y, cx, cy) - dist(b.x, b.y, cx, cy) || a.id - b.id);
      const w = workers[0];
      const err =
        (g.techMet(p, d.requires) ? null : `Requires ${g.missingTech(p, d.requires)}`) ??
        g.affordError(p, d.cost) ??
        canPlace(g, pi, d.id, cmd.tx, cmd.ty, w.id);
      if (err) {
        g.error(pi, err);
        return;
      }
      setOrder(w, { t: 'build', def: d.id, tx: cmd.tx, ty: cmd.ty }, cmd.q);
      return;
    }
    case 'train': {
      const d = DEFS[cmd.d];
      if (!d || d.kind !== 'unit') return;
      const blds = own(cmd.ids).filter((b) => b.isBuilding && b.built && b.def.produces?.includes(d.id));
      if (!blds.length) return;
      if (blds[0].def.spawnsCubs) {
        trainFromCubs(g, pi, blds, d.id);
        return;
      }
      const ready = blds.filter((b) => !b.def.needsPower || b.powered);
      if (!ready.length) {
        g.error(pi, 'Structure is unpowered');
        return;
      }
      ready.sort((a, b) => a.queue.length - b.queue.length || a.id - b.id);
      const err = enqueue(g, ready[0], 'unit', d.id);
      if (err) g.error(pi, err);
      return;
    }
    case 'research': {
      const blds = own(cmd.ids).filter((b) => b.isBuilding && b.built && b.def.researches?.includes(cmd.r));
      if (!blds.length) return;
      blds.sort((a, b) => a.queue.length - b.queue.length || a.id - b.id);
      const err = enqueue(g, blds[0], 'research', cmd.r);
      if (err) g.error(pi, err);
      return;
    }
    case 'morph': {
      const d = DEFS[cmd.d];
      if (!d) return;
      const sel = own(cmd.ids);
      const blds = sel.filter((b) => b.isBuilding && b.built && b.def.morphs?.includes(d.id) && !b.queue.some((q) => q.kind === 'morph'));
      if (blds.length) {
        const err = enqueue(g, blds[0], 'morph', d.id);
        if (err) g.error(pi, err);
        return;
      }
      for (const u of sel) {
        if (!u.isUnit || !u.def.unitMorphs?.includes(d.id) || u.morphTo) continue;
        const more = (d.supply ?? 0) - (u.def.supply ?? 0);
        const err = (g.techMet(p, d.requires) ? null : `Requires ${g.missingTech(p, d.requires)}`) ?? g.affordError(p, d.cost) ??
          (more > 0 && p.supplyUsed + more > p.supplyMax ? supplyError(g, p) : null);
        if (err) {
          g.error(pi, err);
          return;
        }
        g.spend(p, d.cost);
        p.supplyUsed += Math.max(0, more);
        u.morphTo = d.id;
        u.morphT = 0;
        u.morphTotal = Math.round(d.time * TICK_RATE);
        u.morphCost = d.cost;
        u.orders = [];
        u.path = null;
        u.target = 0;
      }
      return;
    }
    case 'cancel': {
      const e = isNum(cmd.id) ? g.get(cmd.id) : undefined;
      if (!e || e.owner !== pi || !isNum(cmd.slot)) return;
      cancelSlot(g, e, cmd.slot);
      return;
    }
    case 'rally': {
      if (!isNum(cmd.x) || !isNum(cmd.y)) return;
      const t = isNum(cmd.t) ? g.get(cmd.t) : undefined;
      for (const b of own(cmd.ids)) {
        if (b.isBuilding && (b.def.produces || b.def.spawnsCubs)) b.rally = { x: cmd.x, y: cmd.y, target: t && t !== b ? t.id : 0 };
      }
      return;
    }
    case 'autocast':
      for (const u of own(cmd.ids)) u.autocast = !!cmd.on;
      return;
    case 'load': {
      const t = isNum(cmd.t) ? g.get(cmd.t) : undefined;
      if (!t || t.owner !== pi) return;
      const sel = own(cmd.ids);
      if (t.def.cargo) {
        // the selected units board t
        if (!canCarry(g, t)) {
          g.error(pi, t.def.cargoReq ? `Requires ${RESEARCH_DEFS[t.def.cargoReq]?.name ?? 'research'}` : 'Cannot load units');
          return;
        }
        const fit = mobile(sel).filter((u) => canBoard(g, u, t, false));
        const go = fit.filter((u) => canBoard(g, u, t));
        for (const u of go) setOrder(u, { t: 'load', target: t.id }, cmd.q);
        if (!go.length) g.error(pi, fit.length ? 'Not enough room' : "Those units can't go in there");
        return;
      }
      // the selected transports pick up t: send the closest one with room
      const carriers = sel.filter((c) => c.isUnit && canBoard(g, t, c));
      if (!carriers.length) {
        g.error(pi, sel.some((c) => c.def.cargo && canCarry(g, c)) && canBoard(g, t, sel.find((c) => c.def.cargo)!, false) ? 'Not enough room' : "Can't load that unit");
        return;
      }
      carriers.sort((a, b) => dist(a.x, a.y, t.x, t.y) - dist(b.x, b.y, t.x, t.y) || a.id - b.id);
      setOrder(carriers[0], { t: 'pickup', target: t.id }, cmd.q);
      return;
    }
    case 'unload': {
      for (const c of own(cmd.ids)) {
        if (!c.def.cargo) continue;
        if (isNum(cmd.u)) {
          const u = g.get(cmd.u);
          if (u && u.carrier === c.id && !unloadOne(g, c, u)) g.error(pi, 'Unable to unload here');
          continue;
        }
        if (c.isBuilding) {
          unloadAll(g, c);
          continue;
        }
        if (!c.cargo.length && !cmd.q) continue;
        let x = isNum(cmd.x) ? cmd.x : c.x;
        let y = isNum(cmd.y) ? cmd.y : c.y;
        x = Math.max(0, Math.min(g.map.w * TILE - 1, x));
        y = Math.max(0, Math.min(g.map.h * TILE - 1, y));
        // aim for walkable ground near the chosen spot
        const pt = g.grid.nearestFreePoint(x, y, 1, 24);
        if (pt && dist(pt.x, pt.y, x, y) <= 6 * TILE) {
          x = pt.x;
          y = pt.y;
        }
        setOrder(c, { t: 'unload', x, y }, cmd.q);
      }
      return;
    }
    case 'ability': {
      const ab = ABILITY_DEFS[cmd.a];
      if (!ab) return;
      const casters = own(cmd.ids).filter((e) => e.def.abilities?.includes(ab.id) && (!e.isBuilding || e.built) && !e.morphTo);
      if (!casters.length) return;
      if (ab.requires && !p.has(ab.requires)) {
        g.error(pi, `Requires ${ab.name} research`);
        return;
      }
      if (ab.target === 'none') {
        let firstErr: string | null = null;
        for (const e of casters) {
          const err = useInstant(g, e, ab.id);
          if (err && !firstErr) firstErr = err;
          if (ab.id === 'royaljelly' && !err) break; // one Hive per command
        }
        if (firstErr && ab.id !== 'honeyrush') g.error(pi, firstErr);
        return;
      }
      const t = isNum(cmd.t) ? g.get(cmd.t) : undefined;
      const x = isNum(cmd.x) ? cmd.x : t?.x;
      const y = isNum(cmd.y) ? cmd.y : t?.y;
      if (x === undefined || y === undefined) return;
      if ((ab.target === 'unit' || ab.target === 'ally' || ab.target === 'enemy' || ab.target === 'own-building') && !t) {
        g.error(pi, 'Must target a unit');
        return;
      }
      // energy spells: only the best caster casts (smart casting); cooldown spells: everyone
      let chosen = casters;
      if (ab.energy) {
        const able = casters.filter((e) => e.energy >= ab.energy!);
        if (!able.length) {
          g.error(pi, 'Not enough energy');
          return;
        }
        able.sort((a, b) => dist(a.x, a.y, x, y) - dist(b.x, b.y, x, y) || b.energy - a.energy || a.id - b.id);
        // don't double-cast with casters already moving to cast the same spell
        chosen = [able.find((e) => !(e.orders[0]?.t === 'ability' && (e.orders[0] as { ab: string }).ab === ab.id)) ?? able[0]];
      } else if (ab.cooldown) {
        chosen = casters.filter((e) => !(e.cooldowns[ab.id] > 0));
        if (!chosen.length) {
          g.error(pi, 'Ability is cooling down');
          return;
        }
      }
      for (const e of chosen) {
        if (e.isBuilding) castAbility(g, e, ab, x, y, t);
        else setOrder(e, { t: 'ability', ab: ab.id, x, y, target: t ? t.id : 0 }, cmd.q);
      }
      return;
    }
  }
}

/** Minerals, own finished refineries, and geysers under one. */
export function gatherable(g: Game, pi: number, t: Entity): boolean {
  if (t.def.kind === 'mineral') return true;
  if (t.def.refinery) return t.owner === pi;
  if (t.def.kind === 'geyser') return g.get(t.link)?.owner === pi;
  return false;
}

function trainFromCubs(g: Game, pi: number, hives: Entity[], unitId: string): void {
  const p = g.players[pi];
  const d = DEFS[unitId];
  const err = (g.techMet(p, d.requires) ? null : `Requires ${g.missingTech(p, d.requires)}`) ?? g.affordError(p, d.cost);
  if (err) {
    g.error(pi, err);
    return;
  }
  const sup = (d.supply ?? 0) * (d.count ?? 1);
  if (sup > 0 && p.supplyUsed + sup > p.supplyMax) {
    g.error(pi, supplyError(g, p));
    return;
  }
  hives.sort((a, b) => b.cubs.length - a.cubs.length || a.id - b.id);
  const hive = hives[0];
  const cubId = hive.cubs.find((id) => g.get(id)?.def.kind === 'cub');
  const cub = cubId ? g.get(cubId) : undefined;
  if (!cub) {
    g.error(pi, 'No cubs available');
    return;
  }
  g.spend(p, d.cost);
  p.supplyUsed += sup;
  hive.cubs.splice(hive.cubs.indexOf(cub.id), 1);
  cub.def = DEFS.cocoon;
  cub.r = DEFS.cocoon.radius ?? 8;
  cub.hp = DEFS.cocoon.hp;
  cub.morphTo = d.id;
  cub.morphT = 0;
  cub.morphTotal = Math.round(d.time * TICK_RATE);
  cub.morphCost = d.cost;
  cub.wantMove = false;
}

/**
 * Destinations for a group move. If the group is compact and the target lies outside
 * its bounding box, units keep their relative positions ("magic box"); otherwise they
 * all head to the same point.
 */
export function formation(units: Entity[], x: number, y: number): [number, number][] {
  if (units.length <= 1) return units.map(() => [x, y]);
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1e9;
  let maxY = -1e9;
  let cx = 0;
  let cy = 0;
  for (const u of units) {
    cx += u.x;
    cy += u.y;
    if (u.x < minX) minX = u.x;
    if (u.y < minY) minY = u.y;
    if (u.x > maxX) maxX = u.x;
    if (u.y > maxY) maxY = u.y;
  }
  cx /= units.length;
  cy /= units.length;
  const inside = x >= minX && x <= maxX && y >= minY && y <= maxY;
  const compact = maxX - minX < 10 * TILE && maxY - minY < 10 * TILE;
  if (inside || !compact) return units.map(() => [x, y]);
  return units.map((u) => [x + (u.x - cx), y + (u.y - cy)]);
}

