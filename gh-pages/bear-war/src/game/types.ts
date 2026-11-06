import type { WeaponDef } from './data/types.ts';

/** Player commands. These are what travels over the network in lockstep. */
export type Command =
  | { c: 'move'; ids: number[]; x: number; y: number; q?: boolean }
  | { c: 'smart'; ids: number[]; x: number; y: number; t?: number; q?: boolean }
  | { c: 'amove'; ids: number[]; x: number; y: number; q?: boolean }
  | { c: 'attack'; ids: number[]; t: number; q?: boolean }
  | { c: 'patrol'; ids: number[]; x: number; y: number; q?: boolean }
  | { c: 'stop'; ids: number[] }
  | { c: 'hold'; ids: number[] }
  | { c: 'gather'; ids: number[]; t: number; q?: boolean }
  | { c: 'return'; ids: number[]; q?: boolean }
  | { c: 'build'; ids: number[]; d: string; tx: number; ty: number; q?: boolean }
  | { c: 'repair'; ids: number[]; t: number; q?: boolean }
  | { c: 'train'; ids: number[]; d: string }
  | { c: 'research'; ids: number[]; r: string }
  | { c: 'morph'; ids: number[]; d: string }
  | { c: 'cancel'; id: number; slot: number }
  | { c: 'rally'; ids: number[]; x: number; y: number; t?: number }
  | { c: 'ability'; ids: number[]; a: string; x?: number; y?: number; t?: number; q?: boolean }
  | { c: 'autocast'; ids: number[]; on: boolean }
  /** board transport/bunker t, or (transports selected) pick up unit t */
  | { c: 'load'; ids: number[]; t: number; q?: boolean }
  /** unload everything at (x,y) (in place if omitted), or only unit u right here */
  | { c: 'unload'; ids: number[]; x?: number; y?: number; u?: number; q?: boolean }
  | { c: 'surrender' }
  | { c: 'leave' };

export interface TickCommand {
  p: number;
  c: Command;
}

export type GameEvent =
  | { k: 'fire'; id: number; tid: number; fx: string; x: number; y: number; tx: number; ty: number; owner: number; air: boolean }
  | { k: 'hit'; fx: string; x: number; y: number; tid: number; shield: boolean }
  | { k: 'splash'; fx: string; x: number; y: number; r: number }
  | { k: 'death'; id: number; def: string; owner: number; x: number; y: number; air: boolean; building: boolean; r: number }
  | { k: 'built'; id: number; owner: number; def: string; x: number; y: number }
  | { k: 'placed'; id: number; owner: number; def: string; x: number; y: number }
  | { k: 'trained'; id: number; owner: number; def: string; x: number; y: number }
  | { k: 'researched'; owner: number; id: string; level: number }
  | { k: 'error'; owner: number; msg: string }
  | { k: 'alert'; owner: number; kind: 'attack' | 'supply' | 'base'; x: number; y: number }
  | { k: 'ability'; owner: number; ab: string; x: number; y: number; id: number; tx: number; ty: number }
  | { k: 'blink'; id: number; x0: number; y0: number; x1: number; y1: number; owner: number }
  | { k: 'heal'; id: number; tid: number; x: number; y: number; tx: number; ty: number }
  | { k: 'spark'; x: number; y: number; id: number }
  | { k: 'cargo'; id: number; carrier: number; owner: number; x: number; y: number; load: boolean }
  | { k: 'defeat'; player: number }
  | { k: 'revealed'; player: number }
  | { k: 'gameover'; winners: number[] };

export interface Projectile {
  id: number;
  x: number;
  y: number;
  px: number;
  py: number;
  tx: number;
  ty: number;
  target: number;
  speed: number;
  owner: number;
  src: number;
  w: WeaponDef;
  /** damage multiplier (bounces) */
  mult: number;
  bounces: number;
  hit: number[];
  air: boolean;
  alive: boolean;
  age: number;
}

export type EffectKind =
  | 'sniff' | 'beecloud' | 'stingswarm' | 'starfall' | 'grandshot' | 'staticburst'
  | 'pollen' | 'hornets' | 'honeyglob' | 'spirit' | 'snowball';

export interface AreaEffect {
  id: number;
  kind: EffectKind;
  x: number;
  y: number;
  /** radius in px */
  r: number;
  owner: number;
  team: number;
  t: number;
  total: number;
  src: number;
  target: number;
  /** moving effects (spirits, snowballs): waypoints still to visit, flat [x0,y0,x1,y1,...] */
  path?: number[];
}
