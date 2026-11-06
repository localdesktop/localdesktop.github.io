import type { RaceId } from './data/types.ts';
import { STARTING_GAS, STARTING_MINERALS } from './constants.ts';

export type AIDifficulty = 'easy' | 'normal' | 'hard' | 'brutal';

export interface PlayerSetup {
  name: string;
  race: RaceId;
  color: number;
  team: number;
  ai?: AIDifficulty | null;
  /** preferred start location index; -1 or undefined = random */
  start?: number;
}

export interface PlayerStats {
  mineralsGathered: number;
  gasGathered: number;
  mineralsSpent: number;
  gasSpent: number;
  unitsProduced: number;
  unitsLost: number;
  unitsKilled: number;
  buildingsBuilt: number;
  buildingsLost: number;
  buildingsKilled: number;
  commands: number;
}

export class Player {
  index: number;
  name: string;
  race: RaceId;
  color: number;
  team: number;
  ai: AIDifficulty | null;
  minerals = STARTING_MINERALS;
  gas = STARTING_GAS;
  /** mining income multiplier (Brutal AI bonus) */
  incomeMult = 1;
  supplyUsed = 0;
  supplyMax = 0;
  /** completed research levels */
  upgrades: Record<string, number> = {};
  /** research currently in progress (id -> count) */
  researching: Record<string, number> = {};
  /** completed buildings per tech id (includes `counts` aliases) */
  tech: Record<string, number> = {};
  defeated = false;
  left = false;
  /** tick since which the player has had no town hall (-1 = has one) */
  noHallSince = -1;
  /** players without a town hall for 30s have their structures revealed */
  revealed = false;
  startBase = 0;
  lastAttackAlert = -100000;
  lastSupplyAlert = -100000;
  stats: PlayerStats = {
    mineralsGathered: 0,
    gasGathered: 0,
    mineralsSpent: 0,
    gasSpent: 0,
    unitsProduced: 0,
    unitsLost: 0,
    unitsKilled: 0,
    buildingsBuilt: 0,
    buildingsLost: 0,
    buildingsKilled: 0,
    commands: 0,
  };

  constructor(index: number, setup: PlayerSetup) {
    this.index = index;
    this.name = setup.name;
    this.race = setup.race;
    this.color = setup.color;
    this.team = setup.team;
    this.ai = setup.ai ?? null;
  }

  level(upgrade: string): number {
    return this.upgrades[upgrade] ?? 0;
  }
  has(research: string): boolean {
    return (this.upgrades[research] ?? 0) > 0;
  }
}
