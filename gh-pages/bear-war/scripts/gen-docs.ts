// Generates docs/UNITS.md from the game data:  node scripts/gen-docs.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ABILITY_DEFS, DEFS, RACES, RACE_IDS, RESEARCH_DEFS, RESEARCHED_AT, PRODUCERS } from '../src/game/data/index.ts';
import type { EntityDef, WeaponDef } from '../src/game/data/types.ts';

const out: string[] = [];
const cost = (d: { cost: { m: number; g: number } }) => (d.cost.g ? `${d.cost.m} / ${d.cost.g}` : `${d.cost.m}`);
const weapon = (w: WeaponDef) => {
  let s = `${w.name}: ${w.dmg}${w.hits && w.hits > 1 ? `×${w.hits}` : ''}`;
  if (w.bonus) s += ` (${Object.entries(w.bonus).map(([k, v]) => `+${v} ${k}`).join(', ')})`;
  s += `, range ${w.range < 1 ? 'melee' : w.range}, ${w.cd}s, ${w.targets}`;
  if (w.splash) s += ', splash';
  if (w.bounce) s += ', bounces';
  return s;
};
const name = (id: string) => DEFS[id]?.name ?? id;

out.push('# Units & structures reference', '');
out.push('_Generated from `src/game/data` by `node scripts/gen-docs.ts` - do not edit by hand._', '');
out.push('Costs are minerals / gas; times are in game seconds; ranges and speeds in tiles.', '');

for (const r of RACE_IDS) {
  const race = RACES[r];
  out.push(`## ${race.name}`, '', race.desc, '');
  out.push('### Units', '');
  out.push('| Unit | Cost | Supply | Time | HP | Armor | Speed | Weapons | Produced at | Requires |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  const units = Object.values(DEFS).filter((d) => d.race === r && d.kind === 'unit' && d.order !== undefined).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const u of units) {
    const hp = u.shields ? `${u.hp} + ${u.shields} shields` : `${u.hp}`;
    const src = u.base ? `mode of ${name(u.base)}` : u.lifetime ? `released by Den Mothers` : u.morphFrom ? `grown from ${name(u.morphFrom)}` : (PRODUCERS[u.id] ?? []).filter((b) => !DEFS[b].counts).map(name).join(', ');
    const tags = [u.air ? 'air' : '', u.detector ? 'detector' : '', u.cloaked ? 'hidden' : '', u.worker ? 'worker' : '', u.radius ? `radius ${u.radius}` : ''].filter(Boolean).join(', ');
    out.push(
      `| **${u.name}**${tags ? ` _(${tags})_` : ''} | ${cost(u)} | ${(u.supply ?? 0) * (u.count ?? 1)}${u.count && u.count > 1 ? ` (×${u.count})` : ''} | ${u.time} | ${hp} | ${u.armor} | ${u.speed} | ${(u.weapons ?? []).map(weapon).join('<br>') || '-'} | ${src || '-'} | ${(u.requires ?? []).map(name).join(', ') || '-'} |`,
    );
  }
  out.push('');
  for (const u of units) {
    const abs = (u.abilities ?? []).filter((a) => !['gather', 'return', 'build', 'build2', 'repair'].includes(a));
    if (abs.length) out.push(`- **${u.name}** - ${u.desc} Abilities: ${abs.map((a) => `*${ABILITY_DEFS[a].name}* (${ABILITY_DEFS[a].desc})`).join('; ')}`);
    else out.push(`- **${u.name}** - ${u.desc}`);
  }
  out.push('', '### Structures', '');
  out.push('| Structure | Cost | Time | HP | Size | Provides | Requires | Notes |');
  out.push('|---|---|---|---|---|---|---|---|');
  const blds = Object.values(DEFS).filter((d) => d.race === r && d.kind === 'building').sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  for (const b of blds) {
    const hp = b.shields ? `${b.hp} + ${b.shields}` : `${b.hp}`;
    const notes: string[] = [];
    if (b.produces) notes.push(`${b.spawnsCubs ? 'cubs grow into' : 'trains'} ${b.produces.map(name).join(', ')}`);
    if (b.researches?.length) notes.push(`researches ${b.researches.map((x) => RESEARCH_DEFS[x].name).join(', ')}`);
    if (b.weapons) notes.push(b.weapons.map(weapon).join('; '));
    if (b.detector) notes.push('detector');
    if (b.counts) notes.push(`evolved from ${name(b.counts[b.counts.length - 1])}`);
    out.push(`| **${b.name}** | ${cost(b)} | ${b.time} | ${hp} | ${b.size?.join('×')} | ${b.provides ? `${b.provides} supply` : '-'} | ${(b.requires ?? []).map(name).join(', ') || '-'} | ${notes.join('; ') || '-'} |`);
  }
  out.push('', '### Research', '');
  out.push('| Research | Levels | Cost (per level) | Time | At |');
  out.push('|---|---|---|---|---|');
  for (const rd of Object.values(RESEARCH_DEFS).filter((x) => x.race === r)) {
    out.push(`| **${rd.name}** - ${rd.desc} | ${rd.costs.length} | ${rd.costs.map((c) => cost({ cost: c })).join(', ')} | ${rd.times.join(', ')} | ${name(RESEARCHED_AT[rd.id])} |`);
  }
  out.push('');
}
void ({} as EntityDef);
const file = path.resolve(import.meta.dirname, '..', 'docs', 'UNITS.md');
writeFileSync(file, out.join('\n') + '\n');
console.log('wrote', file);
