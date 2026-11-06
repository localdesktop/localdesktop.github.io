import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game.ts';
import { MapBuilder, rect } from '../src/game/map/builder.ts';
import type { RaceId } from '../src/game/data/types.ts';
import type { Command, GameEvent } from '../src/game/types.ts';
import { TILE } from '../src/game/constants.ts';
import type { Entity } from '../src/game/entity.ts';
import { cargoUsed } from '../src/game/systems/cargo.ts';

function arena(r0: RaceId, r1: RaceId, plateau = false): Game {
  const b = new MapBuilder('arena', 'Arena', 64, 40, 'none', 'badlands', 1);
  b.fillElev(0);
  // a raised block with cliffs all round and no ramp: only flyers get up there
  if (plateau) b.setElev(rect(30, 4, 42, 14), 2);
  b.base(6.5, 6.5, -2.3, { start: true });
  b.base(57.5, 33.5, 0.8, { start: true });
  const g = new Game({ map: b.build(), seed: 5, players: [{ name: 'A', race: r0, color: 0, team: 0 }, { name: 'B', race: r1, color: 1, team: 1 }] });
  for (const e of g.entities) if (e.def.worker || e.def.id === 'bumblebear') g.removeSilently(e);
  for (const p of g.players) p.supplyMax = 200;
  for (const ex of g.vision.explored) ex.fill(1);
  return g;
}

const run = (g: Game, ticks: number, cmds: { p: number; c: Command }[] = []): GameEvent[] => {
  const evs: GameEvent[] = [];
  g.step(cmds);
  evs.push(...g.events);
  for (let i = 1; i < ticks; i++) {
    g.step([]);
    evs.push(...g.events);
  }
  return evs;
};

const spawn = (g: Game, id: string, owner: number, tx: number, ty: number): Entity => g.spawnUnit(id, owner, tx * TILE, ty * TILE);

describe('transports', () => {
  it('units board a transport, ride along and unload at a point', () => {
    const g = arena('ironpaw', 'horde');
    const bearloon = spawn(g, 'bearloon', 0, 20, 20);
    const troops = [spawn(g, 'ranger', 0, 16, 22), spawn(g, 'ranger', 0, 16, 23), spawn(g, 'grizzly', 0, 17, 24)];
    run(g, 80, [{ p: 0, c: { c: 'smart', ids: troops.map((t) => t.id), x: bearloon.x, y: bearloon.y, t: bearloon.id } }]);
    expect(troops.every((t) => t.inside && t.carrier === bearloon.id)).toBe(true);
    expect(bearloon.cargo.length).toBe(3);
    // carried units can't be ordered around or shot at
    run(g, 2, [{ p: 0, c: { c: 'move', ids: [troops[0].id], x: 0, y: 0 } }]);
    expect(troops[0].orders.length).toBe(0);
    run(g, 300, [{ p: 0, c: { c: 'unload', ids: [bearloon.id], x: 44 * TILE, y: 20 * TILE } }]);
    expect(bearloon.cargo.length).toBe(0);
    for (const t of troops) {
      expect(t.inside).toBe(false);
      expect(Math.hypot(t.x - 44 * TILE, t.y - 20 * TILE)).toBeLessThan(3 * TILE);
    }
  });

  it('a transport flies over cliffs to drop units where they could not walk', () => {
    const g = arena('starborn', 'horde', true);
    const floe = spawn(g, 'floebear', 0, 24, 20);
    const w = spawn(g, 'spiritbear', 0, 22, 20);
    run(g, 60, [{ p: 0, c: { c: 'load', ids: [floe.id], t: w.id } }]);
    expect(w.inside).toBe(true);
    run(g, 300, [{ p: 0, c: { c: 'unload', ids: [floe.id], x: 36 * TILE, y: 9 * TILE } }]);
    expect(w.inside).toBe(false);
    expect(g.map.elevAt(Math.floor(w.x / TILE), Math.floor(w.y / TILE))).toBe(2);
  });

  it('enforces cargo capacity', () => {
    const g = arena('ironpaw', 'horde');
    const bearloon = spawn(g, 'bearloon', 0, 20, 20);
    const kodiaks = [spawn(g, 'kodiak', 0, 16, 20), spawn(g, 'kodiak', 0, 24, 20)];
    const extra = spawn(g, 'ranger', 0, 20, 24);
    run(g, 120, [{ p: 0, c: { c: 'smart', ids: [...kodiaks.map((t) => t.id), extra.id], x: bearloon.x, y: bearloon.y, t: bearloon.id } }]);
    expect(kodiaks.every((t) => t.inside)).toBe(true);
    expect(extra.inside).toBe(false);
    expect(cargoUsed(g, bearloon)).toBe(8);
    const evs = run(g, 2, [{ p: 0, c: { c: 'load', ids: [extra.id], t: bearloon.id } }]);
    expect(evs.some((e) => e.k === 'error' && e.msg === 'Not enough room')).toBe(true);
  });

  it('a destroyed transport takes its cargo down; a destroyed bunker lets units out', () => {
    const g = arena('ironpaw', 'horde');
    const bearloon = spawn(g, 'bearloon', 0, 20, 20);
    const a = spawn(g, 'ranger', 0, 20, 22);
    run(g, 60, [{ p: 0, c: { c: 'smart', ids: [a.id], x: bearloon.x, y: bearloon.y, t: bearloon.id } }]);
    expect(a.inside).toBe(true);
    g.kill(bearloon);
    expect(a.alive).toBe(false);

    const bunker = g.placeBuilding('bunker', 0, 30, 20, true);
    const b = spawn(g, 'ranger', 0, 31, 25);
    run(g, 60, [{ p: 0, c: { c: 'smart', ids: [b.id], x: bunker.x, y: bunker.y, t: bunker.id } }]);
    expect(b.inside).toBe(true);
    g.kill(bunker);
    expect(b.alive).toBe(true);
    expect(b.inside).toBe(false);
  });

  it('units fire out of a bunker with bonus range and cannot be hit inside', () => {
    const g = arena('ironpaw', 'horde');
    const bunker = g.placeBuilding('bunker', 0, 20, 20, true);
    const troops = [spawn(g, 'ranger', 0, 21, 24), spawn(g, 'ranger', 0, 22, 24)];
    run(g, 60, [{ p: 0, c: { c: 'smart', ids: troops.map((t) => t.id), x: bunker.x, y: bunker.y, t: bunker.id } }]);
    expect(troops.every((t) => t.inside)).toBe(true);
    // just beyond a Ranger's own range from the bunker's centre, within range from its wall + 1
    const foe = g.spawnUnit('forager', 1, bunker.x + 200, bunker.y);
    foe.holdPos = true;
    foe.orders = [{ t: 'hold' }];
    run(g, 120);
    expect(foe.alive ? foe.hp : 0).toBeLessThan(40);
    expect(troops.every((t) => t.hp === t.def.hp)).toBe(true);
  });

  it('only infantry may enter a bunker', () => {
    const g = arena('ironpaw', 'horde');
    const bunker = g.placeBuilding('bunker', 0, 20, 20, true);
    const bike = spawn(g, 'blazerider', 0, 21, 25);
    const evs = run(g, 60, [{ p: 0, c: { c: 'load', ids: [bike.id], t: bunker.id } }]);
    expect(bike.inside).toBe(false);
    expect(evs.some((e) => e.k === 'error')).toBe(true);
  });

  it('Bumblebears carry units only after Cargo Pouch', () => {
    const g = arena('horde', 'ironpaw');
    const f = spawn(g, 'bumblebear', 0, 20, 20);
    const s = spawn(g, 'stinger', 0, 21, 21);
    run(g, 60, [{ p: 0, c: { c: 'load', ids: [s.id], t: f.id } }]);
    expect(s.inside).toBe(false);
    g.players[0].upgrades.pouch = 1;
    run(g, 120, [{ p: 0, c: { c: 'load', ids: [s.id], t: f.id } }]);
    expect(s.inside).toBe(true);
  });

  it('a unit inside can be unloaded on its own', () => {
    const g = arena('ironpaw', 'horde');
    const bunker = g.placeBuilding('bunker', 0, 20, 20, true);
    const troops = [spawn(g, 'ranger', 0, 21, 24), spawn(g, 'medic', 0, 22, 24)];
    run(g, 60, [{ p: 0, c: { c: 'smart', ids: troops.map((t) => t.id), x: bunker.x, y: bunker.y, t: bunker.id } }]);
    expect(bunker.cargo.length).toBe(2);
    run(g, 2, [{ p: 0, c: { c: 'unload', ids: [bunker.id], u: troops[1].id } }]);
    expect(troops[1].inside).toBe(false);
    expect(troops[0].inside).toBe(true);
    run(g, 2, [{ p: 0, c: { c: 'unload', ids: [bunker.id] } }]);
    expect(bunker.cargo.length).toBe(0);
  });
});

describe('review regressions', () => {
  it('Gather only works on resources (it used to destroy any target)', () => {
    const g = arena('ironpaw', 'starborn');
    const w = spawn(g, 'hardhat', 0, 20, 20);
    const hall = g.entities.find((e) => e.owner === 1 && e.def.townHall)!;
    const evil = spawn(g, 'spiritbear', 1, 22, 20);
    run(g, 2, [{ p: 0, c: { c: 'gather', ids: [w.id], t: hall.id } }]);
    expect(w.orders.length).toBe(0);
    // even an order that slips through is dropped instead of "mining" the target
    w.orders = [{ t: 'gather', target: evil.id }];
    run(g, 700);
    expect(evil.alive).toBe(true);
    expect(hall.alive).toBe(true);
  });

  it('caps queued orders', () => {
    const g = arena('ironpaw', 'horde');
    const t = spawn(g, 'ranger', 0, 20, 20);
    const cmds = Array.from({ length: 100 }, (_, i) => ({ p: 0, c: { c: 'move', ids: [t.id], x: (10 + (i % 20)) * TILE, y: 10 * TILE, q: true } as Command }));
    run(g, 1, [{ p: 0, c: { c: 'move', ids: [t.id], x: 30 * TILE, y: 30 * TILE } }, ...cmds]);
    expect(t.orders.length).toBeLessThanOrEqual(32);
  });

  it('cancelling a cocoon gives the cub back to its hive', () => {
    const g = arena('horde', 'ironpaw');
    const hive = g.entities.find((e) => e.owner === 0 && e.def.spawnsCubs)!;
    const before = hive.cubs.length;
    run(g, 2, [{ p: 0, c: { c: 'train', ids: [hive.id], d: 'forager' } }]);
    expect(hive.cubs.length).toBe(before - 1);
    const cocoon = g.entities.find((e) => e.owner === 0 && e.def.kind === 'cocoon')!;
    run(g, 2, [{ p: 0, c: { c: 'cancel', id: cocoon.id, slot: -1 } }]);
    expect(cocoon.def.kind).toBe('cub');
    expect(hive.cubs).toContain(cocoon.id);
    // and it can be used again
    run(g, 2, [{ p: 0, c: { c: 'train', ids: [hive.id], d: 'forager' } }]);
    expect(g.entities.filter((e) => e.owner === 0 && e.def.kind === 'cocoon').length).toBe(1);
  });

  it('research lost with its building can be started again', () => {
    const g = arena('ironpaw', 'horde');
    const bay = g.placeBuilding('workshop', 0, 20, 20, true);
    g.players[0].minerals = 1000;
    g.players[0].gas = 1000;
    run(g, 2, [{ p: 0, c: { c: 'research', ids: [bay.id], r: 'inf_w' } }]);
    expect(g.players[0].researching.inf_w).toBe(1);
    g.kill(bay);
    const bay2 = g.placeBuilding('workshop', 0, 26, 20, true);
    const evs = run(g, 2, [{ p: 0, c: { c: 'research', ids: [bay2.id], r: 'inf_w' } }]);
    expect(evs.some((e) => e.k === 'error')).toBe(false);
    expect(bay2.queue.length).toBe(1);
  });

  it('a worker pulled off a mineral frees it', () => {
    const g = arena('ironpaw', 'horde');
    const hall = g.entities.find((e) => e.owner === 0 && e.def.townHall)!;
    const m = g.entities.filter((e) => e.def.kind === 'mineral').sort((a, b) => Math.hypot(a.x - hall.x, a.y - hall.y) - Math.hypot(b.x - hall.x, b.y - hall.y))[0];
    const w = g.spawnUnit('hardhat', 0, m.x, m.y + 24);
    run(g, 40, [{ p: 0, c: { c: 'gather', ids: [w.id], t: m.id } }]);
    expect(m.occupiedBy).toBe(w.id);
    run(g, 2, [{ p: 0, c: { c: 'move', ids: [w.id], x: 30 * TILE, y: 30 * TILE } }]);
    expect(m.occupiedBy).toBe(0);
  });

  it('a build site nobody can reach fails with an error instead of hanging', () => {
    const g = arena('ironpaw', 'horde', true);
    const w = spawn(g, 'hardhat', 0, 24, 20);
    g.players[0].minerals = 1000;
    const evs = run(g, 400, [{ p: 0, c: { c: 'build', ids: [w.id], d: 'larder', tx: 35, ty: 8 } }]);
    expect(evs.some((e) => e.k === 'error' && /reach/.test(e.msg))).toBe(true);
    expect(w.orders.length).toBe(0);
    expect(g.entities.some((e) => e.def.id === 'larder')).toBe(false);
  });

  it('braced Kodiaks focus fire on command', () => {
    const g = arena('ironpaw', 'horde');
    const t = spawn(g, 'kodiak', 0, 20, 20);
    run(g, 70, [{ p: 0, c: { c: 'ability', ids: [t.id], a: 'brace' } }]);
    expect(t.def.id).toBe('kodiak_b');
    const a = spawn(g, 'cavetitan', 1, 28, 20);
    const b = spawn(g, 'cavetitan', 1, 28, 24);
    a.holdPos = b.holdPos = true;
    a.orders = [{ t: 'hold' }];
    b.orders = [{ t: 'hold' }];
    run(g, 2, [{ p: 0, c: { c: 'attack', ids: [t.id], t: b.id } }]);
    expect(t.target).toBe(b.id);
  });
});
