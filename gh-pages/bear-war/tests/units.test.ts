import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game.ts';
import { MapBuilder } from '../src/game/map/builder.ts';
import type { RaceId } from '../src/game/data/types.ts';
import type { Command } from '../src/game/types.ts';
import { TICK_RATE, TILE } from '../src/game/constants.ts';
import type { Entity } from '../src/game/entity.ts';

function arena(r0: RaceId, r1: RaceId): Game {
  const b = new MapBuilder('arena', 'Arena', 64, 40, 'none', 'badlands', 1);
  b.fillElev(0);
  b.base(6.5, 6.5, -2.3, { start: true });
  b.base(57.5, 33.5, 0.8, { start: true });
  const g = new Game({ map: b.build(), seed: 5, players: [{ name: 'A', race: r0, color: 0, team: 0 }, { name: 'B', race: r1, color: 1, team: 1 }] });
  for (const e of g.entities) if (e.def.worker || e.def.id === 'bumblebear') g.removeSilently(e);
  for (const p of g.players) p.supplyMax = 200;
  return g;
}

const run = (g: Game, ticks: number, cmds: { p: number; c: Command }[] = []) => {
  g.step(cmds);
  for (let i = 1; i < ticks; i++) g.step([]);
};

function spawn(g: Game, id: string, owner: number, tx: number, ty: number): Entity {
  const u = g.spawnUnit(id, owner, tx * TILE, ty * TILE);
  u.energy = u.def.energy ?? 0;
  u.holdPos = true;
  return u;
}

const ability = (u: Entity, a: string, x?: number, y?: number, t?: Entity) => [{ p: u.owner, c: { c: 'ability', ids: [u.id], a, x, y, t: t?.id } as Command }];

describe('modes', () => {
  it('a dug-in Sapper hides and its keg splashes friend and foe', () => {
    const g = arena('ironpaw', 'horde');
    const s = spawn(g, 'sapper', 0, 20, 20);
    run(g, 2, ability(s, 'digin'));
    run(g, 2.2 * TICK_RATE);
    expect(s.def.id).toBe('sapper_b');
    expect(s.def.cloaked).toBe(true);
    const friend = spawn(g, 'ranger', 0, 24, 21);
    const foe = spawn(g, 'stinger', 1, 24, 20);
    run(g, 40);
    expect(foe.alive).toBe(false);
    expect(friend.hp).toBeLessThan(45);
    expect(s.cds[0]).toBeGreaterThan(10 * TICK_RATE);
  });

  it('Blaze Riders need an Armory to hop off', () => {
    const g = arena('ironpaw', 'horde');
    const r = spawn(g, 'blazerider', 0, 20, 20);
    run(g, 3 * TICK_RATE, ability(r, 'hopoff'));
    expect(r.def.id).toBe('blazerider');
    g.placeBuilding('armory', 0, 30, 4, true);
    run(g, 3 * TICK_RATE, ability(r, 'hopoff'));
    expect(r.def.id).toBe('blazebrute');
    expect(r.hp).toBe(135);
  });

  it('an anchored Hoverbear only hits ground units inside its zone', () => {
    const g = arena('ironpaw', 'horde');
    const h = spawn(g, 'hoverbear', 0, 20, 20);
    run(g, 3 * TICK_RATE, ability(h, 'anchor', 24 * TILE, 20 * TILE));
    expect(h.def.id).toBe('hoverbear_a');
    const outside = spawn(g, 'stinger', 1, 15, 20);
    const inside = spawn(g, 'stinger', 1, 25, 20);
    run(g, 3 * TICK_RATE);
    expect(outside.hp).toBe(100);
    expect(inside.alive).toBe(false);
  });

  it('the Seer burns energy with its Sunlance lit and douses it when empty', () => {
    const g = arena('starborn', 'horde');
    const s = spawn(g, 'seer', 0, 20, 20);
    s.energy = 30;
    run(g, 2, ability(s, 'sunlanceon'));
    expect(s.def.id).toBe('seer_b');
    run(g, 4 * TICK_RATE);
    expect(s.def.id).toBe('seer');
  });
});

describe('new abilities', () => {
  it('Lock On keeps hurting its target until it leaves the leash', () => {
    const g = arena('ironpaw', 'starborn');
    const t = spawn(g, 'tracker', 0, 20, 20);
    const foe = spawn(g, 'polarcolossus', 1, 26, 20);
    foe.def = { ...foe.def, weapons: undefined };
    run(g, 2, ability(t, 'lockon', foe.x, foe.y, foe));
    const before = foe.hp + foe.shields;
    run(g, 4 * TICK_RATE);
    expect(before - (foe.hp + foe.shields)).toBeGreaterThan(80);
    expect(t.lockT).toBeGreaterThan(0);
    foe.x += 30 * TILE;
    run(g, 2);
    expect(t.lockT).toBe(0);
  });

  it('Wild Cubs rush out of the Den Mother and fade after 18 seconds', () => {
    const g = arena('horde', 'ironpaw');
    const d = spawn(g, 'denmother', 0, 20, 20);
    run(g, 2, ability(d, 'releasecubs', 40 * TILE, 20 * TILE));
    expect(g.entities.filter((e) => e.def.id === 'wildcub').length).toBe(2);
    run(g, 18 * TICK_RATE);
    expect(g.entities.filter((e) => e.def.id === 'wildcub').length).toBe(0);
  });

  it('Yank pulls a unit next to the Longtongue', () => {
    const g = arena('horde', 'ironpaw');
    const l = spawn(g, 'longtongue', 0, 20, 20);
    const k = spawn(g, 'kodiak', 1, 28, 20);
    run(g, 2, ability(l, 'yank', k.x, k.y, k));
    expect(Math.hypot(k.x - l.x, k.y - l.y)).toBeLessThan(l.r + k.r + 2 * TILE);
  });

  it('Pollen Cloud cuts enemy ranged attacks down to melee range', () => {
    const g = arena('horde', 'ironpaw');
    const l = spawn(g, 'longtongue', 0, 20, 30);
    const r = spawn(g, 'ranger', 1, 20, 20);
    const victim = spawn(g, 'scrapper', 0, 24, 20);
    run(g, 2, ability(l, 'pollen', r.x, r.y));
    run(g, 3 * TICK_RATE);
    expect(victim.hp).toBe(35);
  });

  it('Scalding Honey lands 2.5 seconds after it is thrown', () => {
    const g = arena('horde', 'ironpaw');
    const b = spawn(g, 'bombardier', 0, 20, 20);
    b.def = { ...b.def, weapons: undefined };
    const foe = spawn(g, 'grizzly', 1, 27, 20);
    run(g, 2, ability(b, 'scaldinghoney', foe.x, foe.y));
    run(g, 2 * TICK_RATE);
    expect(foe.hp).toBe(125);
    run(g, TICK_RATE);
    expect(foe.hp).toBeLessThan(125 - 50);
  });

  it('a hibernating Burrower hits every enemy along its line', () => {
    const g = arena('horde', 'ironpaw');
    const b = spawn(g, 'burrower', 0, 20, 20);
    run(g, 2 * TICK_RATE, ability(b, 'hibernate'));
    expect(b.def.id).toBe('burrower_b');
    const near = spawn(g, 'ranger', 1, 23, 20);
    const far = spawn(g, 'ranger', 1, 27, 20);
    run(g, 10);
    expect(near.hp).toBeLessThan(45);
    expect(far.hp).toBeLessThan(45);
  });

  it('Spirit Walk moves the Glacier Bear to its spirit after 7 seconds', () => {
    const g = arena('starborn', 'horde');
    const gb = spawn(g, 'glacierbear', 0, 20, 20);
    run(g, 2, ability(gb, 'spiritwalk', 40 * TILE, 20 * TILE));
    run(g, 6 * TICK_RATE);
    expect(gb.x).toBeLessThan(22 * TILE);
    run(g, 1.2 * TICK_RATE);
    expect(gb.x).toBeGreaterThan(38 * TILE);
  });

  it('the Star Snowball bursts on friend and foe alike', () => {
    const g = arena('starborn', 'horde');
    const s = spawn(g, 'snowballer', 0, 20, 20);
    const friend = spawn(g, 'spiritbear', 0, 26, 21);
    const foe = spawn(g, 'stinger', 1, 26, 20);
    run(g, 2, ability(s, 'snowball', 26 * TILE, 20 * TILE));
    run(g, 2.2 * TICK_RATE);
    expect(foe.alive).toBe(false);
    expect(friend.shields + friend.hp).toBeLessThan(150 - 100);
  });
});
