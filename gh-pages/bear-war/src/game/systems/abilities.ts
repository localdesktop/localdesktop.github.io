import { TICK_RATE, TILE } from '../constants.ts';
import { ABILITY_DEFS } from '../data/index.ts';
import type { AbilityDef } from '../data/types.ts';
import type { Entity } from '../entity.ts';
import type { Game } from '../game.ts';
import { datan2, dist } from '../math.ts';
import type { AreaEffect } from '../types.ts';
import { applyHit, canSee, dealDamage } from './combat.ts';
import { clearanceFor } from '../grid.ts';
import { finishMorph } from './structures.ts';

const SPIRIT_SPEED = (5.6 * TILE) / TICK_RATE;
const SNOWBALL_SPEED = (4.5 * TILE) / TICK_RATE;
const LOCK_TICKS = 12 * TICK_RATE;
const LOCK_LEASH = 14 * TILE;

function checkCost(g: Game, e: Entity, ab: AbilityDef): string | null {
  const p = g.players[e.owner];
  if (ab.requires && !p.has(ab.requires)) return `Requires ${ab.name} research`;
  if (!g.techMet(p, ab.needs)) return `Requires ${g.missingTech(p, ab.needs)}`;
  if (ab.energy && e.energy < ab.energy) return 'Not enough energy';
  if (e.cooldowns[ab.id] > 0) return 'Ability is cooling down';
  return null;
}

function announce(g: Game, e: Entity, ab: string, tx = e.x, ty = e.y): void {
  g.events.push({ k: 'ability', owner: e.owner, ab, x: e.x, y: e.y, id: e.id, tx, ty });
}

/** Start switching e into another mode; instant modes switch right away. */
function startMode(g: Game, e: Entity, ab: AbilityDef): void {
  const m = ab.mode!;
  if (ab.energy) e.energy -= ab.energy;
  e.morphTo = m.to;
  e.morphCost = null;
  e.orders = [];
  e.path = null;
  e.target = 0;
  if (m.time > 0) {
    e.morphT = 0;
    e.morphTotal = Math.round(m.time * TICK_RATE);
  } else finishMorph(g, e, g.players[e.owner]);
  announce(g, e, ab.id);
}

/** Abilities without a target (honey rush, mode switches, smash, royal jelly). */
export function useInstant(g: Game, e: Entity, abId: string): string | null {
  const ab = ABILITY_DEFS[abId];
  if (ab.mode) {
    if (e.morphTo || e.def.id === ab.mode.to) return null;
    const err = checkCost(g, e, ab);
    if (!err) startMode(g, e, ab);
    return err;
  }
  switch (abId) {
    case 'honeyrush': {
      if (!g.players[e.owner].has('honeyrush')) return 'Requires Honey Rush research';
      const cost = e.def.id === 'grizzly' ? 20 : 10;
      if (e.hp <= cost) return null;
      e.hp -= cost;
      e.rushT = 11 * TICK_RATE;
      announce(g, e, abId);
      return null;
    }
    case 'smash': {
      const w = e.def.weapons?.[0];
      if (!w) return null;
      applyHit(g, e.owner, w, undefined, e, e.x, e.y, 1);
      g.kill(e);
      return null;
    }
    case 'royaljelly': {
      if (!e.built) return 'Structure is not finished';
      if (e.jellyT > 0) return 'Royal Jelly is already working';
      if (e.energy < 25) return 'Not enough energy';
      e.energy -= 25;
      e.jellyT = 29 * TICK_RATE;
      announce(g, e, abId);
      return null;
    }
  }
  return null;
}

/** Targeted abilities, executed once the caster is in range. */
export function castAbility(g: Game, e: Entity, ab: AbilityDef, tx: number, ty: number, t: Entity | undefined): void {
  const err = checkCost(g, e, ab);
  if (err) {
    g.error(e.owner, err);
    return;
  }
  const team = g.players[e.owner].team;
  const fx = (kind: AreaEffect['kind'], r: number, dur: number, target = 0, x = tx, y = ty): AreaEffect => {
    const a: AreaEffect = { id: g.nextFxId++, kind, x, y, r, owner: e.owner, team, t: dur, total: dur, src: e.id, target };
    g.effects.push(a);
    return a;
  };
  const ticks = (s: number | undefined) => Math.round((s ?? 0) * TICK_RATE);
  const enemyUnit = (air?: boolean) => {
    if (t && t.isUnit && g.isEnemy(e.owner, t.owner) && (air === undefined || t.air === air)) return true;
    g.error(e.owner, air ? 'Must target an enemy flyer' : 'Must target an enemy unit');
    return false;
  };
  if (ab.mode) {
    if (e.morphTo) return;
    e.zoneX = tx;
    e.zoneY = ty;
    startMode(g, e, ab);
    return;
  }
  switch (ab.id) {
    case 'sniff':
    case 'revelation':
      fx('sniff', (ab.radius ?? 13) * TILE, ticks(ab.duration));
      break;
    case 'bubble':
      if (!t || !g.isAlly(e.owner, t.owner) || t.isBuilding) {
        g.error(e.owner, 'Must target a friendly unit');
        return;
      }
      t.bubble = 100;
      t.bubbleT = ticks(ab.duration);
      break;
    case 'staticburst': {
      const r = (ab.radius ?? 1.5) * TILE;
      for (const u of g.unitsNear(tx, ty, r, g.tmp2)) {
        if (!g.isEnemy(e.owner, u.owner)) continue;
        u.shields = Math.max(0, u.shields - 100);
        u.energy = Math.max(0, u.energy - 100);
      }
      fx('staticburst', r, 12);
      break;
    }
    case 'grandcannon':
      if (!t || !g.isEnemy(e.owner, t.owner)) {
        g.error(e.owner, 'Must target an enemy');
        return;
      }
      e.channelT = 2 * TICK_RATE;
      fx('grandshot', 0, 2 * TICK_RATE, t.id);
      break;
    case 'lockon':
      if (!enemyUnit()) return;
      e.lockT = LOCK_TICKS;
      e.lockTarget = t!.id;
      break;
    case 'beecloud':
    case 'stingswarm':
    case 'starfall':
    case 'pollen':
      fx(ab.id, (ab.radius ?? 2) * TILE, ticks(ab.duration));
      break;
    case 'hornetbomb':
      if (!enemyUnit(true)) return;
      fx('hornets', (ab.radius ?? 3) * TILE, ticks(ab.duration), t!.id, t!.x, t!.y);
      break;
    case 'scaldinghoney':
      fx('honeyglob', (ab.radius ?? 0.75) * TILE, ticks(ab.duration));
      break;
    case 'yank': {
      if (!t || !t.isUnit || t === e || t.def.kind !== 'unit') {
        g.error(e.owner, 'Must target a unit');
        return;
      }
      const d = dist(e.x, e.y, t.x, t.y) || 1;
      let nx = e.x + ((t.x - e.x) / d) * (e.r + t.r + 4);
      let ny = e.y + ((t.y - e.y) / d) * (e.r + t.r + 4);
      if (!t.air) {
        const p = g.grid.nearestFreePoint(nx, ny, clearanceFor(t.r), 12);
        if (!p) {
          g.error(e.owner, "Can't pull that unit here");
          return;
        }
        nx = p.x;
        ny = p.y;
      }
      g.events.push({ k: 'fire', id: e.id, tid: t.id, fx: 'tongue', x: e.x, y: e.y, tx: t.x, ty: t.y, owner: e.owner, air: t.air });
      t.x = nx;
      t.y = ny;
      t.path = null;
      break;
    }
    case 'releasecubs':
      for (let i = 0; i < 2; i++) {
        const c = g.spawnUnit('wildcub', e.owner, e.x + (i ? 10 : -10), e.y + e.r);
        c.orders = [{ t: 'amove', x: tx, y: ty }];
      }
      break;
    case 'spiritwalk': {
      const path = g.grid.findPath(e.x, e.y, tx, ty, clearanceFor(e.r)) ?? [];
      fx('spirit', e.r, ticks(ab.duration), 0, e.x, e.y).path = path;
      break;
    }
    case 'snowball': {
      const d = dist(e.x, e.y, tx, ty);
      const range = (ab.range ?? 9) * TILE;
      const k = d > range ? range / d : 1;
      fx('snowball', (ab.radius ?? 1.5) * TILE, 2 * TICK_RATE, 0, e.x, e.y).path = [e.x + (tx - e.x) * k, e.y + (ty - e.y) * k];
      break;
    }
    case 'haste':
      if (!t || !t.isBuilding || t.owner !== e.owner || !t.built) {
        g.error(e.owner, 'Must target one of your structures');
        return;
      }
      t.hasteT = ticks(ab.duration);
      break;
    case 'moonstep': {
      const range = (ab.range ?? 8) * TILE;
      let dx = tx - e.x;
      let dy = ty - e.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > range) {
        dx = (dx / d) * range;
        dy = (dy / d) * range;
      }
      const dest = g.grid.nearestFreePoint(e.x + dx, e.y + dy, clearanceFor(e.r), 6);
      if (!dest) {
        g.error(e.owner, "Can't step there");
        return;
      }
      teleport(g, e, dest.x, dest.y);
      break;
    }
    default:
      return;
  }
  if (ab.energy) e.energy -= ab.energy;
  if (ab.cooldown) e.cooldowns[ab.id] = ticks(ab.cooldown);
  announce(g, e, ab.id, tx, ty);
}

function teleport(g: Game, e: Entity, x: number, y: number): void {
  g.events.push({ k: 'blink', id: e.id, x0: e.x, y0: e.y, x1: x, y1: y, owner: e.owner });
  e.x = e.px = x;
  e.y = e.py = y;
  e.path = null;
}

/** Tracker lock-on: steady damage while the target stays close and in sight. */
export function lockUpdate(g: Game, e: Entity): void {
  const t = g.get(e.lockTarget);
  if (!t || t.inside || dist(e.x, e.y, t.x, t.y) > LOCK_LEASH || !canSee(g, g.players[e.owner].team, t)) {
    e.lockT = 0;
    return;
  }
  e.lockT--;
  e.turret = datan2(t.y - e.y, t.x - e.x);
  dealDamage(g, t, 300 / LOCK_TICKS, 1, e, e.owner, false);
  if (e.lockT % 6 === 0) g.events.push({ k: 'fire', id: e.id, tid: t.id, fx: 'lockon', x: e.x, y: e.y, tx: t.x, ty: t.y, owner: e.owner, air: t.air });
}

/** Move a travelling effect along its waypoints at speed `spd` (px per tick). */
function travel(fx: AreaEffect, spd: number): void {
  const p = fx.path;
  let left = spd;
  while (p && p.length && left > 0) {
    const dx = p[0] - fx.x;
    const dy = p[1] - fx.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= left) {
      fx.x = p[0];
      fx.y = p[1];
      p.splice(0, 2);
      left -= d;
    } else {
      fx.x += (dx / d) * left;
      fx.y += (dy / d) * left;
      left = 0;
    }
  }
}

export function updateEffects(g: Game): void {
  let w = 0;
  for (const fx of g.effects) {
    fx.t--;
    switch (fx.kind) {
      case 'stingswarm': {
        const per = 120 / (8 * TICK_RATE);
        const victims = [...g.unitsNear(fx.x, fx.y, fx.r, g.tmp2), ...g.structuresNear(fx.x, fx.y, fx.r, [])];
        for (const v of victims) {
          if (!v.alive || v.isResource || !g.isEnemy(fx.owner, v.owner)) continue;
          if (v.shields > 0) v.shields = Math.max(0, v.shields - per);
          else if (v.hp > 1) v.hp = Math.max(1, v.hp - per);
          v.lastHit = g.tick;
        }
        break;
      }
      case 'starfall': {
        const per = 80 / fx.total;
        for (const v of g.unitsNear(fx.x, fx.y, fx.r, g.tmp2)) {
          if (!v.alive || v.isBuilding || v.inside || v.owner < 0) continue;
          if (dist(v.x, v.y, fx.x, fx.y) > fx.r + v.r * 0.5) continue;
          dealDamage(g, v, per, 1, g.get(fx.src), fx.owner, true);
        }
        break;
      }
      case 'pollen':
        for (const v of g.unitsNear(fx.x, fx.y, fx.r, g.tmp2)) if (!v.air && g.isEnemy(fx.owner, v.owner)) v.blindT = 2;
        break;
      case 'hornets': {
        const host = g.get(fx.target);
        if (!host || host.inside) {
          fx.t = 0;
          break;
        }
        fx.x = host.x;
        fx.y = host.y;
        for (const v of g.unitsNear(fx.x, fx.y, fx.r, g.tmp2)) {
          if (v.air && g.isEnemy(fx.owner, v.owner)) dealDamage(g, v, 120 / fx.total, 1, g.get(fx.src), fx.owner, true);
        }
        break;
      }
      case 'honeyglob':
        if (fx.t <= 0) {
          g.events.push({ k: 'splash', fx: 'honey', x: fx.x, y: fx.y, r: fx.r });
          const victims = [...g.unitsNear(fx.x, fx.y, fx.r, g.tmp2), ...g.structuresNear(fx.x, fx.y, fx.r, [])];
          for (const v of victims) if (!v.inside && !v.isResource && g.isEnemy(fx.owner, v.owner)) dealDamage(g, v, 60, 1, g.get(fx.src), fx.owner, false);
        }
        break;
      case 'spirit': {
        travel(fx, SPIRIT_SPEED);
        const e = g.get(fx.src);
        if (!e || e.inside || e.morphTo) fx.t = 0;
        else if (fx.t <= 0) {
          const p = g.grid.nearestFreePoint(fx.x, fx.y, clearanceFor(e.r), 6);
          if (p) teleport(g, e, p.x, p.y);
        }
        break;
      }
      case 'snowball':
        travel(fx, SNOWBALL_SPEED);
        if (fx.t <= 0) {
          g.events.push({ k: 'splash', fx: 'snowball', x: fx.x, y: fx.y, r: fx.r });
          for (const v of g.unitsNear(fx.x, fx.y, fx.r, g.tmp2)) {
            if (v.air || v.inside || v.id === fx.src || v.owner < 0 || v.def.kind !== 'unit') continue;
            v.shields = Math.max(0, v.shields - 55);
            dealDamage(g, v, 145, 1, g.get(fx.src), fx.owner, false);
          }
        }
        break;
      case 'grandshot':
        if (fx.t <= 0) {
          const src = g.get(fx.src);
          const t = g.get(fx.target);
          if (src && t) {
            g.events.push({ k: 'fire', id: src.id, tid: t.id, fx: 'grandshot', x: src.x, y: src.y, tx: t.x, ty: t.y, owner: src.owner, air: t.air });
            dealDamage(g, t, 240, 1, src, src.owner, true);
            g.events.push({ k: 'hit', fx: 'grandshot', x: t.x, y: t.y, tid: t.id, shield: false });
          }
        }
        break;
    }
    if (fx.t > 0) g.effects[w++] = fx;
  }
  g.effects.length = w;
}

/** Seer Sunlance: drain energy while lit, douse at zero. */
export function drainUpdate(g: Game, e: Entity): void {
  e.energy -= e.def.drain! / TICK_RATE;
  if (e.energy > 0 || e.morphTo) return;
  e.energy = 0;
  e.morphTo = e.def.base!;
  finishMorph(g, e, g.players[e.owner]);
}

