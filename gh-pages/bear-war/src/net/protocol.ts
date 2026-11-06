// Wire protocol shared by the browser client and the Node relay server.
//
// Multiplayer uses deterministic lockstep: the server never simulates the game. It
// collects player commands, groups them into numbered "turns" (one every 100 ms) and
// broadcasts each turn to every client, which all execute identical simulations.

import type { Command } from '../game/types.ts';
import type { AIDifficulty, PlayerSetup } from '../game/player.ts';
import type { RaceId } from '../game/data/types.ts';

export const PROTOCOL_VERSION = 2;
export const TURN_TICKS = 2;
export const BASE_TURN_MS = 100;
/** clients send a state hash every N turns for desync detection */
export const HASH_EVERY = 50;
/** pause the game when a client falls this many turns behind */
export const MAX_LAG_TURNS = 30;
/** drop a client after the game has waited this long for it */
export const DROP_AFTER_MS = 45000;

export type RacePick = RaceId | 'random';
export type SlotKind = 'open' | 'closed' | 'human' | 'ai';

export interface Slot {
  kind: SlotKind;
  id?: string;
  name?: string;
  race: RacePick;
  color: number;
  team: number;
  ai?: AIDifficulty;
}

export interface RoomInfo {
  code: string;
  name: string;
  map: string;
  players: number;
  max: number;
  started: boolean;
}

export interface RoomState {
  code: string;
  name: string;
  host: string;
  map: string;
  speed: number;
  public: boolean;
  slots: Slot[];
  started: boolean;
}

export type C2S =
  | { t: 'hello'; name: string; v: number; sim?: string }
  | { t: 'list' }
  | { t: 'create'; name: string; map: string; maxPlayers: number; public: boolean }
  | { t: 'join'; code: string }
  | { t: 'leaveRoom' }
  | { t: 'slot'; slot: number; race?: RacePick; color?: number; team?: number; kind?: SlotKind; ai?: AIDifficulty }
  | { t: 'settings'; map?: string; maxPlayers?: number; speed?: number }
  | { t: 'chat'; text: string }
  | { t: 'start' }
  | { t: 'cmd'; c: Command[] }
  | { t: 'ack'; turn: number; hash?: number; htick?: number }
  | { t: 'rejoin'; code: string; token: string; from: number }
  | { t: 'ping'; at: number };

export type S2C =
  | { t: 'welcome'; id: string; v: number; motd?: string }
  | { t: 'rooms'; rooms: RoomInfo[] }
  | { t: 'room'; room: RoomState | null }
  | { t: 'chat'; from: string; text: string; sys?: boolean }
  | { t: 'error'; msg: string }
  | { t: 'start'; seed: number; map: string; players: PlayerSetup[]; you: number; speed: number; code: string; token: string }
  | { t: 'rejoined'; turns: [number, [number, Command][] | null][] }
  | { t: 'turn'; n: number; c?: [number, Command][] }
  | { t: 'pause'; waiting: string[] }
  | { t: 'resume' }
  | { t: 'desync'; tick: number }
  | { t: 'pong'; at: number };
