import type { AbilityDef, EntityDef, RaceDef, RaceId, ResearchDef } from './types.ts';
import { IRONPAW } from './ironpaw.ts';
import { HORDE } from './horde.ts';
import { STARBORN } from './starborn.ts';
import { NEUTRAL } from './neutral.ts';
import { RESEARCH } from './research.ts';
import { ABILITIES } from './abilities.ts';

export * from './types.ts';

export const RACES: Record<RaceId, RaceDef> = {
  ironpaw: {
    id: 'ironpaw', name: 'Ironpaw', color: '#c58a4e', build: 'construct',
    worker: 'hardhat', townHall: 'lodge', supplyUnit: 'larder', refinery: 'refinery',
    desc: 'Hard-working brown bears of the timber country. Hardhats build and repair; rugged infantry, steam-plated war bears and armored airships.',
  },
  horde: {
    id: 'horde', name: 'Honey Horde', color: '#e3a92b', build: 'settle',
    worker: 'forager', townHall: 'hive', supplyUnit: 'bumblebear', refinery: 'nectartap',
    desc: 'Feral bears living alongside giant bees. Cubs grow into any bear; dens stand on honeycomb; everyone heals over time.',
  },
  starborn: {
    id: 'starborn', name: 'Starborn', color: '#8fd3ff', build: 'summon',
    worker: 'snowcub', townHall: 'startemple', supplyUnit: 'startotem', refinery: 'dewshrine',
    desc: 'Panda Sage polar, spirit and moon bears. Structures are called down by starlight and need a Star Totem; every bear wears an aurora shield.',
  },
};

export const RACE_IDS: RaceId[] = ['ironpaw', 'horde', 'starborn'];

export const DEFS: Record<string, EntityDef> = {};
for (const d of [...NEUTRAL, ...IRONPAW, ...HORDE, ...STARBORN]) {
  if (DEFS[d.id]) throw new Error(`duplicate def id ${d.id}`);
  DEFS[d.id] = d;
}

export const RESEARCH_DEFS: Record<string, ResearchDef> = {};
for (const r of RESEARCH) RESEARCH_DEFS[r.id] = r;

export const ABILITY_DEFS: Record<string, AbilityDef> = {};
for (const a of ABILITIES) ABILITY_DEFS[a.id] = a;

/** Unit modes and evolved structures share selection groups with what they came from. */
export function family(d: EntityDef): string {
  return d.base ?? d.counts?.[0] ?? d.id;
}

/** Is e switching modes (as opposed to growing into something else)? */
export function switchingMode(morphTo: string | null, d: EntityDef): boolean {
  return !!morphTo && family(DEFS[morphTo]) === family(d);
}

/** ids a building satisfies for tech requirements (itself + `counts`). */
export function satisfies(def: EntityDef): string[] {
  return def.counts ? [def.id, ...def.counts] : [def.id];
}

/** Largest unit radius and structure half-diagonal (px): spatial queries must look this far. */
export const MAX_UNIT_RADIUS = Math.max(...Object.values(DEFS).map((d) => d.radius ?? 0));
export const MAX_STRUCT_REACH = Math.max(...Object.values(DEFS).map((d) => (d.size ? Math.sqrt(d.size[0] * d.size[0] + d.size[1] * d.size[1]) * 16 : 0)));

/** For each unit id, the building ids that can produce it. */
export const PRODUCERS: Record<string, string[]> = {};
/** For each research id, the building id that researches it. */
export const RESEARCHED_AT: Record<string, string> = {};
for (const d of Object.values(DEFS)) {
  for (const u of d.produces ?? []) (PRODUCERS[u] ??= []).push(d.id);
  for (const r of d.researches ?? []) RESEARCHED_AT[r] ??= d.id;
}

export function buildablesFor(race: RaceId, page: 1 | 2): EntityDef[] {
  return Object.values(DEFS)
    .filter((d) => d.race === race && d.kind === 'building' && d.buildPage === page)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function unitDefsFor(race: RaceId): EntityDef[] {
  return Object.values(DEFS)
    .filter((d) => d.race === race && d.kind === 'unit' && d.order !== undefined)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Throws if any cross-reference in the data is broken. Run at startup and in tests. */
export function validateData(): void {
  const errors: string[] = [];
  const has = (id: string) => !!DEFS[id];
  for (const d of Object.values(DEFS)) {
    for (const r of d.requires ?? []) if (!has(r)) errors.push(`${d.id}.requires -> ${r}`);
    for (const r of d.counts ?? []) if (!has(r)) errors.push(`${d.id}.counts -> ${r}`);
    for (const u of d.produces ?? []) if (!has(u)) errors.push(`${d.id}.produces -> ${u}`);
    for (const u of d.morphs ?? []) if (!has(u)) errors.push(`${d.id}.morphs -> ${u}`);
    for (const u of d.unitMorphs ?? []) if (!has(u)) errors.push(`${d.id}.unitMorphs -> ${u}`);
    for (const r of d.researches ?? []) if (!RESEARCH_DEFS[r]) errors.push(`${d.id}.researches -> ${r}`);
    for (const a of d.abilities ?? []) if (!ABILITY_DEFS[a]) errors.push(`${d.id}.abilities -> ${a}`);
    if (d.morphFrom && !has(d.morphFrom)) errors.push(`${d.id}.morphFrom -> ${d.morphFrom}`);
    if (d.kind === 'unit' && !d.radius) errors.push(`${d.id} missing radius`);
    if ((d.kind === 'building' || d.kind === 'mineral' || d.kind === 'geyser') && !d.size) errors.push(`${d.id} missing size`);
    if (d.cargoReq && !RESEARCH_DEFS[d.cargoReq]) errors.push(`${d.id}.cargoReq -> ${d.cargoReq}`);
    if (d.cargoSize && (d.air || d.kind !== 'unit')) errors.push(`${d.id} has cargoSize but can't be carried`);
    if (d.cargo && d.kind === 'unit' && !d.air) errors.push(`${d.id}: ground transports are not supported`);
  }
  for (const r of RESEARCH) {
    if (!RESEARCHED_AT[r.id]) errors.push(`research ${r.id} not available anywhere`);
    if (r.costs.length !== r.times.length) errors.push(`research ${r.id} costs/times mismatch`);
    for (const lvl of r.reqs ?? []) for (const b of lvl) if (!has(b)) errors.push(`research ${r.id} req -> ${b}`);
  }
  for (const a of ABILITIES) if (a.requires && !RESEARCH_DEFS[a.requires]) errors.push(`ability ${a.id} requires -> ${a.requires}`);
  for (const race of Object.values(RACES)) {
    for (const k of ['worker', 'townHall', 'supplyUnit', 'refinery'] as const) {
      if (!has(race[k])) errors.push(`race ${race.id}.${k} -> ${race[k]}`);
    }
  }
  if (errors.length) throw new Error('Data validation failed:\n' + errors.join('\n'));
}
