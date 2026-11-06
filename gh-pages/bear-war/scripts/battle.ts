// Balance lab: equal-cost armies fight on an open arena.   node scripts/battle.ts [trials]
import { Game } from '../src/game/game.ts';
import { MapBuilder } from '../src/game/map/builder.ts';
import { DEFS } from '../src/game/data/index.ts';
import type { RaceId } from '../src/game/data/types.ts';
import { TILE } from '../src/game/constants.ts';
import { useInstant } from '../src/game/systems/abilities.ts';

const ARMIES: Record<RaceId, [string, number][]> = {
  ironpaw: [['ranger', 12], ['grizzly', 4], ['medic', 2], ['kodiak', 2]],
  horde: [['scrapper', 20], ['stinger', 6], ['buzzbomb', 4]],
  starborn: [['spiritbear', 5], ['moonbear', 5], ['polarcolossus', 1]],
};

function arena(): MapBuilder {
  const b = new MapBuilder('arena', 'Arena', 72, 48, 'none', 'badlands', 1);
  b.fillElev(0);
  b.base(6.5, 6.5, -2.3, { start: true });
  b.base(65.5, 41.5, 0.8, { start: true });
  return b;
}

function value(es: { def: { cost: { m: number; g: number } } }[]): number {
  return es.reduce((s, e) => s + e.def.cost.m + e.def.cost.g * 1.5, 0);
}

function fight(a: RaceId, b: RaceId, seed: number, upgrades: boolean): { winner: number; left: number; time: number } {
  const map = arena().build();
  const g = new Game({ map, seed, players: [{ name: 'A', race: a, color: 0, team: 0 }, { name: 'B', race: b, color: 1, team: 1 }] });
  // research everything relevant so both sides fight at full strength
  for (const p of g.players) {
    for (const r of ['honeyrush', 'thickfur', 'zoomies', 'busybees', 'longstingers', 'pounce', 'moonstep']) p.upgrades[r] = 1;
    if (upgrades) for (const r of ['inf_w', 'inf_a', 'veh_w', 'claws', 'stings', 'hide', 'ground_w', 'ground_a']) p.upgrades[r] = 1;
  }
  // remove workers so they don't wander into the fight
  for (const e of g.entities) if (e.def.worker || e.def.id === 'bumblebear') g.removeSilently(e);
  const spawn = (pi: number, race: RaceId, cx: number, cy: number) => {
    let k = 0;
    for (const [id, n] of ARMIES[race]) {
      for (let i = 0; i < n; i++) {
        const u = g.spawnUnit(id, pi, cx + ((k % 6) - 2.5) * 22, cy + (Math.floor(k / 6) - 2) * 22);
        u.energy = u.def.energy ?? 0;
        k++;
      }
    }
  };
  spawn(0, a, 22 * TILE, 24 * TILE);
  spawn(1, b, 50 * TILE, 24 * TILE);
  const army = (pi: number) => g.entities.filter((e) => e.alive && e.owner === pi && e.isUnit && e.def.kind === 'unit');
  for (const pi of [0, 1]) {
    g.step([{ p: pi, c: { c: 'amove', ids: army(pi).map((e) => e.id), x: (pi === 0 ? 50 : 22) * TILE, y: 24 * TILE } }]);
  }
  for (let t = 0; t < 20 * 120; t++) {
    // minimal micro: kodiaks brace up, stim when engaged
    if (t % 10 === 0) {
      for (const e of g.entities) {
        if (!e.alive || e.owner < 0) continue;
        if (e.def.id === 'kodiak' && t > 40) useInstant(g, e, 'brace');
        if ((e.def.id === 'ranger' || e.def.id === 'grizzly') && e.target && e.rushT === 0 && e.hp > 30) useInstant(g, e, 'honeyrush');
      }
    }
    // keep idle survivors hunting the enemy
    const cmds: { p: number; c: { c: 'amove'; ids: number[]; x: number; y: number } }[] = [];
    if (t % 40 === 0) {
      for (const pi of [0, 1]) {
        const foes = army(1 - pi);
        const idle = army(pi).filter((e) => e.orders.length === 0 && !e.target);
        if (!foes.length || !idle.length) continue;
        const fx = foes.reduce((s, e) => s + e.x, 0) / foes.length;
        const fy = foes.reduce((s, e) => s + e.y, 0) / foes.length;
        cmds.push({ p: pi, c: { c: 'amove', ids: idle.map((e) => e.id), x: fx, y: fy } });
      }
    }
    g.step(cmds);
    const A = army(0).length;
    const B = army(1).length;
    if (!A || !B) {
      const w = A ? 0 : 1;
      const v0 = value(ARMIES[[a, b][w]].flatMap(([id, n]) => Array(n).fill({ def: DEFS[id] })));
      return { winner: w, left: Math.round((value(army(w)) / v0) * 100), time: g.tick / 20 };
    }
  }
  if (process.env.DEBUG) {
    for (const pi of [0, 1]) console.log('  draw leftovers p' + pi, army(pi).map((e) => `${e.def.id}@${(e.x / TILE).toFixed(0)},${(e.y / TILE).toFixed(0)} o=${e.orders[0]?.t} t=${e.target} morph=${e.morphTo}`).join(' '));
  }
  return { winner: -1, left: 0, time: 120 };
}

const trials = Number(process.argv[2] ?? 4);
const races: RaceId[] = ['ironpaw', 'horde', 'starborn'];
for (const up of [false, true]) {
  console.log(up ? '\n--- with +1 upgrades' : '--- no upgrades');
  for (let i = 0; i < races.length; i++) {
    for (let j = i + 1; j < races.length; j++) {
      const res: string[] = [];
      let wa = 0;
      for (let t = 0; t < trials; t++) {
        const flip = t % 2 === 1;
        const r = fight(flip ? races[j] : races[i], flip ? races[i] : races[j], 100 + t, up);
        const winnerRace = r.winner < 0 ? 'draw' : (flip ? [races[j], races[i]] : [races[i], races[j]])[r.winner];
        if (winnerRace === races[i]) wa++;
        res.push(`${winnerRace}(${r.left}% left, ${r.time}s)`);
      }
      console.log(`${races[i]} vs ${races[j]}: ${wa}/${trials} for ${races[i]} | ${res.join(', ')}`);
    }
  }
}
const cost = (r: RaceId) => ARMIES[r].reduce((s, [id, n]) => s + (DEFS[id].cost.m + (DEFS[id].morphFrom ? DEFS[DEFS[id].morphFrom!].cost.m / 2 : 0)) * n / (DEFS[id].count ?? 1), 0);
const gas = (r: RaceId) => ARMIES[r].reduce((s, [id, n]) => s + DEFS[id].cost.g * n / (DEFS[id].count ?? 1), 0);
console.log('\narmy cost (m/g):', races.map((r) => `${r} ${cost(r)}/${gas(r)}`).join(', '));
