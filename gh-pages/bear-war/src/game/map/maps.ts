import { GameMap } from './gamemap.ts';
import { MapBuilder, capsule, disc, ellipse, poly, rect, union, warp } from './builder.ts';

const NW = -2.356194490192345; // minerals toward the top-left corner

function twinCraters(): MapBuilder {
  const b = new MapBuilder('twin-craters', 'Twin Craters', 96, 96, 'rot2', 'badlands', 7);
  b.desc = '1v1. Elevated mains overlook a shared shelf with two expansions and two exits.';
  b.fillElev(0);
  // mid-level shelf around the main
  b.setElev(warp(poly([[-2, -2], [60, -2], [60, 16], [45, 30], [30, 45], [16, 60], [-2, 60]]), 1.6, 3), 1);
  // main plateau
  b.setElev(warp(poly([[-2, -2], [33, -2], [33, 17], [27, 27], [17, 33], [-2, 33]]), 1.2, 5), 2);
  // main ramp, down onto the shelf
  b.addRamp(capsule(24.5, 24.5, 30, 30, 5));
  // shelf exits to the low ground
  b.addRamp(capsule(42, 27, 49, 34, 5));
  b.addRamp(capsule(27, 42, 34, 49, 5));
  // centre lake and rock formations (each is mirrored for the other side)
  b.addWater(warp(ellipse(48, 48, 7, 5), 1.5, 11));
  b.addRock(warp(disc(40, 62, 3), 1, 13));
  b.addRock(warp(disc(70, 30, 2.6), 1, 17));
  b.addRock(warp(ellipse(20, 72, 2.5, 3.5), 1, 23));
  // bases (hall centres); the builder mirrors everything for the second player
  b.base(14.5, 14.5, NW, { start: true });
  b.base(46.5, 10.5, -1.25);
  b.base(10.5, 46.5, 2.82);
  b.base(83.5, 12.5, -0.785);
  return b;
}

function frostline(): MapBuilder {
  const b = new MapBuilder('frostline', 'Frostline', 112, 80, 'rot2', 'frost', 21);
  b.desc = '1v1. A wide frozen front: the central lake splits the battlefield into a northern and southern lane.';
  b.fillElev(0);
  // natural shelf south-east of the main, running to the map edge (painted first)
  b.setElev(warp(poly([[22, 50], [44, 48], [54, 52], [56, 62], [54, 84], [22, 84]]), 1.2, 32), 1);
  // main plateau on the west edge
  b.setElev(warp(poly([[-2, 12], [24, 12], [31, 24], [31, 56], [26, 64], [-2, 64]]), 1.3, 31), 2);
  b.addRamp(capsule(26, 58, 31.5, 63, 5));
  b.addRamp(capsule(51, 64, 59, 64, 5));
  // frozen lake in the centre and lane rocks
  b.addWater(warp(ellipse(56, 40, 6.5, 8), 1.4, 33));
  b.addRock(warp(disc(46, 26, 2.6), 1, 34));
  // bases
  b.base(12.5, 38.5, Math.PI, { start: true });
  b.base(38.5, 71.5, 1.57);
  b.base(40.5, 11.5, -1.57);
  return b;
}

function fourCorners(): MapBuilder {
  const b = new MapBuilder('four-corners', 'Four Corners', 128, 128, 'rot4', 'ash', 41);
  b.desc = '4 players (FFA or 2v2). Corner fortresses, edge expansions and a rocky crater in the middle.';
  b.fillElev(0);
  b.setElev(warp(poly([[-2, -2], [31, -2], [31, 18], [25, 27], [16, 31], [-2, 31]]), 1.2, 42), 2);
  b.setElev(warp(union(disc(45, 14, 11.5), rect(33, -3, 57, 14)), 1.2, 43), 1);
  b.addRamp(capsule(28.5, 15.5, 35, 17, 5));
  b.addRamp(capsule(49, 23, 54, 30, 5));
  // central crater
  b.addRock(warp(disc(64, 64, 5), 1.2, 44));
  b.addRock(warp(disc(52, 52, 2.4), 0.8, 45));
  b.addRough(warp(disc(64, 64, 9), 1, 46));
  b.base(13.5, 13.5, NW, { start: true });
  b.base(46.5, 10.5, -1.4);
  b.base(36.5, 42.5, -2.4);
  b.base(72.5, 8.5, -1.57, { small: true });
  return b;
}

export interface MapInfo {
  id: string;
  name: string;
  players: number;
  desc: string;
  build: () => MapBuilder;
}

export const MAPS: MapInfo[] = [
  { id: 'twin-craters', name: 'Twin Craters', players: 2, desc: '1v1: elevated mains, shared shelf expansions.', build: twinCraters },
  { id: 'frostline', name: 'Frostline', players: 2, desc: '1v1: a frozen lake splits the front into two lanes.', build: frostline },
  { id: 'four-corners', name: 'Four Corners', players: 4, desc: '4 players: free-for-all or 2v2 from four corner fortresses.', build: fourCorners },
];

const cache = new Map<string, GameMap>();

export function loadMap(id: string): GameMap {
  let m = cache.get(id);
  if (!m) {
    const info = MAPS.find((x) => x.id === id) ?? MAPS[0];
    const b = info.build();
    m = b.build();
    for (const w of b.warnings) console.warn(w);
    cache.set(id, m);
  }
  return m;
}

export function buildMapWithWarnings(id: string): { map: GameMap; warnings: string[] } {
  const info = MAPS.find((x) => x.id === id) ?? MAPS[0];
  const b = info.build();
  const map = b.build();
  return { map, warnings: b.warnings };
}
