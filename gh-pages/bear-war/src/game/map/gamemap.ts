// Static map data: terrain, elevation, base locations and resources.

export const F_WALK = 1; // ground units can walk here
export const F_BUILD = 2; // structures can be placed here
export const F_RAMP = 4;
export const F_CLIFF = 8;
export const F_WATER = 16;
export const F_ROCK = 32;
export const F_EDGE = 64;
export const F_ROUGH = 128; // walkable, not buildable (decorative rubble)

export type Tileset = 'badlands' | 'frost' | 'ash' | 'verdant';

export interface ResourceSpawn {
  kind: 'mineral' | 'geyser';
  tx: number;
  ty: number;
  amount: number;
}

export interface BaseSpot {
  /** town hall top-left tile */
  tx: number;
  ty: number;
  /** start location index, or -1 for an expansion */
  start: number;
}

export class GameMap {
  id: string;
  name: string;
  desc: string;
  w: number;
  h: number;
  tileset: Tileset;
  maxPlayers: number;
  elev: Uint8Array;
  flags: Uint8Array;
  bases: BaseSpot[] = [];
  resources: ResourceSpawn[] = [];
  /** seed for purely visual variation */
  seed: number;

  constructor(id: string, name: string, w: number, h: number, tileset: Tileset, seed: number) {
    this.id = id;
    this.name = name;
    this.desc = '';
    this.w = w;
    this.h = h;
    this.tileset = tileset;
    this.maxPlayers = 2;
    this.seed = seed;
    this.elev = new Uint8Array(w * h);
    this.flags = new Uint8Array(w * h);
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }
  idx(tx: number, ty: number): number {
    return ty * this.w + tx;
  }
  walkable(tx: number, ty: number): boolean {
    return this.inBounds(tx, ty) && (this.flags[ty * this.w + tx] & F_WALK) !== 0;
  }
  buildable(tx: number, ty: number): boolean {
    return this.inBounds(tx, ty) && (this.flags[ty * this.w + tx] & F_BUILD) !== 0;
  }
  elevAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return 0;
    return this.elev[ty * this.w + tx];
  }
  get starts(): BaseSpot[] {
    return this.bases.filter((b) => b.start >= 0).sort((a, b) => a.start - b.start);
  }
}
