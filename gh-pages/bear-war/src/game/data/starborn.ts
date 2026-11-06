import type { EntityDef } from './types.ts';

// STARBORN: mystic polar, spirit and moon bears who draw on starlight. Snowcubs call
// structures down from the sky and are free at once while they take shape. Structures need
// a Star Totem's glow. Every Starborn unit and building wears a regenerating aurora shield.

const S = (attrs: EntityDef['attrs']) => attrs;

export const STARBORN: EntityDef[] = [
  // ---------------------------------------------------------------- units
  {
    id: 'snowcub', name: 'Snowcub', race: 'starborn', kind: 'unit', order: 0,
    desc: 'Worker. A little polar cub with a star on its brow: gathers resources and calls structures down from the sky, then is free to go.',
    cost: { m: 50, g: 0 }, time: 12, supply: 1, cargoSize: 1,
    hp: 20, shields: 20, armor: 0, speed: 3.94, radius: 7, sight: 8, attrs: S(['light', 'mech']),
    worker: true,
    weapons: [{ name: 'Star Spark', dmg: 5, cd: 1.07, range: 0.1, targets: 'ground', melee: true, fx: 'starspark' }],
    abilities: ['gather', 'return', 'build', 'build2'],
  },
  {
    id: 'spiritbear', name: 'Spirit Bear', race: 'starborn', kind: 'unit', order: 1,
    desc: 'White spirit bear with blazing aurora claws. Learns to Pounce once researched.',
    cost: { m: 100, g: 0 }, time: 27, supply: 2, cargoSize: 2,
    hp: 100, shields: 50, armor: 1, speed: 3.15, radius: 11, sight: 9, attrs: S(['light', 'bio']), armorUpg: 'ground_a',
    weapons: [{ name: 'Aurora Claws', dmg: 8, hits: 2, cd: 0.86, range: 0.1, targets: 'ground', melee: true, upg: 'ground_w', fx: 'blade' }],
    abilities: ['pounce'],
  },
  {
    id: 'moonbear', name: 'Moon Bear', race: 'starborn', kind: 'unit', order: 2, requires: ['spiritlodge'],
    desc: 'Agile bear with a glowing crescent that fires moon orbs at ground and air. Can Moonstep short distances.',
    cost: { m: 125, g: 50 }, time: 30, supply: 2, cargoSize: 2,
    hp: 90, shields: 80, armor: 1, speed: 4.13, radius: 14, sight: 10, attrs: S(['armored', 'mech']), armorUpg: 'ground_a',
    weapons: [{
      name: 'Moon Orbs', dmg: 14, bonus: { armored: 5 }, cd: 1.34, range: 6, targets: 'both', upg: 'ground_w', upgDmg: 1, upgBonus: 1,
      proj: 'moonorb', projSpeed: 18, fx: 'moonorb',
    }],
    abilities: ['moonstep'],
  },
  {
    id: 'glacierbear', name: 'Glacier Bear', race: 'starborn', kind: 'unit', order: 3, requires: ['spiritlodge'],
    desc: 'Blue-grey raider whose ice glaives shred light units. Its spirit runs ahead, and the bear follows in a flash.',
    cost: { m: 100, g: 25 }, time: 30, supply: 2, cargoSize: 2,
    hp: 70, shields: 70, armor: 1, speed: 3.5, radius: 10, sight: 9, attrs: S(['light', 'bio']), armorUpg: 'ground_a',
    weapons: [{
      name: 'Frost Glaive', dmg: 10, bonus: { light: 12 }, cd: 1.61, range: 4, targets: 'ground', upg: 'ground_w', upgDmg: 1, upgBonus: 1,
      proj: 'frost', projSpeed: 20, fx: 'frost',
    }],
    abilities: ['spiritwalk'],
  },
  {
    id: 'pandasage', name: 'Panda Sage', race: 'starborn', kind: 'unit', order: 4, requires: ['sagelibrary'],
    desc: 'Floating panda mystic. Starfall tears apart everything caught beneath it, friend or foe.',
    cost: { m: 50, g: 150 }, time: 39, supply: 2, cargoSize: 2,
    hp: 40, shields: 40, armor: 0, speed: 2.62, radius: 10, sight: 10, attrs: S(['light', 'bio', 'psionic']), armorUpg: 'ground_a',
    energy: 200, startEnergy: 50,
    abilities: ['starfall'],
  },
  {
    id: 'shadowpaw', name: 'Shadowpaw', race: 'starborn', kind: 'unit', order: 5, requires: ['sagelibrary'],
    desc: 'Assassin wrapped in shadow. Always hidden unless detected.',
    cost: { m: 125, g: 125 }, time: 39, supply: 2, cloaked: true, cargoSize: 2,
    hp: 40, shields: 80, armor: 1, speed: 3.94, radius: 10, sight: 8, attrs: S(['light', 'bio', 'psionic']), armorUpg: 'ground_a',
    weapons: [{ name: 'Shadow Scythe', dmg: 45, cd: 1.21, range: 0.1, targets: 'ground', melee: true, upg: 'ground_w', upgDmg: 5, fx: 'scythe' }],
  },
  {
    id: 'littledipper', name: 'Little Dipper', race: 'starborn', kind: 'unit', order: 6, air: true,
    desc: 'A tiny bear of stars, nearly invisible. Scouts and detects hidden units.',
    cost: { m: 25, g: 75 }, time: 21, supply: 1, cloaked: true,
    hp: 40, shields: 20, armor: 0, speed: 2.63, radius: 8, sight: 11, detector: 11, attrs: S(['light', 'mech']), armorUpg: 'air_a',
  },
  {
    id: 'floebear', name: 'Floe Bear', race: 'starborn', kind: 'unit', order: 7, air: true,
    desc: 'Polar bear steering a flying ice floe. Carries 8 slots: Snowcubs take 1, warriors 2, Polar Colossi 4.',
    cost: { m: 200, g: 0 }, time: 36, supply: 2,
    hp: 80, shields: 60, armor: 1, speed: 3.5, radius: 17, sight: 8, attrs: S(['armored', 'mech']), armorUpg: 'air_a',
    cargo: 8,
  },
  {
    id: 'snowballer', name: 'Snowballer', race: 'starborn', kind: 'unit', order: 8, requires: ['sagelibrary'],
    desc: 'Polar bear with a crackling star-snowball. Rolls it into the enemy, where it bursts and hurts every ground unit nearby, friend or foe.',
    cost: { m: 150, g: 150 }, time: 36, supply: 3, cargoSize: 4,
    hp: 100, shields: 100, armor: 1, speed: 3.15, radius: 14, sight: 9, attrs: S(['armored', 'mech']), armorUpg: 'ground_a',
    abilities: ['snowball'],
  },
  {
    id: 'polarcolossus', name: 'Polar Colossus', race: 'starborn', kind: 'unit', order: 9,
    desc: 'Towering polar bear in starmetal armor. Its eye beams scorch groups of ground units.',
    cost: { m: 300, g: 200 }, time: 54, supply: 6, cargoSize: 4,
    hp: 200, shields: 150, armor: 1, speed: 3.15, radius: 30, sight: 10, attrs: S(['armored', 'mech', 'massive']), armorUpg: 'ground_a',
    weapons: [{
      name: 'Eye Beams', dmg: 12, hits: 2, bonus: { light: 5 }, cd: 1.07, range: 7, targets: 'ground', upg: 'ground_w', upgDmg: 1, upgBonus: 1,
      splash: { r: [0.9], pct: [1] }, fx: 'eyebeam',
    }],
  },
  {
    id: 'starwing', name: 'Starwing', race: 'starborn', kind: 'unit', order: 10, air: true,
    desc: 'Spirit bear on wings of light. Fast air superiority; attacks air units only.',
    cost: { m: 150, g: 100 }, time: 25, supply: 2,
    hp: 120, shields: 60, armor: 0, speed: 5.95, radius: 12, sight: 10, attrs: S(['light', 'mech']), armorUpg: 'air_a',
    weapons: [{ name: 'Prism Lances', dmg: 5, hits: 2, bonus: { light: 5 }, cd: 0.79, range: 5, targets: 'air', upg: 'air_w', fx: 'prism' }],
  },
  {
    id: 'seer', name: 'Seer', race: 'starborn', kind: 'unit', order: 11, air: true,
    desc: 'Spectacled bear on a floating star disc. Fast raider: lights its Sunlance to burn light ground units, and casts Revelation to expose an area.',
    cost: { m: 150, g: 150 }, time: 37, supply: 3,
    hp: 100, shields: 60, armor: 0, speed: 5.6, radius: 12, sight: 10, attrs: S(['armored', 'mech', 'psionic']), armorUpg: 'air_a',
    energy: 200, startEnergy: 50,
    abilities: ['sunlanceon', 'revelation'],
  },
  {
    id: 'seer_b', name: 'Seer (Sunlance)', race: 'starborn', kind: 'unit', order: 11.5, air: true, base: 'seer', drain: 2.75,
    desc: 'Sunlance lit: a searing beam against ground targets that burns energy every second.',
    cost: { m: 150, g: 150 }, time: 37, supply: 3,
    hp: 100, shields: 60, armor: 0, speed: 5.6, radius: 12, sight: 10, attrs: S(['armored', 'mech', 'psionic']), armorUpg: 'air_a',
    energy: 200, startEnergy: 50,
    weapons: [{ name: 'Sunlance', dmg: 15, bonus: { light: 7 }, cd: 0.61, range: 4, targets: 'ground', upg: 'air_w', fx: 'sunlance' }],
    abilities: ['sunlanceoff', 'revelation'],
  },
  {
    id: 'greatbear', name: 'Great Bear', race: 'starborn', kind: 'unit', order: 12, air: true,
    requires: ['greatbeacon'],
    desc: 'The Great Bear constellation come down to fight. Star bolts at long range against ground; comet lances outrange every flyer.',
    cost: { m: 350, g: 250 }, time: 64, supply: 6,
    hp: 300, shields: 150, armor: 2, speed: 2.62, radius: 38, sight: 12, attrs: S(['armored', 'mech', 'massive']), armorUpg: 'air_a',
    weapons: [
      {
        name: 'Comet Lance', dmg: 30, bonus: { massive: 22 }, cd: 2.6, range: 14, targets: 'air', upg: 'air_w', upgDmg: 3,
        proj: 'starbolt', projSpeed: 18, fx: 'starbolt',
      },
      {
        name: 'Star Bolt', dmg: 30, bonus: { massive: 15 }, cd: 1.9, range: 10, targets: 'ground', upg: 'air_w', upgDmg: 3,
        proj: 'starbolt', projSpeed: 14, fx: 'starbolt',
      },
    ],
  },

  // ---------------------------------------------------------------- buildings
  {
    id: 'startemple', name: 'Star Temple', race: 'starborn', kind: 'building', order: 0, buildPage: 1,
    desc: 'Main base. Trains Snowcubs, accepts resources, and can hasten other structures.',
    cost: { m: 400, g: 0 }, time: 71, provides: 15, size: [5, 5],
    hp: 1000, shields: 1000, armor: 1, sight: 11, attrs: S(['armored', 'structure']),
    produces: ['snowcub'], depot: true, townHall: true, energy: 200, startEnergy: 50,
    abilities: ['haste'],
  },
  {
    id: 'startotem', name: 'Star Totem', race: 'starborn', kind: 'building', order: 1, buildPage: 1,
    desc: 'Provides 8 supply and a glow that other structures need.',
    cost: { m: 100, g: 0 }, time: 18, provides: 8, size: [2, 2], powerRadius: 6.5,
    hp: 200, shields: 200, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
  },
  {
    id: 'dewshrine', name: 'Dew Shrine', race: 'starborn', kind: 'building', order: 2, buildPage: 1,
    desc: 'Called down onto a gas geyser so Snowcubs can harvest gas.',
    cost: { m: 75, g: 0 }, time: 21, size: [3, 3], refinery: true,
    hp: 450, shields: 450, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
  },
  {
    id: 'moongate', name: 'Moon Gate', race: 'starborn', kind: 'building', order: 3, buildPage: 1,
    requires: ['startemple'], needsPower: true,
    desc: 'Calls down ground warriors.',
    cost: { m: 150, g: 0 }, time: 46, size: [3, 3],
    hp: 500, shields: 500, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
    produces: ['spiritbear', 'moonbear', 'glacierbear', 'pandasage', 'shadowpaw'],
  },
  {
    id: 'starforge', name: 'Star Forge', race: 'starborn', kind: 'building', order: 4, buildPage: 1,
    requires: ['startemple'], needsPower: true,
    desc: 'Researches ground weapons, armor and aurora shields. Required for Star Lanterns.',
    cost: { m: 150, g: 0 }, time: 32, size: [3, 3],
    hp: 400, shields: 400, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
    researches: ['ground_w', 'ground_a', 'aurora'],
  },
  {
    id: 'starlantern', name: 'Star Lantern', race: 'starborn', kind: 'building', order: 5, buildPage: 1,
    requires: ['starforge'], needsPower: true,
    desc: 'Defensive lantern that hits ground and air. Detects hidden units.',
    cost: { m: 150, g: 0 }, time: 29, size: [2, 2],
    hp: 150, shields: 150, armor: 1, sight: 11, detector: 11, attrs: S(['armored', 'structure']),
    weapons: [{ name: 'Lantern Bolt', dmg: 20, cd: 0.89, range: 7, targets: 'both', proj: 'lantern', projSpeed: 20, fx: 'lantern' }],
  },
  {
    id: 'spiritlodge', name: 'Spirit Lodge', race: 'starborn', kind: 'building', order: 6, buildPage: 2,
    requires: ['moongate'], needsPower: true,
    desc: 'Unlocks Moon Bears, Glacier Bears and advanced structures. Researches air weapons and armor.',
    cost: { m: 150, g: 0 }, time: 36, size: [3, 3],
    hp: 550, shields: 550, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
    researches: ['air_w', 'air_a'],
  },
  {
    id: 'skyaltar', name: 'Sky Altar', race: 'starborn', kind: 'building', order: 7, buildPage: 2,
    requires: ['spiritlodge'], needsPower: true,
    desc: 'Calls down flyers.',
    cost: { m: 150, g: 150 }, time: 43, size: [3, 3],
    hp: 600, shields: 600, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
    produces: ['starwing', 'seer', 'greatbear'],
  },
  {
    id: 'frostworks', name: 'Frost Works', race: 'starborn', kind: 'building', order: 8, buildPage: 2,
    requires: ['spiritlodge'], needsPower: true,
    desc: 'Builds Little Dippers, Floe Bears, Snowballers and Polar Colossi. Researches Long Gaze.',
    cost: { m: 150, g: 100 }, time: 46, size: [3, 3],
    hp: 450, shields: 450, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
    produces: ['littledipper', 'floebear', 'snowballer', 'polarcolossus'], researches: ['longgaze'],
  },
  {
    id: 'sagelibrary', name: 'Sage Library', race: 'starborn', kind: 'building', order: 9, buildPage: 2,
    requires: ['spiritlodge'], needsPower: true,
    desc: 'Unlocks Panda Sages, Shadowpaws and Snowballers. Researches Pounce, Moonstep and Starfall.',
    cost: { m: 150, g: 150 }, time: 36, size: [3, 3],
    hp: 500, shields: 500, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
    researches: ['pounce', 'moonstep', 'starfall'],
  },
  {
    id: 'greatbeacon', name: 'Great Beacon', race: 'starborn', kind: 'building', order: 10, buildPage: 2,
    requires: ['skyaltar'], needsPower: true,
    desc: 'Unlocks the Great Bear.',
    cost: { m: 300, g: 200 }, time: 43, size: [3, 3],
    hp: 500, shields: 500, armor: 1, sight: 9, attrs: S(['armored', 'structure']),
  },
];
