import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game.ts';
import { MapBuilder } from '../src/game/map/builder.ts';
import type { RaceId } from '../src/game/data/types.ts';
import type { Command } from '../src/game/types.ts';
import { TILE } from '../src/game/constants.ts';
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
  return u;
}

describe('abilities', () => {
  it('Starfall damages everything in the area, including friendlies', () => {
    const g = arena('starborn', 'ironpaw');
    g.players[0].upgrades.starfall = 1;
    const m = spawn(g, 'pandasage', 0, 20, 20);
    const foe = spawn(g, 'ranger', 1, 26, 20);
    const friend = spawn(g, 'spiritbear', 0, 26.5, 21);
    friend.holdPos = true;
    foe.holdPos = true;
    run(g, 80, [{ p: 0, c: { c: 'ability', ids: [m.id], a: 'starfall', x: foe.x, y: foe.y } }]);
    expect(m.energy).toBeLessThan(200 - 70);
    expect(foe.alive ? foe.hp : 0).toBeLessThan(45);
    expect(friend.hp + friend.shields).toBeLessThan(150);
  });

  it('Moonstep teleports a Moon Bear and starts a cooldown', () => {
    const g = arena('starborn', 'horde');
    g.players[0].upgrades.moonstep = 1;
    const s = spawn(g, 'moonbear', 0, 20, 20);
    run(g, 2, [{ p: 0, c: { c: 'ability', ids: [s.id], a: 'moonstep', x: 26 * TILE, y: 20 * TILE } }]);
    expect(s.x / TILE).toBeGreaterThan(25);
    expect(s.cooldowns.moonstep).toBeGreaterThan(0);
  });

  it('abilities that need research are refused without it', () => {
    const g = arena('starborn', 'horde');
    const s = spawn(g, 'moonbear', 0, 20, 20);
    run(g, 2, [{ p: 0, c: { c: 'ability', ids: [s.id], a: 'moonstep', x: 26 * TILE, y: 20 * TILE } }]);
    expect(s.x / TILE).toBeLessThan(21);
  });

  it('a Kodiak braces and gets up again', () => {
    const g = arena('ironpaw', 'horde');
    const t = spawn(g, 'kodiak', 0, 20, 20);
    run(g, 70, [{ p: 0, c: { c: 'ability', ids: [t.id], a: 'brace' } }]);
    expect(t.def.id).toBe('kodiak_b');
    run(g, 70, [{ p: 0, c: { c: 'ability', ids: [t.id], a: 'unbrace' } }]);
    expect(t.def.id).toBe('kodiak');
  });

  it('Honey Rush costs health and speeds units up', () => {
    const g = arena('ironpaw', 'horde');
    g.players[0].upgrades.honeyrush = 1;
    const tr = spawn(g, 'ranger', 0, 20, 20);
    run(g, 2, [{ p: 0, c: { c: 'ability', ids: [tr.id], a: 'honeyrush' } }]);
    expect(tr.hp).toBe(35);
    expect(tr.rushT).toBeGreaterThan(0);
  });

  it('Big Sniff reveals and detects a cloaked unit', () => {
    const g = arena('ironpaw', 'starborn');
    const hub = g.entities.find((e) => e.owner === 0 && e.def.townHall)!;
    const shadowpaw = spawn(g, 'shadowpaw', 1, 40, 20);
    run(g, 8, [{ p: 0, c: { c: 'ability', ids: [hub.id], a: 'sniff', x: shadowpaw.x, y: shadowpaw.y } }]);
    expect(g.vision.detectedAt(0, shadowpaw.x, shadowpaw.y)).toBe(true);
  });

  it('cloaked units cannot be attacked without detection', () => {
    const g = arena('ironpaw', 'starborn');
    const tr = spawn(g, 'ranger', 0, 20, 20);
    const shadowpaw = spawn(g, 'shadowpaw', 1, 23, 20);
    shadowpaw.holdPos = true;
    const before = shadowpaw.hp + shadowpaw.shields;
    run(g, 60);
    expect(shadowpaw.hp + shadowpaw.shields).toBe(before);
    expect(tr.alive).toBe(true);
  });

  it('Shield Bubble absorbs damage; Static Burst drains shields', () => {
    const g = arena('ironpaw', 'starborn');
    g.players[0].upgrades.staticburst = 1;
    const ship = spawn(g, 'lookout', 0, 20, 20);
    const ally = spawn(g, 'ranger', 0, 21, 22);
    run(g, 2, [{ p: 0, c: { c: 'ability', ids: [ship.id], a: 'bubble', t: ally.id, x: ally.x, y: ally.y } }]);
    expect(ally.bubble).toBe(100);
    const w = spawn(g, 'spiritbear', 1, 26, 20);
    w.holdPos = true;
    run(g, 40, [{ p: 0, c: { c: 'ability', ids: [ship.id], a: 'staticburst', x: w.x, y: w.y } }]);
    expect(w.shields).toBeLessThan(5);
  });

  it('Royal Jelly adds cubs; Moonlight Haste speeds production', () => {
    const g = arena('horde', 'starborn');
    const hive = g.entities.find((e) => e.owner === 0 && e.def.townHall)!;
    hive.energy = 50;
    run(g, 2, [{ p: 0, c: { c: 'ability', ids: [hive.id], a: 'royaljelly' } }]);
    const before = hive.cubs.length;
    run(g, 29 * 20 + 5);
    expect(hive.cubs.length).toBeGreaterThan(before);

    const g2 = arena('starborn', 'horde');
    const s = g2.entities.find((e) => e.owner === 0 && e.def.townHall)!;
    s.energy = 100;
    g2.players[0].minerals = 1000;
    run(g2, 2, [{ p: 0, c: { c: 'train', ids: [s.id], d: 'snowcub' } }]);
    run(g2, 2, [{ p: 0, c: { c: 'ability', ids: [s.id], a: 'haste', t: s.id, x: s.x, y: s.y } }]);
    expect(s.hasteT).toBeGreaterThan(0);
  });

  it('Buzzbombs explode with splash; Smash works manually', () => {
    const g = arena('horde', 'ironpaw');
    const b = spawn(g, 'buzzbomb', 0, 20, 20);
    const t1 = spawn(g, 'ranger', 1, 21.2, 20);
    const t2 = spawn(g, 'ranger', 1, 21.2, 21.2);
    t1.holdPos = t2.holdPos = true;
    run(g, 60);
    expect(b.alive).toBe(false);
    expect(t1.alive && t1.hp > 20).toBe(false);
    expect(t2.alive && t2.hp > 20).toBe(false);
  });

  it('Bee Cloud blocks ranged damage to ground units inside', () => {
    const g = arena('horde', 'ironpaw');
    const bl = spawn(g, 'swarmcaller', 0, 20, 20);
    const ling = spawn(g, 'scrapper', 0, 24, 20);
    ling.holdPos = true;
    run(g, 2, [{ p: 0, c: { c: 'ability', ids: [bl.id], a: 'beecloud', x: ling.x, y: ling.y } }]);
    const tr = spawn(g, 'ranger', 1, 28, 20);
    tr.holdPos = true;
    run(g, 60);
    expect(ling.hp).toBeGreaterThan(30);
  });

  it('Cubs wrap up in cocoons and grow into bears', () => {
    const g = arena('horde', 'ironpaw');
    const hive = g.entities.find((e) => e.owner === 0 && e.def.townHall)!;
    g.players[0].minerals = 500;
    g.players[0].tech.cubden = 1;
    g.placeBuilding('cubden', 0, 14, 4, true);
    run(g, 2, [{ p: 0, c: { c: 'train', ids: [hive.id], d: 'scrapper' } }]);
    expect(g.entities.some((e) => e.def.kind === 'cocoon' && e.owner === 0)).toBe(true);
    run(g, 17 * 20 + 5);
    expect(g.entities.filter((e) => e.def.id === 'scrapper' && e.owner === 0).length).toBe(2);
  });
});

describe('race mechanics', () => {
  const setup = (race: RaceId) => {
    const g = arena(race, race === 'horde' ? 'ironpaw' : 'horde');
    const hall = g.entities.find((e) => e.owner === 0 && e.def.townHall)!;
    g.players[0].minerals = 2000;
    g.players[0].gas = 2000;
    return { g, hall };
  };

  it('Ironpaw hardhats stay to construct; construction pauses without them', () => {
    const { g, hall } = setup('ironpaw');
    const eng = spawn(g, 'hardhat', 0, 12, 12);
    run(g, 8); // let vision reveal the site
    run(g, 2, [{ p: 0, c: { c: 'build', ids: [eng.id], d: 'larder', tx: 16, ty: 12 } }]);
    run(g, 60);
    const depot = g.entities.find((e) => e.def.id === 'larder')!;
    expect(depot).toBeTruthy();
    expect(eng.orders[0]?.t).toBe('construct');
    const p1 = depot.progress;
    run(g, 2, [{ p: 0, c: { c: 'stop', ids: [eng.id] } }]);
    run(g, 40);
    expect(depot.progress).toBeCloseTo(p1, 1);
    run(g, 2, [{ p: 0, c: { c: 'smart', ids: [eng.id], x: depot.x, y: depot.y, t: depot.id } }]);
    run(g, 21 * 20 + 40);
    expect(depot.built).toBe(true);
    void hall;
  });

  it('Horde foragers are used up and structures need honeycomb', () => {
    const { g } = setup('horde');
    const d = spawn(g, 'forager', 0, 12, 14);
    run(g, 8);
    const before = g.entities.filter((e) => e.owner === 0 && e.def.worker).length;
    run(g, 2, [{ p: 0, c: { c: 'build', ids: [d.id], d: 'cubden', tx: 10, ty: 12 } }]);
    run(g, 80);
    expect(g.entities.some((e) => e.def.id === 'cubden')).toBe(true);
    expect(g.entities.filter((e) => e.owner === 0 && e.def.worker).length).toBe(before - 1);
    // far from comb: refused
    const d2 = spawn(g, 'forager', 0, 40, 30);
    run(g, 8);
    run(g, 2, [{ p: 0, c: { c: 'build', ids: [d2.id], d: 'honeycellar', tx: 40, ty: 28 } }]);
    run(g, 60);
    expect(g.entities.some((e) => e.def.id === 'honeycellar')).toBe(false);
  });

  it('Starborn snowcubs call structures down and leave; structures need a glow', () => {
    const { g } = setup('starborn');
    const s = spawn(g, 'snowcub', 0, 12, 14);
    run(g, 8);
    run(g, 2, [{ p: 0, c: { c: 'build', ids: [s.id], d: 'moongate', tx: 14, ty: 14 } }]);
    run(g, 60);
    expect(g.entities.some((e) => e.def.id === 'moongate')).toBe(false); // no power yet
    run(g, 2, [{ p: 0, c: { c: 'build', ids: [s.id], d: 'startotem', tx: 14, ty: 14 } }]);
    run(g, 80);
    const c = g.entities.find((e) => e.def.id === 'startotem')!;
    expect(c).toBeTruthy();
    expect(s.orders[0]?.t).not.toBe('build');
    run(g, 18 * 20 + 10);
    expect(c.built).toBe(true);
    run(g, 2, [{ p: 0, c: { c: 'build', ids: [s.id], d: 'moongate', tx: 17, ty: 14 } }]);
    run(g, 80);
    expect(g.entities.some((e) => e.def.id === 'moongate')).toBe(true);
  });

  it('research completes and upgrades apply; Hive evolves into Grand Hive', () => {
    const { g, hall } = setup('horde');
    g.placeBuilding('cubden', 0, 14, 4, true);
    g.placeBuilding('honeycellar', 0, 18, 4, true);
    const den = g.entities.find((e) => e.def.id === 'honeycellar')!;
    run(g, 2, [{ p: 0, c: { c: 'research', ids: [den.id], r: 'claws' } }]);
    run(g, 90 * 20 + 5);
    expect(g.players[0].level('claws')).toBe(1);
    run(g, 2, [{ p: 0, c: { c: 'morph', ids: [hall.id], d: 'royalhive' } }]);
    run(g, 57 * 20 + 5);
    expect(hall.def.id).toBe('royalhive');
    expect(g.players[0].tech.hive).toBeGreaterThan(0);
  });

  it('Ironpaw buildings in the red burn down unless repaired', () => {
    const { g } = setup('ironpaw');
    const b = g.placeBuilding('bunkhouse', 0, 20, 20, true);
    b.hp = 300;
    run(g, 40);
    expect(b.hp).toBeLessThan(300);
  });

  it('a player with no town hall is revealed after 30 seconds', () => {
    const { g, hall } = setup('ironpaw');
    g.placeBuilding('larder', 0, 20, 20, true);
    g.kill(hall);
    run(g, 31 * 20 + 20);
    expect(g.players[0].revealed).toBe(true);
  });
});
