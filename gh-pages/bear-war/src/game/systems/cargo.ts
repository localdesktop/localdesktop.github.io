// Transports and bunkers: boarding, riding, unloading, and firing out of bunkers.
//
// A carried unit stays in the entity list with `inside` set (like a worker in a
// refinery), so it keeps counting for supply, but nothing can see, hit or collide
// with it. Its position follows the carrier so it reappears in the right place.

import { ACQUIRE_INTERVAL, CELL, TICK_RATE, TILE } from '../constants.ts';
import type { Entity } from '../entity.ts';
import type { Game } from '../game.ts';
import { clearanceFor } from '../grid.ts';
import { dist } from '../math.ts';
import { edgeDist, weaponRangePx } from '../stats.ts';
import { findTarget, fireWeapon, isValidTarget, weaponFor } from './combat.ts';
import { done, moveTo } from './units.ts';

/** How close (edge to edge, px) a unit and its carrier must be to board. */
const BOARD_REACH = 10;
/** Ticks between units dropped by a transport. */
const DROP_TICKS = 3;

/** Slots taken by the units inside carrier c. */
export function cargoUsed(g: Game, c: Entity): number {
  let n = 0;
  for (const id of c.cargo) n += g.get(id)?.def.cargoSize ?? 0;
  return n;
}

/** Can c carry units right now? (Bumblebears need Cargo Pouch; bunkers must be finished.) */
export function canCarry(g: Game, c: Entity): boolean {
  if (!c.alive || !c.def.cargo || c.owner < 0 || c.morphTo) return false;
  if (c.isBuilding && !c.built) return false;
  return !c.def.cargoReq || g.players[c.owner].has(c.def.cargoReq);
}

/** Could unit u board carrier c? With `room`, also checks that it fits right now. */
export function canBoard(g: Game, u: Entity, c: Entity, room = true): boolean {
  if (u === c || !u.alive || u.inside || !u.isUnit || u.air || !u.def.cargoSize || u.morphTo) return false;
  if (u.owner !== c.owner || !canCarry(g, c)) return false;
  if (c.def.cargoBio && !u.def.attrs.includes('bio')) return false;
  return !room || cargoUsed(g, c) + u.def.cargoSize <= c.def.cargo!;
}

function board(g: Game, u: Entity, c: Entity): void {
  const r = g.byId.get(u.res);
  if (r && r.occupiedBy === u.id) r.occupiedBy = 0;
  u.inside = true;
  u.carrier = c.id;
  u.orders = [];
  u.ost = 0;
  u.path = null;
  u.target = 0;
  u.holdPos = false;
  u.wantMove = false;
  u.vx = 0;
  u.vy = 0;
  u.x = c.x;
  u.y = c.y;
  c.cargo.push(u.id);
  g.events.push({ k: 'cargo', id: u.id, carrier: c.id, owner: u.owner, x: c.x, y: c.y, load: true });
}

/** Put u (carried by c) back on the ground near (x,y). False if there is no room within maxR px. */
function dropUnit(g: Game, c: Entity, u: Entity, x: number, y: number, maxR: number): boolean {
  const pt = g.grid.nearestFreePoint(x, y, clearanceFor(u.r), Math.ceil(maxR / CELL) + 2);
  if (!pt || dist(pt.x, pt.y, x, y) > maxR) return false;
  const i = c.cargo.indexOf(u.id);
  if (i >= 0) c.cargo.splice(i, 1);
  u.inside = false;
  u.carrier = 0;
  u.x = u.px = u.lastProgressX = pt.x;
  u.y = u.py = u.lastProgressY = pt.y;
  u.orders = [];
  u.ost = 0;
  u.path = null;
  u.target = 0;
  u.stuckT = 0;
  u.idleT = 0;
  g.events.push({ k: 'cargo', id: u.id, carrier: c.id, owner: u.owner, x: pt.x, y: pt.y, load: false });
  return true;
}

/** Bunkers let units out along their south wall; transports drop them right below. */
function exitPoint(c: Entity, u: Entity, k: number): [number, number] {
  if (c.isBuilding) return [c.x + ((k % 4) - 1.5) * 16, c.y1 + u.r + 4];
  // spread drops a little so units don't all land on one spot
  return [c.x + ((k % 3) - 1) * 12, c.y + (((k / 3) | 0) % 3 - 1) * 12];
}

/** Unload one specific unit right now. */
export function unloadOne(g: Game, c: Entity, u: Entity): boolean {
  const [x, y] = exitPoint(c, u, c.cargo.length);
  return dropUnit(g, c, u, x, y, c.isBuilding ? 6 * TILE : 2 * TILE);
}

/** Bunker: everybody out at once. */
export function unloadAll(g: Game, c: Entity): void {
  let k = 0;
  for (const id of c.cargo.slice()) {
    const u = g.get(id);
    if (!u) continue;
    const [x, y] = exitPoint(c, u, k++);
    dropUnit(g, c, u, x, y, 6 * TILE);
  }
}

/** The carrier is gone: bunkers (and anything removed quietly) let their units out; transports take them down. */
export function releaseCargo(g: Game, c: Entity, killer: Entity | undefined, destroyed: boolean): void {
  let k = 0;
  for (const id of c.cargo.slice()) {
    const u = g.get(id);
    if (!u) continue;
    if (destroyed && !c.isBuilding) {
      u.x = c.x;
      u.y = c.y;
      g.kill(u, killer);
      continue;
    }
    const [x, y] = exitPoint(c, u, k++);
    if (!dropUnit(g, c, u, x, y, 12 * TILE)) g.kill(u, killer);
  }
  c.cargo.length = 0;
}

// ------------------------------------------------------------------ orders

/** Unit order: walk to the transport/bunker and get in. */
export function doLoad(g: Game, e: Entity, targetId: number): void {
  const c = g.get(targetId);
  if (!c || !canBoard(g, e, c)) {
    done(e);
    return;
  }
  if (edgeDist(e, c) <= BOARD_REACH) {
    board(g, e, c);
    return;
  }
  // an idle transport comes over to meet its passenger
  if (!c.isBuilding && c.orders.length === 0) c.orders.push({ t: 'pickup', target: e.id });
  // after reaching the closest reachable point, wait a second before walking again
  if (e.ost > 0 && e.ost < TICK_RATE) {
    e.ost++;
    return;
  }
  e.ost = moveTo(g, e, c.x, c.y, 0) ? 1 : 0;
}

/** Transport order: fly to a friendly unit and pick it up. */
export function doPickup(g: Game, c: Entity, targetId: number): void {
  const u = g.get(targetId);
  if (!u || !canBoard(g, u, c)) {
    done(c);
    return;
  }
  if (edgeDist(c, u) <= BOARD_REACH) {
    board(g, u, c);
    done(c);
    return;
  }
  moveTo(g, c, u.x, u.y, 0);
}

/** Transport order: fly to (x,y), then drop the cargo one unit at a time. */
export function doUnload(g: Game, c: Entity, o: { x: number; y: number }): void {
  if (!c.cargo.length) {
    done(c);
    return;
  }
  if (!moveTo(g, c, o.x, o.y, 3)) return;
  if (c.dropT > 0) {
    c.dropT--;
    return;
  }
  const u = g.get(c.cargo[0]);
  if (!u) {
    c.cargo.shift();
    return;
  }
  if (!unloadOne(g, c, u)) {
    g.error(c.owner, 'Unable to unload here');
    done(c);
    return;
  }
  c.dropT = DROP_TICKS;
  if (!c.cargo.length) done(c);
}

// ------------------------------------------------------------------ riding

/** Per-tick update of a unit inside a transport or bunker. */
export function cargoUpdate(g: Game, e: Entity): void {
  const c = g.get(e.carrier);
  if (!c) {
    // carrier vanished without letting us out (shouldn't happen): climb out here
    e.inside = false;
    e.carrier = 0;
    const pt = g.grid.nearestFreePoint(e.x, e.y, clearanceFor(e.r));
    if (pt) {
      e.x = e.px = pt.x;
      e.y = e.py = pt.y;
    }
    return;
  }
  e.x = c.x;
  e.y = c.y;
  for (let i = 0; i < e.cds.length; i++) if (e.cds[i] > 0) e.cds[i]--;
  if (c.def.bunker && e.def.weapons) bunkerFire(g, e, c);
}

/** Ranged units inside a bunker shoot out of it, with range measured from its walls. */
function bunkerFire(g: Game, e: Entity, c: Entity): void {
  const p = g.players[e.owner];
  const ws = e.def.weapons!;
  const extra = c.def.bunker! * TILE + c.r - e.r;
  const usable = (t: Entity): number => {
    const wi = weaponFor(e, t);
    return wi >= 0 && !ws[wi].melee ? wi : -1;
  };
  const inRange = (t: Entity, wi: number) => edgeDist(e, t) <= weaponRangePx(e, ws[wi], p) + extra + 2;
  let t = g.get(e.target);
  if (t && (!isValidTarget(g, e, t) || usable(t) < 0 || !inRange(t, usable(t)))) {
    e.target = 0;
    t = undefined;
  }
  if (!t && (g.tick + e.id) % ACQUIRE_INTERVAL === 0) {
    let maxR = 0;
    for (const w of ws) if (!w.melee) maxR = Math.max(maxR, weaponRangePx(e, w, p));
    if (maxR <= 0) return;
    const nt = findTarget(g, e, maxR + extra);
    if (nt && usable(nt) >= 0 && inRange(nt, usable(nt))) {
      t = nt;
      e.target = nt.id;
    }
  }
  if (!t) return;
  const wi = usable(t);
  if (e.cds[wi] > 0) return;
  // shoot from the wall facing the target
  const d = dist(c.x, c.y, t.x, t.y) || 1;
  e.x = c.x + ((t.x - c.x) / d) * c.r * 0.8;
  e.y = c.y + ((t.y - c.y) / d) * c.r * 0.8;
  fireWeapon(g, e, wi, t);
  c.lastAttackTick = g.tick;
}

/** Point every unit in a bunker at target t. */
export function focusBunker(g: Game, b: Entity, t: Entity | undefined): void {
  for (const id of b.cargo) {
    const u = g.get(id);
    if (!u) continue;
    u.target = t && isValidTarget(g, u, t) ? t.id : 0;
  }
}
