import { ACQUIRE_INTERVAL, COMB_SPEED_BONUS, GAS_TICKS, GAS_TRIP, MINE_TICKS, MINERAL_TRIP, TICK_RATE, TILE } from '../constants.ts';
import { ABILITY_DEFS, DEFS } from '../data/index.ts';
import type { Entity } from '../entity.ts';
import type { Game } from '../game.ts';
import { clearanceFor } from '../grid.ts';
import { datan2, dist, distToRect } from '../math.ts';
import type { Player } from '../player.ts';
import { baseSpeed, edgeDist, maxHp } from '../stats.ts';
import {
  acquireRadius, findTarget, fireWeapon, inWeaponRange, isValidTarget, weaponFor, canSee,
} from './combat.ts';
import { advanceConstruction } from './structures.ts';
import { canPlace } from './placement.ts';
import { castAbility, lockUpdate } from './abilities.ts';
import { cargoUpdate, doLoad, doPickup, doUnload } from './cargo.ts';

export function updateUnits(g: Game): void {
  const ents = g.entities;
  const n = ents.length;
  for (let i = 0; i < n; i++) {
    const e = ents[i];
    if (!e.alive || e.isResource) continue;
    if (e.isBuilding) {
      if (e.built && e.def.weapons && (!e.def.needsPower || e.powered)) towerUpdate(g, e);
      continue;
    }
    e.wantMove = false;
    if (e.inside) {
      if (e.carrier) cargoUpdate(g, e);
      else insideUpdate(g, e);
      continue;
    }
    unitUpdate(g, e);
  }
}

// ------------------------------------------------------------------ helpers

export function done(e: Entity): void {
  e.orders.shift();
  e.ost = 0;
  e.path = null;
  e.target = 0;
  e.stuckT = 0;
}

export function unitSpeed(g: Game, e: Entity): number {
  let s = baseSpeed(e, g.players[e.owner]);
  if (!e.air && e.def.race === 'horde' && g.comb.hasAt(e.x, e.y)) s *= COMB_SPEED_BONUS;
  return s;
}

function steer(e: Entity, tx: number, ty: number, spd: number): void {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.01) return;
  const s = spd < d ? spd : d;
  e.vx = (dx / d) * s;
  e.vy = (dy / d) * s;
  e.wantMove = true;
}

/** Move toward (x,y). Returns true once within `arrive` px (or no closer point is reachable). */
export function moveTo(g: Game, e: Entity, x: number, y: number, arrive: number): boolean {
  const dx = x - e.x;
  const dy = y - e.y;
  if (dx * dx + dy * dy <= arrive * arrive) {
    e.path = null;
    return true;
  }
  const spd = unitSpeed(g, e);
  if (spd <= 0) return false;
  if (e.air) {
    steer(e, x, y, spd);
    return false;
  }
  if (e.stuckT >= 80) {
    // genuinely stuck: give up on this destination
    e.stuckT = 0;
    e.path = null;
    return true;
  }
  if (e.repathT > 0) e.repathT--;
  const stale =
    !e.path ||
    Math.abs(e.pathGoalX - x) > 12 ||
    Math.abs(e.pathGoalY - y) > 12 ||
    (e.pathVer !== g.grid.version && ((g.tick + e.id) & 7) === 0) ||
    (e.stuckT >= 30 && e.stuckT % 30 === 0);
  if (stale && (e.repathT <= 0 || !e.path)) {
    const req = clearanceFor(e.r);
    let path = sharedPath(g, e, x, y, req);
    if (!path) {
      if (g.pathBudget > 0 || !e.path) {
        if (g.pathBudget > 0) {
          path = g.grid.findPath(e.x, e.y, x, y, req);
          g.pathBudget -= g.grid.lastExpanded + 40;
          if (path && path.length > 2) {
            const key = pathKey(g, x, y, req);
            g.pathCache.set(key, { pts: path, sx: e.x, sy: e.y, gx: x, gy: y, tick: g.tick, ver: g.grid.version });
          }
        } else {
          // out of budget this tick: head straight for the goal and try again shortly
          path = [x, y];
          e.repathT = 2 + (e.id % 3);
        }
      }
    }
    if (path || !e.path) {
      e.path = path ?? [];
      e.pathI = 0;
      e.pathGoalX = x;
      e.pathGoalY = y;
      e.pathVer = g.grid.version;
      if (e.repathT <= 0) e.repathT = 6;
    }
  }
  const path = e.path!;
  if (path.length === 0) return true; // nowhere closer to go
  const n = path.length >> 1;
  while (e.pathI < n) {
    const wx = path[e.pathI * 2];
    const wy = path[e.pathI * 2 + 1];
    const ddx = wx - e.x;
    const ddy = wy - e.y;
    const last = e.pathI === n - 1;
    const reach = last ? Math.max(arrive, 2) : Math.max(6, spd);
    if (ddx * ddx + ddy * ddy <= reach * reach) {
      if (last) {
        e.path = null;
        return true;
      }
      e.pathI++;
    } else break;
  }
  steer(e, path[e.pathI * 2], path[e.pathI * 2 + 1], spd);
  return false;
}

function pathKey(g: Game, x: number, y: number, req: number): number {
  // goals are bucketed into 4x4-cell regions so units moving in formation share paths
  const rx = g.grid.cellX(x) >> 2;
  const ry = g.grid.cellY(y) >> 2;
  return (ry * ((g.grid.cw >> 2) + 1) + rx) * 4 + req;
}

/**
 * Reuse a path another unit computed recently towards the same area, if this unit
 * started nearby and can see onto it. Turns 100 searches for a big army into a handful.
 */
function sharedPath(g: Game, e: Entity, x: number, y: number, req: number): number[] | null {
  const c = g.pathCache.get(pathKey(g, x, y, req));
  if (!c || c.ver !== g.grid.version || g.tick - c.tick > 60) return null;
  const dx = e.x - c.sx;
  const dy = e.y - c.sy;
  if (dx * dx + dy * dy > 200 * 200) return null;
  const n = c.pts.length >> 1;
  const lx = c.pts[c.pts.length - 2];
  const ly = c.pts[c.pts.length - 1];
  const reached = lx === c.gx && ly === c.gy;
  for (let i = Math.min(n - 1, 5); i >= 0; i--) {
    if (!g.grid.lineClear(e.x, e.y, c.pts[i * 2], c.pts[i * 2 + 1], req)) continue;
    const out = c.pts.slice(i * 2);
    if (reached) {
      // finish at this unit's own goal when the last leg is open
      const px = out.length >= 4 ? out[out.length - 4] : e.x;
      const py = out.length >= 4 ? out[out.length - 3] : e.y;
      if (!g.grid.lineClear(px, py, x, y, req)) return null;
      out[out.length - 2] = x;
      out[out.length - 1] = y;
    }
    return out;
  }
  return null;
}

function face(e: Entity, t: { x: number; y: number }): void {
  if (t.x !== e.x || t.y !== e.y) e.angle = datan2(t.y - e.y, t.x - e.x);
}

function canMove(g: Game, e: Entity): boolean {
  return (e.def.speed ?? 0) > 0 && !e.holdPos && unitSpeed(g, e) > 0;
}

/** Attack t if in range, else (optionally) approach. Returns true if busy with t. */
function engage(g: Game, e: Entity, t: Entity, chase: boolean): boolean {
  const wi = weaponFor(e, t);
  if (wi < 0) return false;
  if (inWeaponRange(g, e, t, wi)) {
    e.path = null;
    if (e.cds[wi] <= 0) fireWeapon(g, e, wi, t);
    else if (!e.def.turret) face(e, t);
    e.turret = datan2(t.y - e.y, t.x - e.x);
    return true;
  }
  if (!chase || !canMove(g, e)) return false;
  moveTo(g, e, t.x, t.y, 0);
  return true;
}

function resumeGather(g: Game, e: Entity): void {
  if (e.orders.length > 0 || !e.def.worker || !e.res) return;
  const r = g.get(e.res);
  if (r && (r.def.kind === 'mineral' || (r.def.refinery && r.owner === e.owner))) e.orders.push({ t: 'gather', target: r.id });
}

// ------------------------------------------------------------------ structures with weapons

function towerUpdate(g: Game, e: Entity): void {
  for (let i = 0; i < e.cds.length; i++) if (e.cds[i] > 0) e.cds[i]--;
  let t = g.get(e.target);
  if (t && (!isValidTarget(g, e, t) || !inWeaponRange(g, e, t, weaponFor(e, t)))) {
    e.target = 0;
    t = undefined;
  }
  if (!t && (g.tick + e.id) % ACQUIRE_INTERVAL === 0) {
    t = findTarget(g, e, acquireRadius(e, g));
    if (t) e.target = t.id;
  }
  if (t) {
    const wi = weaponFor(e, t);
    e.turret = datan2(t.y - e.y, t.x - e.x);
    if (e.cds[wi] <= 0 && inWeaponRange(g, e, t, wi)) fireWeapon(g, e, wi, t);
  }
}

// ------------------------------------------------------------------ units

function unitUpdate(g: Game, e: Entity): void {
  const p = g.players[e.owner];
  for (let i = 0; i < e.cds.length; i++) if (e.cds[i] > 0) e.cds[i]--;
  if (e.lockT > 0) lockUpdate(g, e);
  const kind = e.def.kind;
  if (kind === 'cub') {
    cubWander(g, e);
    return;
  }
  if (kind === 'cocoon' || e.morphTo) return;
  if (e.channelT > 0) {
    e.channelT--;
    return;
  }
  const o = e.orders[0];
  if (e.res && o?.t !== 'gather') {
    // a worker pulled off mining frees its patch for others
    const r = g.byId.get(e.res);
    if (r && r.occupiedBy === e.id) r.occupiedBy = 0;
  }
  if (!o) {
    e.idleT++;
    idle(g, e, p);
    return;
  }
  e.idleT = 0;
  switch (o.t) {
    case 'move':
      return doMove(g, e, o);
    case 'amove':
      return doAttackMove(g, e, p, o.x, o.y, false);
    case 'patrol':
      return doAttackMove(g, e, p, o.x, o.y, true);
    case 'attack':
      return doAttack(g, e, o.target);
    case 'hold':
      e.holdPos = true;
      idle(g, e, p);
      return;
    case 'gather':
      return doGather(g, e, p, o);
    case 'return':
      return doReturn(g, e, p);
    case 'build':
      return doBuild(g, e, p, o);
    case 'construct':
      return doConstruct(g, e, o.target);
    case 'repair':
      return doRepair(g, e, p, o.target);
    case 'ability':
      return doAbility(g, e, o);
    case 'load':
      return doLoad(g, e, o.target);
    case 'pickup':
      return doPickup(g, e, o.target);
    case 'unload':
      return doUnload(g, e, o);
  }
}

function idle(g: Game, e: Entity, p: Player): void {
  if (e.def.id === 'medic') {
    medicHeal(g, e, !e.holdPos);
    return;
  }
  if (!e.def.weapons) return;
  let t = g.get(e.target);
  if (t && !isValidTarget(g, e, t)) {
    e.target = 0;
    t = undefined;
  }
  if (!t && !e.def.worker && (g.tick + e.id) % ACQUIRE_INTERVAL === 0) {
    const radius = e.holdPos ? weaponMaxRange(g, e) : acquireRadius(e, g);
    t = findTarget(g, e, radius);
    if (t) e.target = t.id;
  }
  if (t) {
    if (!engage(g, e, t, !e.holdPos && canMove(g, e))) e.target = 0;
  }
  void p;
}

function weaponMaxRange(g: Game, e: Entity): number {
  let r = 0;
  for (let i = 0; i < (e.def.weapons?.length ?? 0); i++) {
    const w = e.def.weapons![i];
    r = Math.max(r, w.range * TILE + (w.melee ? 6 : 2));
  }
  void g;
  return r;
}

function doMove(g: Game, e: Entity, o: { x: number; y: number; target: number }): void {
  if (o.target) {
    const t = g.get(o.target);
    if (!t) {
      done(e);
      return;
    }
    const arrived = moveTo(g, e, t.x, t.y, e.r + t.r + 12);
    if (arrived && (t.isBuilding || t.isResource || t.owner !== e.owner)) done(e);
    return;
  }
  if (moveTo(g, e, o.x, o.y, e.groupN > 1 ? 3 : 2)) {
    done(e);
    e.arrived = true;
  }
}

function doAttackMove(g: Game, e: Entity, p: Player, x: number, y: number, patrol: boolean): void {
  if (e.def.id === 'medic' && medicHeal(g, e, true)) return;
  if (e.def.weapons) {
    let t = g.get(e.target);
    if (t && (!isValidTarget(g, e, t) || edgeDist(e, t) > acquireRadius(e, g) * 1.6)) {
      e.target = 0;
      t = undefined;
    }
    if ((g.tick + e.id) % ACQUIRE_INTERVAL === 0) {
      // re-evaluate: switch to a better target if the current one isn't in range
      const cur = t;
      if (!cur || !inWeaponRange(g, e, cur, weaponFor(e, cur))) {
        const nt = findTarget(g, e, acquireRadius(e, g));
        if (nt) {
          t = nt;
          e.target = nt.id;
        }
      }
    }
    if (t && engage(g, e, t, true)) return;
  }
  if (moveTo(g, e, x, y, e.groupN > 1 ? 3 : 2)) {
    const o = e.orders[0];
    if (patrol && o && o.t === 'patrol') {
      const nx = o.x2;
      const ny = o.y2;
      o.x2 = o.x;
      o.y2 = o.y;
      o.x = nx;
      o.y = ny;
      e.path = null;
    } else done(e);
  }
  void p;
}

function doAttack(g: Game, e: Entity, targetId: number): void {
  const t = g.get(targetId);
  if (!t) {
    done(e);
    return;
  }
  const team = g.players[e.owner].team;
  if (!canSee(g, team, t)) {
    // chase into the fog briefly, then give up
    e.ost++;
    if (e.ost > 3 * TICK_RATE || !canMove(g, e) || moveTo(g, e, t.x, t.y, 4)) done(e);
    return;
  }
  e.ost = 0;
  e.target = t.id;
  if (weaponFor(e, t) < 0 || !g.isEnemy(e.owner, t.owner)) {
    if (canMove(g, e)) moveTo(g, e, t.x, t.y, e.r + t.r + 8);
    return;
  }
  if (!engage(g, e, t, true)) done(e);
}

// ------------------------------------------------------------------ economy

function nearestMineral(g: Game, x: number, y: number, maxD: number, exclude = 0, freeOnly = false): Entity | undefined {
  let best: Entity | undefined;
  let bd = maxD;
  for (const m of g.structuresNear(x, y, maxD, g.tmp)) {
    if (m.def.kind !== 'mineral' || m.id === exclude) continue;
    if (freeOnly && m.occupiedBy && g.get(m.occupiedBy)) continue;
    const d = dist(m.x, m.y, x, y);
    if (d < bd || (d === bd && best && m.id < best.id)) {
      bd = d;
      best = m;
    }
  }
  return best;
}

function deposit(g: Game, e: Entity, p: Player): void {
  const amt = e.carry * p.incomeMult;
  if (e.carryKind === 1) {
    p.minerals += amt;
    p.stats.mineralsGathered += amt;
  } else if (e.carryKind === 2) {
    p.gas += amt;
    p.stats.gasGathered += amt;
  }
  e.carry = 0;
  e.carryKind = 0;
}

function doGather(g: Game, e: Entity, p: Player, o: { t: 'gather'; target: number }): void {
  if (!e.def.worker) {
    done(e);
    return;
  }
  let r = g.get(o.target);
  if (r && r.def.kind !== 'mineral' && r.def.kind !== 'geyser' && !r.def.refinery) {
    done(e);
    return;
  }
  if (r && r.def.kind === 'geyser') {
    const ref = g.get(r.link);
    if (ref && ref.owner === e.owner) {
      o.target = ref.id;
      r = ref;
    } else {
      done(e);
      return;
    }
  }
  if (!r) {
    // resource depleted: find another mineral near where we were working
    const last = g.byId.get(o.target);
    const nx = last ? last.x : e.x;
    const ny = last ? last.y : e.y;
    const alt = nearestMineral(g, nx, ny, 12 * TILE);
    if (!alt) {
      done(e);
      return;
    }
    o.target = alt.id;
    r = alt;
    e.ost = 0;
  }
  const isGas = !!r.def.refinery;
  if (isGas && (!r.built || r.owner !== e.owner)) {
    done(e);
    return;
  }
  if (e.res !== r.id) {
    const old = g.byId.get(e.res);
    if (old && old.occupiedBy === e.id) old.occupiedBy = 0;
    e.res = r.id;
  }
  if (e.ost === 0 && e.carry > 0 && (e.carryKind !== (isGas ? 2 : 1) || e.carry >= (isGas ? GAS_TRIP : MINERAL_TRIP))) e.ost = 2;
  switch (e.ost) {
    case 0: {
      const d = edgeDist(e, r);
      if (d <= 5) {
        const occ = g.get(r.occupiedBy);
        if (!occ || occ === e) {
          r.occupiedBy = e.id;
          e.path = null;
          if (isGas) {
            e.inside = true;
            e.mineT = GAS_TICKS;
          } else {
            e.mineT = MINE_TICKS;
            e.ost = 1;
            face(e, r);
          }
        } else if (!isGas) {
          const alt = nearestMineral(g, e.x, e.y, 5 * TILE, r.id, true);
          if (alt && dist(alt.x, alt.y, r.x, r.y) < 7 * TILE) {
            o.target = alt.id;
            e.res = alt.id;
          }
        }
      } else moveTo(g, e, r.x, r.y, 0);
      break;
    }
    case 1: {
      e.mineT--;
      if (e.mineT <= 0) {
        const amt = Math.min(MINERAL_TRIP, r.amount);
        r.amount -= amt;
        e.carry = amt;
        e.carryKind = 1;
        r.occupiedBy = 0;
        if (r.amount <= 0 && r.def.kind === 'mineral') g.kill(r);
        e.ost = 2;
      }
      break;
    }
    case 2: {
      if (e.carry <= 0) {
        e.ost = 0;
        break;
      }
      const depot = g.nearestDepot(e.owner, e.x, e.y);
      if (!depot) break;
      if (edgeDist(e, depot) <= 5) {
        deposit(g, e, p);
        e.ost = 0;
        e.path = null;
      } else moveTo(g, e, depot.x, depot.y, 0);
      break;
    }
  }
}

function insideUpdate(g: Game, e: Entity): void {
  e.mineT--;
  const ref = g.get(e.res);
  if (!ref) {
    e.inside = false;
    return;
  }
  if (e.mineT > 0) return;
  const gey = g.get(ref.link);
  const amt = gey ? Math.min(GAS_TRIP, gey.amount) : 0;
  if (gey) gey.amount -= amt;
  e.carry = amt;
  e.carryKind = amt > 0 ? 2 : 0;
  e.inside = false;
  ref.occupiedBy = 0;
  // pop out on the side facing the nearest depot
  const depot = g.nearestDepot(e.owner, ref.x, ref.y);
  const tx = depot ? depot.x : ref.x;
  const ty = depot ? depot.y : ref.y + 100;
  const d = dist(ref.x, ref.y, tx, ty) || 1;
  const ex = ref.x + ((tx - ref.x) / d) * (ref.r + e.r + 4);
  const ey = ref.y + ((ty - ref.y) / d) * (ref.r + e.r + 4);
  const free = g.grid.nearestFreePoint(ex, ey, 1);
  e.x = e.px = free ? free.x : ex;
  e.y = e.py = free ? free.y : ey;
  e.ost = 2;
  if (amt === 0 && e.orders[0]?.t === 'gather') done(e);
}

function doReturn(g: Game, e: Entity, p: Player): void {
  if (e.carry <= 0) {
    done(e);
    resumeGather(g, e);
    return;
  }
  const depot = g.nearestDepot(e.owner, e.x, e.y);
  if (!depot) {
    done(e);
    return;
  }
  if (edgeDist(e, depot) <= 5) {
    deposit(g, e, p);
    done(e);
    resumeGather(g, e);
  } else moveTo(g, e, depot.x, depot.y, 0);
}

function doBuild(g: Game, e: Entity, p: Player, o: { def: string; tx: number; ty: number }): void {
  const d = DEFS[o.def];
  const [w, h] = d.size!;
  const cx = (o.tx + w / 2) * TILE;
  const cy = (o.ty + h / 2) * TILE;
  const race = d.race;
  const siteDist = () => distToRect(e.x, e.y, o.tx * TILE, o.ty * TILE, (o.tx + w) * TILE, (o.ty + h) * TILE);
  let arrived: boolean;
  if (race === 'horde' && !d.refinery) {
    // the forager becomes the building, so it has to stand on the site
    if (!moveTo(g, e, cx, cy, 8)) return;
    arrived = siteDist() <= 4;
  } else {
    arrived = siteDist() - e.r <= (race === 'starborn' ? 2.5 * TILE : 6);
    if (!arrived) {
      if (!moveTo(g, e, cx, cy, 0)) return;
      arrived = siteDist() - e.r <= 3 * TILE;
    }
  }
  if (!arrived) {
    // moveTo stopped at the closest reachable point: retry a couple of times, then give up
    if (++e.ost < 3) {
      e.path = null;
      return;
    }
    g.error(e.owner, "Can't reach the build site");
    done(e);
    resumeGather(g, e);
    return;
  }
  const err = canPlace(g, e.owner, d.id, o.tx, o.ty, e.id) ?? g.affordError(p, d.cost) ?? (g.techMet(p, d.requires) ? null : `Requires ${g.missingTech(p, d.requires)}`);
  if (err) {
    g.error(e.owner, err);
    done(e);
    resumeGather(g, e);
    return;
  }
  g.spend(p, d.cost);
  const b = g.placeBuilding(d.id, e.owner, o.tx, o.ty, false);
  g.events.push({ k: 'placed', id: b.id, owner: e.owner, def: d.id, x: b.x, y: b.y });
  if (race === 'ironpaw') {
    e.orders[0] = { t: 'construct', target: b.id };
    e.ost = 0;
    e.path = null;
    b.builder = e.id;
  } else if (race === 'horde') {
    b.fromWorker = true;
    g.removeSilently(e);
  } else {
    done(e);
    resumeGather(g, e);
  }
}

function doConstruct(g: Game, e: Entity, targetId: number): void {
  const b = g.get(targetId);
  if (!b || b.built || b.owner !== e.owner) {
    done(e);
    resumeGather(g, e);
    return;
  }
  const other = g.get(b.builder);
  if (other && other !== e && other.orders[0]?.t === 'construct' && (other.orders[0] as { target: number }).target === b.id) {
    done(e);
    return;
  }
  if (edgeDist(e, b) > 6) {
    moveTo(g, e, b.x, b.y, 0);
    return;
  }
  e.path = null;
  b.builder = e.id;
  face(e, b);
  advanceConstruction(g, b, 1);
  if ((g.tick + e.id) % 5 === 0) g.events.push({ k: 'spark', x: e.x + (b.x - e.x) * 0.25, y: e.y + (b.y - e.y) * 0.25, id: e.id });
  if (b.built) {
    done(e);
    resumeGather(g, e);
  }
}

export function canRepairTarget(g: Game, e: Entity, t: Entity): boolean {
  if (!g.isAlly(e.owner, t.owner)) return false;
  if (!t.def.attrs.includes('mech')) return false;
  if (t.isBuilding && (!t.built || t.def.race !== 'ironpaw')) return false;
  return t !== e;
}

function doRepair(g: Game, e: Entity, p: Player, targetId: number): void {
  const t = g.get(targetId);
  if (!t || !canRepairTarget(g, e, t)) {
    done(e);
    return;
  }
  const tp = g.players[t.owner];
  const mh = maxHp(t, tp);
  if (t.hp >= mh) {
    done(e);
    resumeGather(g, e);
    return;
  }
  if (edgeDist(e, t) > 6) {
    moveTo(g, e, t.x, t.y, 0);
    return;
  }
  e.path = null;
  face(e, t);
  const rate = Math.min(mh - t.hp, mh / Math.max(1, t.def.time * TICK_RATE));
  const cm = (t.def.cost.m * 0.25 * rate) / mh;
  const cg = (t.def.cost.g * 0.25 * rate) / mh;
  if (p.minerals < cm || p.gas < cg) {
    g.error(e.owner, 'Not enough resources to repair');
    done(e);
    return;
  }
  p.minerals -= cm;
  p.gas -= cg;
  t.hp += rate;
  if ((g.tick + e.id) % 5 === 0) g.events.push({ k: 'spark', x: (e.x + t.x) / 2, y: (e.y + t.y) / 2, id: e.id });
}

function doAbility(g: Game, e: Entity, o: { ab: string; x: number; y: number; target: number }): void {
  const ab = ABILITY_DEFS[o.ab];
  let tx = o.x;
  let ty = o.y;
  let t: Entity | undefined;
  if (o.target) {
    t = g.get(o.target);
    if (!t) {
      done(e);
      return;
    }
    tx = t.x;
    ty = t.y;
  }
  const range = ab.range ? ab.range * TILE : 0;
  if (range > 0) {
    const d = t ? edgeDist(e, t) : dist(e.x, e.y, tx, ty);
    if (d > range) {
      if (!canMove(g, e) || moveTo(g, e, tx, ty, range * 0.9)) {
        if ((t ? edgeDist(e, t) : dist(e.x, e.y, tx, ty)) > range) {
          done(e);
          return;
        }
      } else return;
    }
  }
  e.path = null;
  face(e, { x: tx, y: ty });
  castAbility(g, e, ab, tx, ty, t);
  done(e);
}

// ------------------------------------------------------------------ medic

/** Heal the most hurt biological ally nearby. Returns true while healing/approaching. */
function medicHeal(g: Game, e: Entity, approach: boolean): boolean {
  if (e.energy < 0.5) return false;
  const reach = 4 * TILE;
  const look = approach ? 7 * TILE : reach;
  let best: Entity | undefined;
  let bestScore = 1e18;
  for (const u of g.unitsNear(e.x, e.y, look, g.tmp)) {
    if (u === e || u.air || !g.isAlly(e.owner, u.owner) || !u.def.attrs.includes('bio') || u.def.kind !== 'unit') continue;
    const mh = maxHp(u, g.players[u.owner]);
    if (u.hp >= mh - 0.01) continue;
    const score = u.hp / mh + dist(u.x, u.y, e.x, e.y) / (20 * TILE);
    if (score < bestScore) {
      bestScore = score;
      best = u;
    }
  }
  if (!best) return false;
  if (edgeDist(e, best) > reach) {
    if (!approach) return false;
    moveTo(g, e, best.x, best.y, 0);
    return true;
  }
  e.path = null;
  face(e, best);
  const mh = maxHp(best, g.players[best.owner]);
  const amt = Math.min(12.6 / TICK_RATE, mh - best.hp, e.energy * 3);
  best.hp += amt;
  e.energy -= amt / 3;
  if ((g.tick + e.id) % 4 === 0) g.events.push({ k: 'heal', id: e.id, tid: best.id, x: e.x, y: e.y, tx: best.x, ty: best.y });
  return true;
}

// ------------------------------------------------------------------ cubs

function cubWander(g: Game, e: Entity): void {
  const hive = g.get(e.hive);
  if (!hive) return;
  if (e.wanderT <= 0) {
    e.wanderT = 30 + g.rng.int(70);
    e.pathGoalX = hive.x + (g.rng.next() - 0.5) * hive.tw * TILE * 0.8;
    e.pathGoalY = hive.y1 + 4 + g.rng.next() * 14;
  }
  e.wanderT--;
  const spd = ((e.def.speed ?? 0.5) * TILE) / TICK_RATE;
  const dx = e.pathGoalX - e.x;
  const dy = e.pathGoalY - e.y;
  if (dx * dx + dy * dy > 4) steer(e, e.pathGoalX, e.pathGoalY, spd);
}
