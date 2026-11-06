import { TICK_RATE, TILE } from '../constants.ts';
import type { WeaponDef } from '../data/types.ts';
import type { Entity } from '../entity.ts';
import type { Game } from '../game.ts';
import { datan2, dcos, dist, dsin } from '../math.ts';
import {
  armorOf, canTarget, cooldownTicks, edgeDist, shieldArmorOf, weaponDamage, weaponRangePx,
} from '../stats.ts';
import type { Projectile } from '../types.ts';

const ALERT_COOLDOWN = 15 * TICK_RATE;

/** Can team `team` currently see (and, if cloaked, detect) entity e? */
export function canSee(g: Game, team: number, e: Entity): boolean {
  if (!e.alive || e.inside) return false;
  if (e.owner >= 0 && g.players[e.owner].team === team) return true;
  if (e.isBuilding || e.isResource) {
    // visible if any corner or the centre is visible
    const v = g.vision;
    if (
      !v.visibleAt(team, e.x, e.y) && !v.visibleAt(team, e.x0 + 4, e.y0 + 4) && !v.visibleAt(team, e.x1 - 4, e.y0 + 4) &&
      !v.visibleAt(team, e.x0 + 4, e.y1 - 4) && !v.visibleAt(team, e.x1 - 4, e.y1 - 4)
    ) return false;
    return true;
  }
  if (!g.vision.visibleAt(team, e.x, e.y)) return false;
  if (e.def.cloaked && !g.vision.detectedAt(team, e.x, e.y)) return false;
  return true;
}

/** Index of the first weapon of attacker `e` able to hit `t`, or -1. */
export function weaponFor(e: Entity, t: Entity): number {
  const ws = e.def.weapons;
  if (!ws) return -1;
  for (let i = 0; i < ws.length; i++) if (canTarget(ws[i], t)) return i;
  return -1;
}

export function isValidTarget(g: Game, e: Entity, t: Entity | undefined): t is Entity {
  if (!t || !t.alive || t.inside || t.isResource) return false;
  if (!g.isEnemy(e.owner, t.owner)) return false;
  if (!canSee(g, g.players[e.owner].team, t)) return false;
  return weaponFor(e, t) >= 0;
}

function priorityOf(t: Entity): number {
  const d = t.def;
  if (d.priority !== undefined) return d.priority;
  if (t.isBuilding) return d.weapons ? 15 : 6;
  if (d.worker) return 17;
  if (d.weapons || d.energy) return 20;
  return 12;
}

/**
 * Find the best enemy target within `radius` (px, edge distance) of e.
 * Prefers higher priority, then targets already in weapon range, then closest.
 */
export function findTarget(g: Game, e: Entity, radius: number): Entity | undefined {
  const team = g.players[e.owner].team;
  let best: Entity | undefined;
  let bestScore = -1e18;
  const p = g.players[e.owner];
  const consider = (t: Entity) => {
    if (t === e || !t.alive || t.inside || t.isResource || t.owner < 0) return;
    if (!g.isEnemy(e.owner, t.owner)) return;
    const wi = weaponFor(e, t);
    if (wi < 0) return;
    const d = edgeDist(e, t);
    if (d > radius) return;
    const w = e.def.weapons![wi];
    if (w.minRange && d < w.minRange * TILE) return;
    if (!inZone(e, w, t)) return;
    if (!canSee(g, team, t)) return;
    const inRange = d <= weaponRangePx(e, w, p) ? 1 : 0;
    const score = priorityOf(t) * 100000 + inRange * 50000 - d * 10 - (t.hp + t.shields) * 0.01;
    if (score > bestScore || (score === bestScore && best && t.id < best.id)) {
      bestScore = score;
      best = t;
    }
  };
  for (const t of g.unitsNear(e.x, e.y, radius + e.r, g.tmp)) consider(t);
  for (const t of g.structuresNear(e.x, e.y, radius + e.r, g.tmp)) consider(t);
  return best;
}

export function acquireRadius(e: Entity, g: Game): number {
  const ws = e.def.weapons;
  if (!ws) return 0;
  const p = g.players[e.owner];
  let maxR = 0;
  for (const w of ws) maxR = Math.max(maxR, weaponRangePx(e, w, p));
  if (e.isBuilding) return maxR;
  // units notice enemies within most of their sight range (melee units included)
  return Math.max(maxR + 1.5 * TILE, e.def.sight * TILE * 0.8);
}

/** Anchored weapons only reach targets inside the anchor zone. */
function inZone(e: Entity, w: WeaponDef, t: Entity): boolean {
  return !w.zone || dist(e.zoneX, e.zoneY, t.x, t.y) <= w.zone * TILE + t.r * 0.5;
}

/** Is target within range of weapon wi? */
export function inWeaponRange(g: Game, e: Entity, t: Entity, wi: number): boolean {
  const w = e.def.weapons![wi];
  if (w.zone) return inZone(e, w, t);
  const d = edgeDist(e, t);
  const range = weaponRangePx(e, w, g.players[e.owner]) + (w.melee ? 6 : 2);
  if (w.minRange && d < w.minRange * TILE) return false;
  return d <= range;
}

/** Fire weapon wi at target t (assumes in range and ready). */
export function fireWeapon(g: Game, e: Entity, wi: number, t: Entity): void {
  const w = e.def.weapons![wi];
  e.cds[wi] = cooldownTicks(e, w);
  e.lastAttackTick = g.tick;
  const ang = datan2(t.y - e.y, t.x - e.x);
  e.turret = ang;
  if (!e.isBuilding && !e.def.turret) e.angle = ang;
  if (w.line) {
    lineHit(g, e, w, ang);
  } else if (w.proj) {
    const speed = ((w.projSpeed ?? 15) * TILE) / TICK_RATE;
    const pr: Projectile = {
      id: g.nextFxId++, x: e.x, y: e.y, px: e.x, py: e.y, tx: t.x, ty: t.y, target: t.id, speed,
      owner: e.owner, src: e.id, w, mult: 1, bounces: w.bounce?.n ?? 0, hit: [], air: t.air, alive: true, age: 0,
    };
    g.projectiles.push(pr);
    g.events.push({ k: 'fire', id: e.id, tid: t.id, fx: w.fx, x: e.x, y: e.y, tx: t.x, ty: t.y, owner: e.owner, air: t.air });
  } else {
    g.events.push({ k: 'fire', id: e.id, tid: t.id, fx: w.fx, x: e.x, y: e.y, tx: t.x, ty: t.y, owner: e.owner, air: t.air });
    applyHit(g, e.owner, w, t, e, t.x, t.y, 1);
  }
  if (w.suicide) g.kill(e);
}

/** Spines along a line out to full range: every enemy ground unit and structure on it is hit. */
function lineHit(g: Game, e: Entity, w: WeaponDef, ang: number): void {
  const len = weaponRangePx(e, w, g.players[e.owner]) + e.r;
  const dx = dcos(ang);
  const dy = dsin(ang);
  const ex = e.x + dx * len;
  const ey = e.y + dy * len;
  g.events.push({ k: 'fire', id: e.id, tid: 0, fx: w.fx, x: e.x, y: e.y, tx: ex, ty: ey, owner: e.owner, air: false });
  const mx = (e.x + ex) / 2;
  const my = (e.y + ey) / 2;
  const victims = [...g.unitsNear(mx, my, len / 2, g.tmp2), ...g.structuresNear(mx, my, len / 2, [])];
  for (const v of victims) {
    if (!v.alive || v.inside || v.isResource || !g.isEnemy(e.owner, v.owner) || !canTarget(w, v)) continue;
    const along = Math.max(0, Math.min(len, (v.x - e.x) * dx + (v.y - e.y) * dy));
    const off = dist(e.x + dx * along, e.y + dy * along, v.x, v.y) - (v.isBuilding ? Math.min(v.tw, v.th) * TILE * 0.5 : v.r);
    if (off > w.line! * TILE) continue;
    dealDamage(g, v, weaponDamage(g.players[e.owner], w, v), w.hits ?? 1, e, e.owner, false);
    g.events.push({ k: 'hit', fx: w.fx, x: v.x, y: v.y, tid: v.id, shield: v.shields > 0 });
  }
}

/** Is a ground unit currently protected by Bee Cloud? */
function inSpores(g: Game, t: Entity): boolean {
  if (t.air || t.isBuilding) return false;
  for (const fx of g.effects) {
    if (fx.kind !== 'beecloud') continue;
    const dx = t.x - fx.x;
    const dy = t.y - fx.y;
    if (dx * dx + dy * dy <= fx.r * fx.r) return true;
  }
  return false;
}

/** Apply a weapon hit on t at (ix,iy), including splash. */
export function applyHit(g: Game, owner: number, w: WeaponDef, t: Entity | undefined, attacker: Entity | undefined, ix: number, iy: number, mult: number): void {
  const p = g.players[owner];
  if (t && t.alive) {
    const blocked = !w.melee && inSpores(g, t);
    if (!blocked) {
      const dmg = weaponDamage(p, w, t) * mult;
      dealDamage(g, t, dmg, w.hits ?? 1, attacker, owner, false);
      if (w.slow && t.alive && !t.isBuilding) {
        t.slowT = Math.round(w.slow.dur * TICK_RATE);
        t.slowPct = w.slow.pct;
      }
    }
    g.events.push({ k: 'hit', fx: w.fx, x: t.x, y: t.y, tid: t.id, shield: t.shields > 0 });
  }
  if (w.splash) {
    const maxR = w.splash.r[w.splash.r.length - 1] * TILE;
    g.events.push({ k: 'splash', fx: w.fx, x: ix, y: iy, r: maxR });
    const victims: Entity[] = [];
    for (const v of g.unitsNear(ix, iy, maxR, g.tmp2)) victims.push(v);
    for (const v of g.structuresNear(ix, iy, maxR, g.tmp2)) victims.push(v);
    for (const v of victims) {
      if (v === t || v === attacker || !v.alive || v.isResource || v.inside) continue;
      if (!canTarget(w, v)) continue;
      const enemy = g.isEnemy(owner, v.owner);
      if (!enemy && !(w.splash.friendly && v.owner >= 0)) continue;
      // distance from impact point to the victim's edge
      let d: number;
      if (v.isBuilding) {
        const dx = ix < v.x0 ? v.x0 - ix : ix > v.x1 ? ix - v.x1 : 0;
        const dy = iy < v.y0 ? v.y0 - iy : iy > v.y1 ? iy - v.y1 : 0;
        d = Math.sqrt(dx * dx + dy * dy);
      } else {
        const dx = v.x - ix;
        const dy = v.y - iy;
        d = Math.max(0, Math.sqrt(dx * dx + dy * dy) - v.r * 0.5);
      }
      let pct = 0;
      for (let i = 0; i < w.splash.r.length; i++) {
        if (d <= w.splash.r[i] * TILE) {
          pct = w.splash.pct[i];
          break;
        }
      }
      if (pct <= 0) continue;
      dealDamage(g, v, weaponDamage(p, w, v) * pct * mult, w.hits ?? 1, attacker, owner, false);
    }
  }
}

/**
 * Deal damage. Each of `hits` hits is reduced by armor (minimum 0.5).
 * Shields absorb damage first (reduced by shield armor). `pure` ignores armor.
 */
export function dealDamage(g: Game, t: Entity, dmg: number, hits: number, attacker: Entity | undefined, owner: number, pure: boolean): void {
  if (!t.alive || dmg <= 0) return;
  const tp = g.players[t.owner];
  const armor = pure ? 0 : armorOf(t, tp);
  const sArmor = pure ? 0 : shieldArmorOf(t, tp);
  for (let h = 0; h < hits; h++) {
    let d = dmg;
    if (t.bubble > 0) {
      const a = Math.min(t.bubble, d);
      t.bubble -= a;
      d -= a;
      if (d <= 0) continue;
    }
    if (t.shields > 0) {
      const sd = Math.max(0.5, d - sArmor);
      if (sd <= t.shields) {
        t.shields -= sd;
        continue;
      }
      d = sd - t.shields;
      t.shields = 0;
      t.hp -= pure ? d : Math.max(0.5, d - armor);
    } else {
      t.hp -= Math.max(0.5, d - armor);
    }
  }
  t.lastHit = g.tick;
  if (t.owner >= 0 && owner >= 0 && g.isEnemy(owner, t.owner)) {
    const tp2 = g.players[t.owner];
    if (g.tick - tp2.lastAttackAlert > ALERT_COOLDOWN) {
      tp2.lastAttackAlert = g.tick;
      g.events.push({ k: 'alert', owner: t.owner, kind: t.isBuilding || t.def.worker ? 'base' : 'attack', x: t.x, y: t.y });
    }
    // idle units fight back
    if (attacker && attacker.alive && !t.isBuilding && t.orders.length === 0 && !t.target && t.def.weapons) {
      if (isValidTarget(g, t, attacker)) t.target = attacker.id;
    }
  }
  if (t.hp <= 0.001) g.kill(t, attacker);
}

export function updateProjectiles(g: Game): void {
  for (const pr of g.projectiles) {
    if (!pr.alive) continue;
    pr.age++;
    const t = g.get(pr.target);
    if (t && !t.inside) {
      pr.tx = t.x;
      pr.ty = t.y;
    }
    const dx = pr.tx - pr.x;
    const dy = pr.ty - pr.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= pr.speed || pr.age > 200) {
      pr.x = pr.tx;
      pr.y = pr.ty;
      pr.alive = false;
      impact(g, pr, t);
    } else {
      pr.x += (dx / d) * pr.speed;
      pr.y += (dy / d) * pr.speed;
    }
  }
}

function impact(g: Game, pr: Projectile, t: Entity | undefined): void {
  const src = g.get(pr.src);
  applyHit(g, pr.owner, pr.w, t && !t.inside ? t : undefined, src, pr.x, pr.y, pr.mult);
  if (pr.bounces > 0 && t) {
    pr.hit.push(t.id);
    const b = pr.w.bounce!;
    const team = g.players[pr.owner].team;
    let next: Entity | undefined;
    let bestD = 1e18;
    for (const c of g.unitsNear(t.x, t.y, b.range * TILE, g.tmp)) {
      if (pr.hit.includes(c.id) || !g.isEnemy(pr.owner, c.owner) || !canTarget(pr.w, c) || !canSee(g, team, c)) continue;
      const dd = (c.x - t.x) * (c.x - t.x) + (c.y - t.y) * (c.y - t.y);
      if (dd < bestD) {
        bestD = dd;
        next = c;
      }
    }
    if (next) {
      g.projectiles.push({
        id: g.nextFxId++, x: t.x, y: t.y, px: t.x, py: t.y, tx: next.x, ty: next.y, target: next.id, speed: pr.speed,
        owner: pr.owner, src: pr.src, w: pr.w, mult: pr.mult / b.falloff, bounces: pr.bounces - 1, hit: pr.hit, air: next.air,
        alive: true, age: 0,
      });
    }
  }
}
