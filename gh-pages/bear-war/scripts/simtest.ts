// Headless simulation smoke test:  node scripts/simtest.ts [ticks] [seed] [race1] [race2] [ai]
import { Game } from '../src/game/game.ts';
import { loadMap } from '../src/game/map/maps.ts';
import type { RaceId } from '../src/game/data/types.ts';
import type { AIDifficulty } from '../src/game/player.ts';

const ticks = Number(process.argv[2] ?? 2400);
const seed = Number(process.argv[3] ?? 1234);
const r1 = (process.argv[4] ?? 'ironpaw') as RaceId;
const r2 = (process.argv[5] ?? 'horde') as RaceId;
const ai = (process.argv[6] ?? 'normal') as AIDifficulty | 'none';

function run(): { hash: number; game: Game; ms: number } {
  const g = new Game({
    map: loadMap(process.env.MAP ?? 'twin-craters'),
    seed,
    players: [
      { name: 'P1', race: r1, color: 0, team: 0, ai: ai === 'none' ? null : ai },
      { name: 'P2', race: r2, color: 1, team: 1, ai: ai === 'none' ? null : ai },
    ],
  });
  const t0 = performance.now();
  let worst = 0;
  const verbose = process.env.VERBOSE === '1';
  for (let i = 0; i < ticks && !g.over; i++) {
    const s = performance.now();
    g.step([]);
    worst = Math.max(worst, performance.now() - s);
    if (verbose && g.tick % 1200 === 0) {
      for (const p of g.players) {
        const mine = g.entities.filter((e) => e.owner === p.index);
        const count = (pred: (e: (typeof mine)[number]) => boolean) => mine.filter(pred).length;
        const blds: Record<string, number> = {};
        const units: Record<string, number> = {};
        for (const e of mine) {
          if (e.isBuilding) blds[e.def.id] = (blds[e.def.id] ?? 0) + 1;
          else if (e.def.kind === 'unit' && !e.def.worker) units[e.def.id] = (units[e.def.id] ?? 0) + 1;
        }
        const ai = g.ais.find((a) => a.pi === p.index);
        console.log(
          `[${(g.tick / 20 / 60).toFixed(1)}m] ${p.race.padEnd(8)} sup ${p.supplyUsed}/${p.supplyMax} min ${p.minerals | 0} gas ${p.gas | 0} workers ${count((e) => !!e.def.worker)} cub ${count((e) => e.def.kind === 'cub')} ai=${ai?.state}/${ai?.step} atk>=${ai?.attackSupply}`,
        );
        console.log('     blds', JSON.stringify(blds));
        console.log('     units', JSON.stringify(units));
      }
    }
  }
  const ms = performance.now() - t0;
  console.log(`worst tick ${worst.toFixed(2)}ms`);
  return { hash: g.hash(), game: g, ms };
}

const a = run();
const b = run();
const g = a.game;
console.log(`ran ${g.tick} ticks (${(g.tick / 20).toFixed(0)}s game time) in ${a.ms.toFixed(0)}ms, avg ${(a.ms / g.tick).toFixed(3)}ms/tick`);
for (const p of g.players) {
  const units = g.entities.filter((e) => e.owner === p.index && e.isUnit).length;
  const blds = g.entities.filter((e) => e.owner === p.index && e.isBuilding).length;
  console.log(
    `${p.name} ${p.race}: minerals=${p.minerals.toFixed(0)} gas=${p.gas.toFixed(0)} supply=${p.supplyUsed}/${p.supplyMax} units=${units} buildings=${blds} gathered=${p.stats.mineralsGathered}/${p.stats.gasGathered} defeated=${p.defeated}`,
  );
}
console.log(`over=${g.over} winners=${g.winners.join(',')}`);
console.log(`determinism: ${a.hash === b.hash ? 'OK' : 'MISMATCH'} (${a.hash} vs ${b.hash})`);
if (a.hash !== b.hash) process.exit(1);
