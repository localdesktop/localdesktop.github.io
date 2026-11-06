// Replays: because the simulation is deterministic, a whole game is just its setup plus
// the command log. ReplaySession re-simulates it with full vision and speed control.

import { TICK_MS } from '../game/constants.ts';
import { Game } from '../game/game.ts';
import { loadMap } from '../game/map/maps.ts';
import type { PlayerSetup } from '../game/player.ts';
import type { Command, GameEvent, TickCommand } from '../game/types.ts';
import type { Session } from './session.ts';

export const REPLAY_VERSION = 1;

export interface ReplayFile {
  format: 'bear-war-replay';
  version: number;
  gameVersion: string;
  date: string;
  map: string;
  seed: number;
  players: PlayerSetup[];
  /** [tick, player, command] */
  log: [number, number, Command][];
  ticks: number;
  winners: number[];
}

export function makeReplay(game: Game, players: PlayerSetup[], log: [number, number, Command][], gameVersion: string): ReplayFile {
  return {
    format: 'bear-war-replay',
    version: REPLAY_VERSION,
    gameVersion,
    date: new Date().toISOString(),
    map: game.map.id,
    seed: game.seed,
    players,
    log,
    ticks: game.tick,
    winners: game.winners,
  };
}

export function parseReplay(text: string): ReplayFile {
  const r = JSON.parse(text) as ReplayFile;
  if (r.format !== 'bear-war-replay' || !Array.isArray(r.log) || !Array.isArray(r.players)) throw new Error('Not an Bear War replay file');
  if (r.version > REPLAY_VERSION) throw new Error('This replay was made with a newer version of the game');
  return r;
}

export class ReplaySession implements Session {
  game: Game;
  readonly localPlayer = -1;
  readonly online = false;
  speed = 1;
  paused = false;
  status = '';
  log: [number, number, Command][];
  replay: ReplayFile;
  private idx = 0;
  private acc = 0;
  private events: GameEvent[] = [];

  constructor(replay: ReplayFile) {
    this.replay = replay;
    this.log = replay.log;
    this.game = new Game({ map: loadMap(replay.map), players: replay.players, seed: replay.seed });
  }

  issue(): void {}

  update(dtMs: number): number {
    if (this.paused) return 0;
    if (this.game.tick >= this.replay.ticks) {
      this.status = 'Replay finished';
      return 0;
    }
    this.acc += Math.min(dtMs, 250) * this.speed;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 200 && this.game.tick < this.replay.ticks) {
      const cmds: TickCommand[] = [];
      while (this.idx < this.log.length && this.log[this.idx][0] === this.game.tick) {
        const [, p, c] = this.log[this.idx++];
        cmds.push({ p, c });
      }
      this.game.step(cmds);
      for (const ev of this.game.events) this.events.push(ev);
      this.acc -= TICK_MS;
      steps++;
    }
    this.status = '';
    return Math.min(0.999, this.acc / TICK_MS);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  dispose(): void {}
}

/** Offer a file to the user. */
export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
