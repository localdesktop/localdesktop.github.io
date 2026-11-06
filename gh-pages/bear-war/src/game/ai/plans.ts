import type { RaceId } from '../data/types.ts';
import type { AIDifficulty } from '../player.ts';

export interface TechStep {
  supply: number;
  build?: string;
  research?: string;
  morph?: string;
  expand?: boolean;
}

export interface CompEntry {
  unit: string;
  weight: number;
  /** extra weight when the enemy fields air units */
  vsAir?: number;
  /** extra weight when the enemy has many light units */
  vsLight?: number;
  /** extra weight when the enemy has armored units */
  vsArmored?: number;
  /** cap on how many to keep */
  max?: number;
}

export interface RacePlan {
  opening: TechStep[];
  comp: CompEntry[];
  /** production structure targets: [structure id, [supply thresholds...]], one more building per threshold passed */
  production: [string, number[]][];
  /** upgrade lines researched in the late game, in priority order */
  upgrades: string[];
  detector: { building: string; unit?: string };
}

export const PLANS: Record<RaceId, RacePlan> = {
  ironpaw: {
    opening: [
      { supply: 14, build: 'larder' },
      { supply: 15, build: 'bunkhouse' },
      { supply: 16, build: 'refinery' },
      { supply: 19, expand: true },
      { supply: 20, build: 'steamworks' },
      { supply: 21, build: 'academy' },
      { supply: 22, build: 'refinery' },
      { supply: 24, research: 'honeyrush' },
      { supply: 30, build: 'workshop' },
      { supply: 32, research: 'thickfur' },
      { supply: 34, research: 'inf_w' },
      { supply: 38, build: 'airfield' },
      { supply: 44, build: 'armory' },
      { supply: 48, build: 'refinery' },
      { supply: 50, research: 'inf_a' },
      { supply: 58, expand: true },
      { supply: 60, build: 'refinery' },
      { supply: 66, build: 'sciencelab' },
      { supply: 70, research: 'veh_w' },
      { supply: 84, research: 'grandcannon' },
      { supply: 100, expand: true },
    ],
    comp: [
      { unit: 'ranger', weight: 4 },
      { unit: 'grizzly', weight: 2, vsArmored: 1.5 },
      { unit: 'medic', weight: 1, max: 8 },
      { unit: 'blazerider', weight: 0.6, vsLight: 1.2, max: 8 },
      { unit: 'sapper', weight: 0.4, max: 6 },
      { unit: 'tracker', weight: 0.8, vsArmored: 0.6, vsAir: 0.6 },
      { unit: 'kodiak', weight: 2.2, vsArmored: 1 },
      { unit: 'ironhide', weight: 0.8, vsAir: 2.5 },
      { unit: 'barnstormer', weight: 0.4, vsAir: 2 },
      { unit: 'hoverbear', weight: 0.5, vsAir: 1.5 },
      { unit: 'lookout', weight: 0.2, max: 2 },
      { unit: 'ironmama', weight: 1.4 },
    ],
    production: [
      ['bunkhouse', [0, 26, 40, 70, 110]],
      ['steamworks', [0, 60]],
      ['airfield', [0, 100]],
    ],
    upgrades: ['inf_w', 'inf_a', 'veh_w', 'veh_a', 'ship_w', 'staticburst'],
    detector: { building: 'flakturret', unit: 'lookout' },
  },
  horde: {
    opening: [
      { supply: 16, expand: true },
      { supply: 17, build: 'nectartap' },
      { supply: 17, build: 'cubden' },
      { supply: 24, research: 'zoomies' },
      { supply: 28, morph: 'royalhive' },
      { supply: 30, build: 'nectartap' },
      { supply: 32, build: 'honeycellar' },
      { supply: 34, build: 'apiary' },
      { supply: 36, build: 'stingerden' },
      { supply: 40, research: 'stings' },
      { supply: 44, build: 'nectartap' },
      { supply: 46, research: 'longstingers' },
      { supply: 50, research: 'biggerwings' },
      { supply: 52, expand: true },
      { supply: 54, build: 'hornetnest' },
      { supply: 58, research: 'claws' },
      { supply: 60, build: 'swarmpit' },
      { supply: 64, build: 'nectartap' },
      { supply: 66, research: 'hide' },
      { supply: 72, morph: 'elderhive' },
      { supply: 74, build: 'burrowden' },
      { supply: 80, build: 'titancavern' },
      { supply: 90, research: 'combarmor' },
      { supply: 100, expand: true },
    ],
    comp: [
      { unit: 'scrapper', weight: 3, vsArmored: -1 },
      { unit: 'stinger', weight: 3, vsAir: 2 },
      { unit: 'hornet', weight: 1.6, vsAir: 1 },
      { unit: 'cavetitan', weight: 2, vsLight: 1 },
      { unit: 'swarmcaller', weight: 0.4, max: 4 },
      { unit: 'denmother', weight: 0.5, max: 4 },
      { unit: 'longtongue', weight: 0.3, max: 2 },
    ],
    production: [],
    upgrades: ['stings', 'claws', 'hide', 'flyer_w', 'flyer_a', 'boundinggait', 'busybees', 'stingswarm'],
    detector: { building: 'stingtower' },
  },
  starborn: {
    opening: [
      { supply: 14, build: 'startotem' },
      { supply: 16, build: 'moongate' },
      { supply: 16, build: 'dewshrine' },
      { supply: 19, build: 'spiritlodge' },
      { supply: 20, build: 'dewshrine' },
      { supply: 21, expand: true },
      { supply: 30, build: 'starforge' },
      { supply: 32, build: 'sagelibrary' },
      { supply: 34, research: 'ground_w' },
      { supply: 36, research: 'pounce' },
      { supply: 42, build: 'frostworks' },
      { supply: 46, build: 'dewshrine' },
      { supply: 48, research: 'moonstep' },
      { supply: 52, build: 'dewshrine' },
      { supply: 54, expand: true },
      { supply: 60, research: 'starfall' },
      { supply: 64, build: 'skyaltar' },
      { supply: 70, research: 'ground_a' },
      { supply: 76, build: 'greatbeacon' },
      { supply: 100, expand: true },
    ],
    comp: [
      { unit: 'spiritbear', weight: 3, vsLight: 0.5 },
      { unit: 'moonbear', weight: 3, vsAir: 2, vsArmored: 1 },
      { unit: 'glacierbear', weight: 1, vsLight: 1.2 },
      { unit: 'pandasage', weight: 0.6, max: 6 },
      { unit: 'shadowpaw', weight: 0.4, max: 4 },
      { unit: 'polarcolossus', weight: 1.4, vsLight: 1 },
      { unit: 'starwing', weight: 0.6, vsAir: 2.5 },
      { unit: 'seer', weight: 0.3, max: 3 },
      { unit: 'snowballer', weight: 0.4, max: 3 },
      { unit: 'greatbear', weight: 1.2 },
    ],
    production: [
      ['moongate', [0, 24, 36, 56, 80, 110]],
      ['frostworks', [42]],
      ['skyaltar', [64, 120]],
    ],
    upgrades: ['ground_w', 'ground_a', 'aurora', 'air_w', 'air_a', 'longgaze'],
    detector: { building: 'starlantern', unit: 'littledipper' },
  },
};

export interface DiffCfg {
  think: number;
  maxWorkers: number;
  attackSupply: number;
  firstAttackTime: number;
  micro: boolean;
  scout: boolean;
  income: number;
  maxBases: number;
  /** multiplier on opening supply thresholds (slower AIs build later) */
  slow: number;
  /** fraction of production buildings it bothers to build */
  prodScale: number;
  /** maximum commands issued per think */
  apm: number;
}

export const DIFFICULTY: Record<AIDifficulty, DiffCfg> = {
  easy: { think: 40, maxWorkers: 22, attackSupply: 24, firstAttackTime: 480, micro: false, scout: false, income: 1, maxBases: 2, slow: 1.4, prodScale: 0.5, apm: 3 },
  normal: { think: 20, maxWorkers: 44, attackSupply: 44, firstAttackTime: 330, micro: true, scout: true, income: 1, maxBases: 3, slow: 1.1, prodScale: 0.8, apm: 6 },
  hard: { think: 10, maxWorkers: 62, attackSupply: 60, firstAttackTime: 300, micro: true, scout: true, income: 1, maxBases: 4, slow: 1, prodScale: 1, apm: 12 },
  brutal: { think: 8, maxWorkers: 70, attackSupply: 64, firstAttackTime: 280, micro: true, scout: true, income: 1.35, maxBases: 5, slow: 1, prodScale: 1.2, apm: 16 },
};
