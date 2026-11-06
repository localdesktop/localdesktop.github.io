// Movement integration and collision resolution. Units push each other apart (idle
// units yield to moving ones, units holding position stand firm) and slide along
// terrain and structures. Mining workers phase through other units, like in classic RTS.

import { CELL, TILE } from '../constants.ts';
import type { Entity } from '../entity.ts';
import type { Game } from '../game.ts';
import { datan2, dcos, dsin, turnToward } from '../math.ts';
import { done } from './units.ts';

const near: Entity[] = [];

export function moveUnits(g: Game): void {
  const ents = g.entities;
  const grid = g.grid;
  const W = g.map.w * TILE;
  const H = g.map.h * TILE;
  // 1. integrate desired velocities
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive || !e.wantMove || e.isBuilding || e.isResource || e.inside) continue;
    const nx = e.x + e.vx;
    const ny = e.y + e.vy;
    if (e.air) {
      e.x = nx;
      e.y = ny;
    } else if (grid.passableAt(nx, ny, 1)) {
      e.x = nx;
      e.y = ny;
    } else if (grid.passableAt(nx, e.y, 1)) {
      e.x = nx;
    } else if (grid.passableAt(e.x, ny, 1)) {
      e.y = ny;
    }
    e.angle = turnToward(e.angle, datan2(e.vy, e.vx), 0.55);
  }

  // 2. stuck detection
  if (g.tick % 10 === 0) {
    for (const e of ents) {
      if (!e.alive || !e.isUnit) continue;
      const moved = Math.abs(e.x - e.lastProgressX) + Math.abs(e.y - e.lastProgressY);
      if (e.wantMove && moved < 3) e.stuckT += 10;
      else e.stuckT = 0;
      e.lastProgressX = e.x;
      e.lastProgressY = e.y;
    }
  }

  // 3. unit-unit separation
  for (let i = 0; i < ents.length; i++) {
    const a = ents[i];
    if (!a.alive || !a.isUnit || a.inside || a.def.burrowed || phasing(a)) continue;
    g.unitsNear(a.x, a.y, a.r + 26, near);
    for (const b of near) {
      if (b.id <= a.id || b.inside || b.air !== a.air || b.def.burrowed || phasing(b)) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const rr = a.air ? (a.r + b.r) * 0.75 : a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      let d = Math.sqrt(d2);
      if (d < 0.01) {
        const ang = ((a.id * 7919 + b.id * 104729) % 628) / 100;
        dx = dcos(ang);
        dy = dsin(ang);
        d = 0;
      } else {
        dx /= d;
        dy /= d;
      }
      // group arrival: moving units stop when they bump into a groupmate that has arrived
      if (a.group && a.group === b.group) {
        if (arrivedCheck(a, b)) done(a);
        else if (arrivedCheck(b, a)) done(b);
      }
      const wa = weight(g, a);
      const wb = weight(g, b);
      const sum = wa + wb;
      if (sum <= 0) continue;
      const overlap = (rr - d) * (a.air ? 0.2 : 0.6);
      a.x -= dx * overlap * (wa / sum);
      a.y -= dy * overlap * (wa / sum);
      b.x += dx * overlap * (wb / sum);
      b.y += dy * overlap * (wb / sum);
    }
  }

  // 4. keep ground units out of terrain/structures, everyone inside the map
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive || !e.isUnit || e.inside) continue;
    if (!e.air) pushOut(g, e);
    if (e.x < e.r) e.x = e.r;
    else if (e.x > W - e.r) e.x = W - e.r;
    if (e.y < e.r) e.y = e.r;
    else if (e.y > H - e.r) e.y = H - e.r;
  }
}

function phasing(e: Entity): boolean {
  if (!e.def.worker) return false;
  const o = e.orders[0];
  return !!o && (o.t === 'gather' || o.t === 'return');
}

/** How easily a unit is pushed (0 = immovable). Bigger units are harder to push. */
function weight(g: Game, e: Entity): number {
  if (e.def.kind === 'cocoon' || e.morphTo || (e.def.speed ?? 0) <= 0) return 0;
  let w: number;
  const o = e.orders[0];
  if (e.holdPos || (o && o.t === 'hold')) w = 0.05;
  else if (!o) w = g.tick - e.lastAttackTick < 15 ? 0.15 : 1;
  else if (!e.wantMove) w = 0.2;
  else w = 0.6;
  return (w * 100) / (e.r * e.r);
}

/** a (moving) arrives if it touches b (stopped, same group) near a's destination. */
function arrivedCheck(a: Entity, b: Entity): boolean {
  const o = a.orders[0];
  if (!o || (o.t !== 'move' && o.t !== 'amove') || o.t === 'move' && o.target) return false;
  if (b.orders.length > 0 && !b.arrived) return false;
  const gx = o.x;
  const gy = o.y;
  const dx = gx - a.x;
  const dy = gy - a.y;
  const r = Math.sqrt(a.groupN) * a.r * 1.6 + 16;
  if (dx * dx + dy * dy > r * r) return false;
  a.arrived = true;
  return true;
}

function pushOut(g: Game, e: Entity): void {
  const grid = g.grid;
  if (!grid.passableAt(e.x, e.y, 1)) {
    const p = grid.nearestFreePoint(e.x, e.y, 1, 30);
    if (p) {
      e.x = p.x;
      e.y = p.y;
      e.path = null;
    }
    return;
  }
  const r = e.r * 0.9;
  const cx0 = Math.floor((e.x - r) / CELL);
  const cx1 = Math.floor((e.x + r) / CELL);
  const cy0 = Math.floor((e.y - r) / CELL);
  const cy1 = Math.floor((e.y + r) / CELL);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (grid.passable(cx, cy, 1)) continue;
      const bx0 = cx * CELL;
      const by0 = cy * CELL;
      const qx = e.x < bx0 ? bx0 : e.x > bx0 + CELL ? bx0 + CELL : e.x;
      const qy = e.y < by0 ? by0 : e.y > by0 + CELL ? by0 + CELL : e.y;
      const dx = e.x - qx;
      const dy = e.y - qy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = r - d;
      e.x += (dx / d) * push;
      e.y += (dy / d) * push;
    }
  }
}
