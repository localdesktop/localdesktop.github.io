import type { EntityDef } from './types.ts';

// HONEY HORDE: feral bears living alongside giant bees. Every Hive raises cubs that grow
// into any Horde bear. Foragers are used up when they settle into buildings, which must
// stand on the honeycomb that Hives spread. Horde bears heal over time and run faster on comb.

const S = (attrs: EntityDef['attrs']) => attrs;
const HIVE_UNITS = ['forager', 'bumblebear', 'scrapper', 'stinger', 'hornet', 'denmother', 'longtongue', 'cavetitan', 'swarmcaller'];

export const HORDE: EntityDef[] = [
  // ---------------------------------------------------------------- special
  {
    id: 'cub', name: 'Cub', race: 'horde', kind: 'cub',
    desc: 'Raised by Hives. Can grow into any Horde bear.',
    cost: { m: 0, g: 0 }, time: 0, supply: 0,
    hp: 25, armor: 10, speed: 0.6, radius: 4, sight: 5, attrs: S(['light', 'bio']), priority: 2,
  },
  {
    id: 'cocoon', name: 'Honey Cocoon', race: 'horde', kind: 'cocoon',
    desc: 'A cub sleeping in wax while it grows into a new bear.',
    cost: { m: 0, g: 0 }, time: 0, supply: 0,
    hp: 200, armor: 10, speed: 0, radius: 8, sight: 5, attrs: S(['bio']), priority: 3,
  },

  // ---------------------------------------------------------------- units
  {
    id: 'forager', name: 'Forager', race: 'horde', kind: 'unit', order: 0,
    desc: 'Worker. Gathers resources and settles into Horde structures (it is used up).',
    cost: { m: 50, g: 0 }, time: 12, supply: 1, cargoSize: 1,
    hp: 40, armor: 0, speed: 3.94, radius: 7, sight: 8, attrs: S(['light', 'bio']),
    worker: true,
    weapons: [{ name: 'Little Claws', dmg: 5, cd: 1.07, range: 0.1, targets: 'ground', melee: true, fx: 'claw' }],
    abilities: ['gather', 'return', 'build', 'build2'],
  },
  {
    id: 'bumblebear', name: 'Bumblebear', race: 'horde', kind: 'unit', order: 1,
    desc: 'A fuzzy striped bear buzzing along on tiny wings. Provides 8 supply and detects hidden units. With Cargo Pouch it carries 8 slots of ground units.',
    cost: { m: 100, g: 0 }, time: 18, supply: 0, provides: 8, air: true,
    hp: 200, armor: 0, speed: 0.9, radius: 20, sight: 11, detector: 8, attrs: S(['armored', 'bio']),
    armorUpg: 'flyer_a', priority: 10, cargo: 8, cargoReq: 'pouch',
  },
  {
    id: 'scrapper', name: 'Scrapper', race: 'horde', kind: 'unit', order: 2, count: 2,
    requires: ['cubden'],
    desc: 'Fast, cheap feral cubs. Come in pairs. Can grow into Buzzbombs.',
    cost: { m: 50, g: 0 }, time: 17, supply: 0.5, cargoSize: 1,
    hp: 35, armor: 0, speed: 4.13, radius: 5, sight: 8, attrs: S(['light', 'bio']), armorUpg: 'hide',
    weapons: [{ name: 'Tiny Claws', dmg: 5, cd: 0.5, range: 0.1, targets: 'ground', melee: true, upg: 'claws', fx: 'claw' }],
    unitMorphs: ['buzzbomb'],
  },
  {
    id: 'buzzbomb', name: 'Buzzbomb', race: 'horde', kind: 'unit', order: 3, morphFrom: 'scrapper',
    requires: ['apiary'],
    desc: 'A cub hugging a stolen beehive. Rushes into enemies and smashes it: the furious swarm devastates light units and buildings.',
    cost: { m: 25, g: 25 }, time: 14, supply: 0.5, cargoSize: 1,
    hp: 30, armor: 0, speed: 3.5, radius: 7, sight: 8, attrs: S(['bio']), armorUpg: 'hide',
    weapons: [{
      name: 'Hive Smash', dmg: 16, bonus: { light: 19, structure: 64 }, cd: 0.8, range: 0.2, targets: 'ground',
      melee: true, upg: 'claws', upgDmg: 2, upgBonus: 2, splash: { r: [2.2], pct: [1] }, suicide: true, fx: 'burst',
    }],
    abilities: ['smash'],
  },
  {
    id: 'stinger', name: 'Stinger', race: 'horde', kind: 'unit', order: 4, requires: ['stingerden'],
    desc: 'Shaggy bear that flings barbed stingers at ground and air. Can grow into a Bombardier or a Burrower.',
    cost: { m: 100, g: 50 }, time: 24, supply: 2, cargoSize: 2,
    hp: 100, armor: 0, speed: 3.15, radius: 10, sight: 9, attrs: S(['light', 'bio']), armorUpg: 'hide',
    weapons: [{
      name: 'Stinger Volley', dmg: 12, cd: 0.59, range: 5, targets: 'both', upg: 'stings', proj: 'quill', projSpeed: 26, fx: 'quill',
    }],
    unitMorphs: ['bombardier', 'burrower'],
  },
  {
    id: 'bombardier', name: 'Bombardier', race: 'horde', kind: 'unit', order: 5, morphFrom: 'stinger',
    requires: ['stingerden'],
    desc: 'Stocky bear with bulging honey sacs. Spits honey, and lobs Scalding Honey that lands on a spot moments later.',
    cost: { m: 25, g: 75 }, time: 9, supply: 3, cargoSize: 4,
    hp: 120, armor: 1, speed: 3.85, radius: 13, sight: 9, attrs: S(['bio']), armorUpg: 'hide',
    weapons: [{
      name: 'Honey Spit', dmg: 16, cd: 1.14, range: 6, targets: 'ground', upg: 'stings', proj: 'honey', projSpeed: 18, fx: 'honey',
    }],
    abilities: ['scaldinghoney'],
  },
  {
    id: 'burrower', name: 'Burrower', race: 'horde', kind: 'unit', order: 6, morphFrom: 'stinger',
    requires: ['burrowden'],
    desc: 'Spiny armored bear. Hibernates underground, hidden, and erupts spines through every enemy in a line.',
    cost: { m: 50, g: 100 }, time: 18, supply: 3, cargoSize: 4,
    hp: 190, armor: 1, speed: 4.13, radius: 14, sight: 10, attrs: S(['armored', 'bio']), armorUpg: 'hide',
    abilities: ['hibernate'],
  },
  {
    id: 'burrower_b', name: 'Burrower (Hibernating)', race: 'horde', kind: 'unit', order: 6.5, base: 'burrower',
    desc: 'Hidden under the comb until detected. Spines erupt in a long line, hitting every enemy ground unit and structure along it.',
    cost: { m: 50, g: 100 }, time: 18, supply: 3, cloaked: true, burrowed: true,
    hp: 190, armor: 1, speed: 0, radius: 14, sight: 10, attrs: S(['armored', 'bio']), armorUpg: 'hide',
    weapons: [{
      name: 'Spine Eruption', dmg: 20, bonus: { armored: 10 }, cd: 1.43, range: 8, line: 0.5, targets: 'ground',
      upg: 'stings', upgDmg: 2, upgBonus: 1, fx: 'eruption',
    }],
    abilities: ['wakeup'],
  },
  {
    id: 'hornet', name: 'Hornet', race: 'horde', kind: 'unit', order: 7, requires: ['hornetnest'], air: true,
    desc: 'Wasp-winged bear. Its stinger bounces between up to three targets.',
    cost: { m: 100, g: 100 }, time: 24, supply: 2,
    hp: 120, armor: 0, speed: 5.6, radius: 12, sight: 11, attrs: S(['light', 'bio']), armorUpg: 'flyer_a',
    weapons: [{
      name: 'Bouncing Stinger', dmg: 9, cd: 1.52, range: 3, targets: 'both', upg: 'flyer_w', proj: 'glaive', projSpeed: 20,
      bounce: { n: 2, falloff: 3, range: 3 }, fx: 'glaive',
    }],
  },
  {
    id: 'denmother', name: 'Den Mother', race: 'horde', kind: 'unit', order: 8, requires: ['swarmpit'],
    desc: 'Big she-bear carrying a den on her back. Releases Wild Cubs that rush the enemy and fade after 18 seconds.',
    cost: { m: 100, g: 75 }, time: 29, supply: 3, cargoSize: 4,
    hp: 160, armor: 1, speed: 3.15, radius: 16, sight: 10, attrs: S(['armored', 'bio']), armorUpg: 'hide',
    abilities: ['releasecubs'],
  },
  {
    id: 'wildcub', name: 'Wild Cub', race: 'horde', kind: 'unit', order: 8.5, lifetime: 18,
    desc: 'Released by a Den Mother. Free, fierce, and gone after 18 seconds.',
    cost: { m: 0, g: 0 }, time: 0, supply: 0,
    hp: 50, armor: 0, speed: 4.13, radius: 5, sight: 6, attrs: S(['light', 'bio']), armorUpg: 'hide',
    weapons: [{ name: 'Feral Bite', dmg: 10, cd: 0.6, range: 0.1, targets: 'ground', melee: true, upg: 'claws', fx: 'claw' }],
  },
  {
    id: 'longtongue', name: 'Longtongue', race: 'horde', kind: 'unit', order: 9, requires: ['elderhive'], air: true,
    desc: 'Winged sun bear with an absurdly long tongue. Yanks enemies close, blinds gunners with Pollen Cloud and sets Hornet Bombs on flyers.',
    cost: { m: 100, g: 200 }, time: 29, supply: 3,
    hp: 150, armor: 1, speed: 4.13, radius: 14, sight: 11, attrs: S(['armored', 'bio', 'psionic']), armorUpg: 'flyer_a',
    energy: 200, startEnergy: 50,
    abilities: ['yank', 'pollen', 'hornetbomb'],
  },
  {
    id: 'cavetitan', name: 'Cave Titan', race: 'horde', kind: 'unit', order: 10, requires: ['titancavern'],
    desc: 'Colossal prehistoric cave bear in honeycomb armor. Its claws cleave through groups of ground units.',
    cost: { m: 275, g: 200 }, time: 39, supply: 6, cargoSize: 4,
    hp: 500, armor: 2, speed: 4.13, radius: 34, sight: 9, attrs: S(['armored', 'bio', 'massive']), armorUpg: 'hide',
    weapons: [{
      name: 'Titan Claws', dmg: 35, cd: 0.61, range: 1, targets: 'ground', melee: true, upg: 'claws', upgDmg: 3,
      splash: { r: [0.8], pct: [0.33] }, fx: 'maul',
    }],
  },
  {
    id: 'swarmcaller', name: 'Swarmcaller', race: 'horde', kind: 'unit', order: 11, requires: ['swarmpit'],
    desc: 'Bear shaman wreathed in bees. Bee Cloud shields ground units from ranged attacks; Sting Swarm wears down everything in an area.',
    cost: { m: 100, g: 150 }, time: 36, supply: 2, cargoSize: 2,
    hp: 90, armor: 0, speed: 3.15, radius: 12, sight: 10, attrs: S(['armored', 'bio', 'psionic']), armorUpg: 'hide',
    energy: 200, startEnergy: 50,
    abilities: ['beecloud', 'stingswarm'],
  },

  // ---------------------------------------------------------------- buildings
  {
    id: 'hive', name: 'Great Hive', race: 'horde', kind: 'building', order: 0, buildPage: 1,
    desc: 'Main base. Raises cubs, accepts resources and spreads honeycomb. Can grow into a Royal Hive.',
    cost: { m: 300, g: 0 }, time: 71, provides: 6, size: [5, 5],
    hp: 1500, armor: 1, sight: 12, attrs: S(['armored', 'bio', 'structure']),
    produces: HIVE_UNITS,
    spawnsCubs: true, depot: true, townHall: true, combRadius: 11, energy: 200, startEnergy: 25,
    abilities: ['royaljelly'], morphs: ['royalhive'],
  },
  {
    id: 'royalhive', name: 'Royal Hive', race: 'horde', kind: 'building', counts: ['hive'], art: 'hive',
    desc: 'Grown Hive. Unlocks advanced Horde tech. Can grow into an Elder Hive.',
    cost: { m: 150, g: 100 }, time: 57, provides: 6, size: [5, 5], requires: ['cubden'],
    hp: 2000, armor: 1, sight: 12, attrs: S(['armored', 'bio', 'structure']),
    produces: HIVE_UNITS,
    spawnsCubs: true, depot: true, townHall: true, combRadius: 12, energy: 200, startEnergy: 25,
    abilities: ['royaljelly'], morphs: ['elderhive'],
  },
  {
    id: 'elderhive', name: 'Elder Hive', race: 'horde', kind: 'building', counts: ['hive', 'royalhive'], art: 'hive',
    desc: 'Ancient Hive. Unlocks the mightiest Horde bears.',
    cost: { m: 200, g: 150 }, time: 71, provides: 6, size: [5, 5], requires: ['swarmpit'],
    hp: 2500, armor: 1, sight: 12, attrs: S(['armored', 'bio', 'structure']),
    produces: HIVE_UNITS,
    spawnsCubs: true, depot: true, townHall: true, combRadius: 13, energy: 200, startEnergy: 25,
    abilities: ['royaljelly'],
  },
  {
    id: 'nectartap', name: 'Nectar Tap', race: 'horde', kind: 'building', order: 1, buildPage: 1,
    desc: 'Grown onto a gas geyser so Foragers can harvest gas.',
    cost: { m: 25, g: 0 }, time: 21, size: [3, 3], refinery: true,
    hp: 500, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
  },
  {
    id: 'cubden', name: 'Cub Den', race: 'horde', kind: 'building', order: 2, buildPage: 1,
    requires: ['hive'], needsComb: true,
    desc: 'Unlocks Scrappers and defensive growths. Researches Zoomies.',
    cost: { m: 200, g: 0 }, time: 46, size: [3, 3],
    hp: 1000, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
    researches: ['zoomies'],
  },
  {
    id: 'honeycellar', name: 'Honey Cellar', race: 'horde', kind: 'building', order: 3, buildPage: 1,
    requires: ['hive'], needsComb: true,
    desc: 'Researches claw, sting and hide upgrades, and Bumblebear wings and pouches.',
    cost: { m: 75, g: 0 }, time: 25, size: [3, 3],
    hp: 750, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
    researches: ['claws', 'stings', 'hide', 'biggerwings', 'pouch'],
  },
  {
    id: 'thornstump', name: 'Thorn Stump', race: 'horde', kind: 'building', order: 4, buildPage: 1,
    requires: ['cubden'], needsComb: true,
    desc: 'Defensive growth that impales ground units.',
    cost: { m: 100, g: 0 }, time: 36, size: [2, 2], combRadius: 3,
    hp: 300, armor: 2, sight: 11, attrs: S(['armored', 'bio', 'structure']),
    weapons: [{ name: 'Thorn Spike', dmg: 25, bonus: { armored: 5 }, cd: 1.85, range: 7, targets: 'ground', fx: 'thorn' }],
  },
  {
    id: 'stingtower', name: 'Sting Tower', race: 'horde', kind: 'building', order: 5, buildPage: 1,
    requires: ['cubden'], needsComb: true,
    desc: 'Anti-air hive of guard bees. Detects hidden units.',
    cost: { m: 75, g: 0 }, time: 21, size: [2, 2], combRadius: 3,
    hp: 400, armor: 1, sight: 11, detector: 11, attrs: S(['armored', 'bio', 'structure']),
    weapons: [{
      name: 'Sting Burst', dmg: 15, bonus: { bio: 15 }, cd: 0.61, range: 7, targets: 'air', proj: 'sting', projSpeed: 20, fx: 'sting',
    }],
  },
  {
    id: 'apiary', name: 'Apiary', race: 'horde', kind: 'building', order: 6, buildPage: 1,
    requires: ['cubden'], needsComb: true,
    desc: 'Lets Scrappers grow into Buzzbombs. Researches Busy Bees.',
    cost: { m: 100, g: 50 }, time: 43, size: [3, 3],
    hp: 850, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
    researches: ['busybees'],
  },
  {
    id: 'stingerden', name: 'Stinger Den', race: 'horde', kind: 'building', order: 7, buildPage: 2,
    requires: ['royalhive'], needsComb: true,
    desc: 'Unlocks Stingers and Bombardiers. Researches stinger range and speed.',
    cost: { m: 100, g: 100 }, time: 29, size: [3, 3],
    hp: 850, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
    researches: ['longstingers', 'boundinggait'],
  },
  {
    id: 'burrowden', name: 'Burrow Den', race: 'horde', kind: 'building', order: 8, buildPage: 2,
    requires: ['royalhive', 'stingerden'], needsComb: true,
    desc: 'Lets Stingers grow into Burrowers.',
    cost: { m: 100, g: 150 }, time: 57, size: [3, 3],
    hp: 850, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
  },
  {
    id: 'hornetnest', name: 'Hornet Nest', race: 'horde', kind: 'building', order: 9, buildPage: 2,
    requires: ['royalhive'], needsComb: true,
    desc: 'Unlocks Hornets. Researches flyer stings and hide.',
    cost: { m: 200, g: 200 }, time: 71, size: [3, 3],
    hp: 850, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
    researches: ['flyer_w', 'flyer_a'],
  },
  {
    id: 'swarmpit', name: 'Swarm Pit', race: 'horde', kind: 'building', order: 10, buildPage: 2,
    requires: ['royalhive'], needsComb: true,
    desc: 'Unlocks Swarmcallers, Den Mothers and the Elder Hive. Researches Sting Swarm.',
    cost: { m: 100, g: 100 }, time: 36, size: [3, 3],
    hp: 850, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
    researches: ['stingswarm'],
  },
  {
    id: 'titancavern', name: 'Titan Cavern', race: 'horde', kind: 'building', order: 11, buildPage: 2,
    requires: ['elderhive'], needsComb: true,
    desc: 'Unlocks Cave Titans. Researches Honeycomb Armor.',
    cost: { m: 150, g: 200 }, time: 46, size: [3, 3],
    hp: 850, armor: 1, sight: 9, attrs: S(['armored', 'bio', 'structure']),
    researches: ['combarmor'],
  },
];
