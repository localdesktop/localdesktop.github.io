// Core simulation constants. The simulation is deterministic: every client runs the
// exact same ticks with the exact same commands (lockstep), so nothing in src/game
// may depend on wall-clock time, Math.random, or non-deterministic Math functions.

/** World pixels per map tile. */
export const TILE = 32;
/** Pathing grid cell size in world pixels (2x2 cells per tile). */
export const CELL = 16;
export const CELLS_PER_TILE = TILE / CELL;

/** Simulation ticks per game second. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
/** Ticks per network turn (lockstep). */
export const TICKS_PER_TURN = 2;

export const MAX_SUPPLY = 200;
export const MAX_PLAYERS = 8;
export const MAX_QUEUE = 5;

export const VISION_INTERVAL = 4; // ticks between vision refreshes
export const COMB_INTERVAL = 5; // ticks between comb growth steps
export const ACQUIRE_INTERVAL = 3; // ticks between auto-target scans

export const MINERAL_TRIP = 5;
export const GAS_TRIP = 4;
export const MINE_TICKS = 56; // 2.8s mining
export const GAS_TICKS = 28; // 1.4s inside refinery
export const MINERAL_AMOUNT = 1500;
export const MINERAL_SMALL = 900;
export const GEYSER_AMOUNT = 2250;

export const ENERGY_REGEN = 0.7875 / TICK_RATE;
export const SHIELD_REGEN = 2 / TICK_RATE;
export const SHIELD_DELAY = 10 * TICK_RATE;
export const HORDE_REGEN = 0.4 / TICK_RATE;
export const BURN_RATE = 2 / TICK_RATE; // ironpaw buildings in the red burn down
export const COMB_SPEED_BONUS = 1.3;

export const CUB_INTERVAL = 11 * TICK_RATE;
export const CUB_MAX = 3;
export const CUB_CAP = 19;

/** Tiles from a resource field that a town hall must keep clear. */
export const TOWNHALL_RESOURCE_GAP = 3;

export const STARTING_MINERALS = 50;
export const STARTING_GAS = 0;
export const STARTING_WORKERS = 12;

export const TEAM_COLORS: { name: string; main: string; light: string; dark: string }[] = [
  { name: 'Red', main: '#e0352b', light: '#ff7a63', dark: '#7a1510' },
  { name: 'Blue', main: '#2f6fe8', light: '#78a6ff', dark: '#14306e' },
  { name: 'Teal', main: '#1fbfae', light: '#6cf0de', dark: '#0b5c54' },
  { name: 'Purple', main: '#8b45d8', light: '#bf8cff', dark: '#3e1a6b' },
  { name: 'Yellow', main: '#e8c22a', light: '#fff07a', dark: '#6e5508' },
  { name: 'Orange', main: '#ee7d1f', light: '#ffb36a', dark: '#753608' },
  { name: 'Green', main: '#3fae38', light: '#8fe782', dark: '#174d14' },
  { name: 'Pink', main: '#e3559f', light: '#ff9ccd', dark: '#6e1a47' },
];
