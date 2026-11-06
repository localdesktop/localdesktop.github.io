import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateData, DEFS, RACE_IDS, RACES } from '../src/game/data/index.ts';
import { datan2, dcos, dsin } from '../src/game/math.ts';
import { Game } from '../src/game/game.ts';
import { MAPS, buildMapWithWarnings, loadMap } from '../src/game/map/maps.ts';
import type { RaceId } from '../src/game/data/types.ts';
import type { Command } from '../src/game/types.ts';
import { TILE } from '../src/game/constants.ts';
import { ReplaySession, makeReplay } from '../src/net/replay.ts';

function newGame(r1: RaceId, r2: RaceId, seed = 42, ai: 'normal' | null = null): Game {
  return new Game({
    map: loadMap(MAPS[0].id),
    seed,
    players: [
      { name: 'A', race: r1, color: 0, team: 0, ai },
      { name: 'B', race: r2, color: 1, team: 1, ai },
    ],
  });
}

describe('data', () => {
  it('validates all cross references', () => {
    expect(() => validateData()).not.toThrow();
  });
  it('every clan has worker, town hall, supply and refinery', () => {
    for (const r of RACE_IDS) {
      const race = RACES[r];
      expect(DEFS[race.worker].worker).toBe(true);
      expect(DEFS[race.townHall].townHall).toBe(true);
      expect(DEFS[race.refinery].refinery).toBe(true);
    }
  });
});

describe('deterministic math', () => {
  it('dsin/dcos match Math within tolerance', () => {
    for (let a = -10; a <= 10; a += 0.37) {
      expect(Math.abs(dsin(a) - Math.sin(a))).toBeLessThan(1e-8);
      expect(Math.abs(dcos(a) - Math.cos(a))).toBeLessThan(1e-8);
    }
  });
  it('datan2 matches Math.atan2 within tolerance', () => {
    for (let y = -5; y <= 5; y += 0.7) {
      for (let x = -5; x <= 5; x += 0.9) {
        if (x === 0 && y === 0) continue;
        expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(2e-5);
      }
    }
  });
  it('simulation code never calls non-deterministic Math functions', () => {
    const banned = /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot|random)\b/;
    const root = path.resolve(import.meta.dirname, '..', 'src', 'game');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const offenders = files.filter((f) => !f.endsWith('math.ts') && banned.test(strip(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

describe('maps', () => {
  for (const m of MAPS) {
    it(`${m.id} builds without warnings`, () => {
      const { map, warnings } = buildMapWithWarnings(m.id);
      expect(warnings).toEqual([]);
      expect(map.starts.length).toBe(m.players);
      expect(map.resources.filter((r) => r.kind === 'mineral').length).toBeGreaterThanOrEqual(8 * map.bases.length - 4);
    });
  }
});

describe('pathfinding', () => {
  it('finds a path between the two start locations', () => {
    const g = newGame('ironpaw', 'horde');
    const [a, b] = g.map.starts;
    const ax = (a.tx + 2.5) * TILE;
    const ay = (a.ty + 8) * TILE;
    const bx = (b.tx + 2.5) * TILE;
    const by = (b.ty - 3) * TILE;
    const p = g.grid.findPath(ax, ay, bx, by, 1, 20000);
    expect(p).not.toBeNull();
    const ex = p![p!.length - 2];
    const ey = p![p!.length - 1];
    expect(Math.hypot(ex - bx, ey - by)).toBeLessThan(TILE * 2);
  });
});

describe('simulation', () => {
  it('workers mine minerals', () => {
    const g = newGame('starborn', 'ironpaw');
    for (let i = 0; i < 20 * 60; i++) g.step([]);
    for (const p of g.players) expect(p.stats.mineralsGathered).toBeGreaterThan(400);
  });

  it('is deterministic with identical commands', () => {
    const script = (g: Game): Command[] => {
      if (g.tick !== 40) return [];
      const hall = g.entities.find((e) => e.owner === 0 && e.def.townHall)!;
      const ws = g.entities.filter((e) => e.owner === 0 && e.def.worker).map((e) => e.id);
      return [
        { c: 'train', ids: [hall.id], d: 'hardhat' },
        { c: 'move', ids: ws.slice(0, 4), x: hall.x + 300, y: hall.y + 200 },
      ];
    };
    const run = () => {
      const g = newGame('ironpaw', 'horde', 7, 'normal');
      for (let i = 0; i < 20 * 120; i++) g.step(script(g).map((c) => ({ p: 0, c })));
      return g.hash();
    };
    expect(run()).toBe(run());
  });

  it('build, train and fight: AIs expand, produce armies and trade blows', () => {
    const g = newGame('ironpaw', 'starborn', 1234, 'normal');
    for (let i = 0; i < 20 * 60 * 18 && !g.over; i++) g.step([]);
    for (const p of g.players) {
      expect(p.stats.unitsProduced).toBeGreaterThan(30);
      expect(p.stats.buildingsBuilt).toBeGreaterThan(8);
    }
    const kills = g.players.reduce((s, p) => s + p.stats.unitsKilled + p.stats.buildingsKilled, 0);
    expect(kills).toBeGreaterThan(20);
  }, 120000);

  it('rejects commands for units the player does not own', () => {
    const g = newGame('ironpaw', 'horde');
    const enemyWorker = g.entities.find((e) => e.owner === 1 && e.def.worker)!;
    const before = enemyWorker.orders.length;
    g.step([{ p: 0, c: { c: 'stop', ids: [enemyWorker.id] } }]);
    g.step([{ p: 0, c: { c: 'move', ids: [enemyWorker.id], x: 10, y: 10 } }]);
    expect(enemyWorker.orders.length).toBe(before);
  });

  it('ignores malformed commands without throwing', () => {
    const g = newGame('horde', 'starborn');
    const junk = [
      { c: 'move', ids: 'nope', x: 'a', y: null },
      { c: 'build', ids: [1, 2, 3], d: 'doesnotexist', tx: -5, ty: 1e9 },
      { c: 'train', ids: [999999], d: 'ranger' },
      { c: 'ability', ids: [], a: 'starfall' },
      { c: 'cancel', id: 'x', slot: 'y' },
      { c: 'whatever' },
    ] as unknown as Command[];
    expect(() => g.step(junk.map((c) => ({ p: 0, c })))).not.toThrow();
  });

  it('replays reproduce a game exactly', () => {
    const g = newGame('starborn', 'horde', 31, 'normal');
    g.players[0].ai = null;
    const log: [number, number, Command][] = [];
    for (let i = 0; i < 20 * 90; i++) {
      const cmds: Command[] = [];
      if (g.tick === 30 || g.tick === 900) {
        const hall = g.entities.find((e) => e.owner === 0 && e.def.townHall)!;
        cmds.push({ c: 'train', ids: [hall.id], d: 'snowcub' });
        const ws = g.entities.filter((e) => e.owner === 0 && e.def.worker).map((e) => e.id);
        cmds.push({ c: 'move', ids: ws.slice(0, 2), x: hall.x + 250, y: hall.y - 100 });
      }
      for (const c of cmds) log.push([g.tick, 0, c]);
      g.step(cmds.map((c) => ({ p: 0, c })));
    }
    const rep = JSON.parse(JSON.stringify(makeReplay(g, g.setups, log, 'test')));
    const rs = new ReplaySession(rep);
    rs.speed = 50;
    for (let i = 0; i < 10000 && rs.game.tick < rep.ticks; i++) rs.update(250);
    expect(rs.game.tick).toBe(g.tick);
    expect(rs.game.hash()).toBe(g.hash());
  });

  it('surrender ends the game', () => {
    const g = newGame('horde', 'starborn');
    g.step([{ p: 1, c: { c: 'surrender' } }]);
    for (let i = 0; i < 20; i++) g.step([]);
    expect(g.over).toBe(true);
    expect(g.winners).toEqual([0]);
  });
});
