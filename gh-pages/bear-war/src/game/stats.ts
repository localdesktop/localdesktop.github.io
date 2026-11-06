// Derived unit statistics: upgrades and research modify the base data.

import type { Entity } from './entity.ts';
import type { Player } from './player.ts';
import type { WeaponDef } from './data/types.ts';
import { TICK_RATE, TILE } from './constants.ts';

export function maxHp(e: Entity, p: Player | undefined): number {
  let hp = e.def.hp;
  if (p && e.def.id === 'ranger' && p.has('thickfur')) hp += 10;
  return hp;
}

export function maxShields(e: Entity): number {
  return e.def.shields ?? 0;
}

export function armorOf(e: Entity, p: Player | undefined): number {
  let a = e.def.armor;
  if (p) {
    if (e.def.armorUpg) a += p.level(e.def.armorUpg);
    if (e.def.id === 'cavetitan' && p.has('combarmor')) a += 2;
  }
  return a;
}

export function shieldArmorOf(e: Entity, p: Player | undefined): number {
  return p && e.def.race === 'starborn' ? p.level('aurora') : 0;
}

/** Movement speed in world px per tick (without terrain bonuses). */
export function baseSpeed(e: Entity, p: Player | undefined): number {
  let s = e.def.speed ?? 0;
  if (p) {
    switch (e.def.id) {
      case 'scrapper':
        if (p.has('zoomies')) s *= 1.6;
        break;
      case 'bumblebear':
        if (p.has('biggerwings')) s = 2.63;
        break;
      case 'buzzbomb':
        if (p.has('busybees')) s = 4.13;
        break;
      case 'stinger':
        if (p.has('boundinggait')) s *= 1.25;
        break;
      case 'spiritbear':
        if (p.has('pounce')) s = 4.72;
        break;
    }
  }
  if (e.rushT > 0) s *= 1.5;
  if (e.slowT > 0) s *= 1 - e.slowPct;
  return (s * TILE) / TICK_RATE;
}

export function weaponRangePx(e: Entity, w: WeaponDef, p: Player | undefined): number {
  let r = w.range;
  if (p) {
    if (e.def.id === 'stinger' && p.has('longstingers')) r += 1;
    if (e.def.id === 'polarcolossus' && p.has('longgaze')) r += 2;
  }
  if (e.blindT > 0 && !w.melee) r = Math.min(r, 1);
  return r * TILE;
}

/** Damage per hit of weapon `w` (owned by player p) against target t. */
export function weaponDamage(p: Player | undefined, w: WeaponDef, t: Entity): number {
  const lvl = p && w.upg ? p.level(w.upg) : 0;
  let dmg = w.dmg + lvl * (w.upgDmg ?? 1);
  if (w.bonus) {
    for (const a of t.def.attrs) {
      const b = w.bonus[a];
      if (b) dmg += b + lvl * (w.upgBonus ?? 0);
    }
  }
  return dmg;
}

export function cooldownTicks(e: Entity, w: WeaponDef): number {
  let cd = w.cd * TICK_RATE;
  if (e.rushT > 0) cd /= 1.5;
  return Math.max(1, Math.round(cd));
}

export function canTarget(w: WeaponDef, t: Entity): boolean {
  if (w.unitsOnly && t.isBuilding) return false;
  if (w.targets === 'both') return true;
  return w.targets === 'air' ? t.air : !t.air;
}

/** Edge-to-edge distance between two entities (buildings use their footprint). */
export function edgeDist(a: Entity, b: Entity): number {
  if (b.isBuilding || b.isResource) {
    const dx = a.x < b.x0 ? b.x0 - a.x : a.x > b.x1 ? a.x - b.x1 : 0;
    const dy = a.y < b.y0 ? b.y0 - a.y : a.y > b.y1 ? a.y - b.y1 : 0;
    return Math.sqrt(dx * dx + dy * dy) - a.r;
  }
  if (a.isBuilding) {
    const dx = b.x < a.x0 ? a.x0 - b.x : b.x > a.x1 ? b.x - a.x1 : 0;
    const dy = b.y < a.y0 ? a.y0 - b.y : b.y > a.y1 ? b.y - a.y1 : 0;
    return Math.sqrt(dx * dx + dy * dy) - b.r;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) - a.r - b.r;
}
