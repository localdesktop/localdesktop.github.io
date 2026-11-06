import { CELLS_PER_TILE, TILE, TOWNHALL_RESOURCE_GAP } from '../constants.ts';
import { DEFS } from '../data/index.ts';
import type { Game } from '../game.ts';

/**
 * Can `owner` place structure `defId` with its top-left tile at (tx, ty)?
 * Returns an error message, or null if the placement is valid.
 */
export function canPlace(g: Game, owner: number, defId: string, tx: number, ty: number, ignoreId = 0): string | null {
  const d = DEFS[defId];
  if (!d || !d.size) return 'Invalid structure';
  const [w, h] = d.size;
  const map = g.map;
  if (tx < 1 || ty < 1 || tx + w > map.w - 1 || ty + h > map.h - 1) return "Can't build there";
  const p = g.players[owner];
  const team = p.team;
  const explored = g.vision.explored[team];

  if (d.refinery) {
    for (const s of g.structuresNear((tx + 1.5) * TILE, (ty + 1.5) * TILE, 8, g.tmp2)) {
      if (s.def.kind === 'geyser' && s.tx === tx && s.ty === ty) {
        if (s.link && g.get(s.link)) return 'This geyser already has a refinery';
        if (!explored[ty * map.w + tx]) return 'Location not explored';
        return null;
      }
    }
    return 'Must be placed on a gas geyser';
  }

  const isHorde = d.race === 'horde';
  let anyComb = false;
  let allComb = true;
  for (let y = ty; y < ty + h; y++) {
    for (let x = tx; x < tx + w; x++) {
      if (!map.buildable(x, y)) return "Can't build there";
      const i = y * map.w + x;
      if (!explored[i]) return 'Location not explored';
      // structures/resources occupying the tile
      const ci = y * CELLS_PER_TILE * g.grid.cw + x * CELLS_PER_TILE;
      if (g.grid.occ[ci] || g.grid.occ[ci + 1] || g.grid.occ[ci + g.grid.cw] || g.grid.occ[ci + g.grid.cw + 1]) return "Can't build there";
      if (g.comb.grid[i]) anyComb = true;
      else allComb = false;
    }
  }
  if (d.needsComb && !allComb) return 'Must be built on honeycomb';
  if (!isHorde && anyComb) return "Can't build on honeycomb";

  if (d.townHall) {
    const x0 = tx - TOWNHALL_RESOURCE_GAP;
    const y0 = ty - TOWNHALL_RESOURCE_GAP;
    const x1 = tx + w + TOWNHALL_RESOURCE_GAP;
    const y1 = ty + h + TOWNHALL_RESOURCE_GAP;
    for (const s of g.structuresNear((tx + w / 2) * TILE, (ty + h / 2) * TILE, 10 * TILE, g.tmp2)) {
      if (!s.isResource) continue;
      if (s.tx < x1 && s.tx + s.tw > x0 && s.ty < y1 && s.ty + s.th > y0) return 'Too close to resources';
    }
  }

  const cx = (tx + w / 2) * TILE;
  const cy = (ty + h / 2) * TILE;
  if (d.needsPower && !g.hasPower(owner, cx, cy)) return 'Must be placed in a Star Totem\'s glow';

  // ground units in the way (own units step aside; enemies and cocoons block)
  const rx0 = tx * TILE;
  const ry0 = ty * TILE;
  const rx1 = (tx + w) * TILE;
  const ry1 = (ty + h) * TILE;
  for (const u of g.unitsNear(cx, cy, Math.max(w, h) * TILE, g.tmp2)) {
    if (u.air || u.id === ignoreId || u.inside) continue;
    const qx = u.x < rx0 ? rx0 : u.x > rx1 ? rx1 : u.x;
    const qy = u.y < ry0 ? ry0 : u.y > ry1 ? ry1 : u.y;
    const dx = u.x - qx;
    const dy = u.y - qy;
    if (dx * dx + dy * dy >= u.r * u.r * 0.8) continue;
    if (u.owner !== owner || u.def.kind === 'cocoon' || u.morphTo) return 'Something is in the way';
  }
  return null;
}
