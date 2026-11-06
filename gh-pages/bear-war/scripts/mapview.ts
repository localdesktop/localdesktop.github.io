// Prints a map as ASCII for quick layout iteration:  node scripts/mapview.ts [mapId]
import { buildMapWithWarnings, MAPS } from '../src/game/map/maps.ts';
import { F_CLIFF, F_RAMP, F_ROCK, F_WATER, F_EDGE, F_ROUGH } from '../src/game/map/gamemap.ts';

const id = process.argv[2] ?? MAPS[0].id;
const { map, warnings } = buildMapWithWarnings(id);
const grid: string[][] = [];
for (let y = 0; y < map.h; y++) {
  const row: string[] = [];
  for (let x = 0; x < map.w; x++) {
    const f = map.flags[y * map.w + x];
    const e = map.elev[y * map.w + x];
    let c = e === 2 ? '^' : e === 1 ? '-' : '.';
    if (f & F_RAMP) c = '/';
    if (f & F_ROUGH) c = ',';
    if (f & F_CLIFF) c = '#';
    if (f & F_ROCK) c = 'o';
    if (f & F_WATER) c = '~';
    if (f & F_EDGE) c = 'X';
    row.push(c);
  }
  grid.push(row);
}
for (const r of map.resources) {
  const w = r.kind === 'mineral' ? 2 : 3;
  const h = r.kind === 'mineral' ? 1 : 3;
  for (let y = r.ty; y < r.ty + h; y++) for (let x = r.tx; x < r.tx + w; x++) grid[y][x] = r.kind === 'mineral' ? 'M' : 'G';
}
for (const b of map.bases) {
  for (let y = b.ty; y < b.ty + 5; y++) for (let x = b.tx; x < b.tx + 5; x++) grid[y][x] = b.start >= 0 ? String(b.start + 1) : 'H';
}
console.log(grid.map((r) => r.join('')).join('\n'));
console.log(`${map.name} ${map.w}x${map.h} bases=${map.bases.length} resources=${map.resources.length} maxPlayers=${map.maxPlayers}`);
for (const w of warnings) console.log('WARN', w);
