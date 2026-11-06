import { TICK_MS, TICKS_PER_TURN } from '../game/constants.ts';
import type { Game } from '../game/game.ts';
import type { Command, GameEvent, TickCommand } from '../game/types.ts';

/** Drives a Game: decides when ticks run and which commands they contain. */
export interface Session {
  game: Game;
  localPlayer: number;
  /** spectators have no player */
  readonly online: boolean;
  speed: number;
  paused: boolean;
  /** human-readable status (e.g. "Waiting for Bob…"), empty when running normally */
  status: string;
  issue(cmd: Command): void;
  /** Advance by real elapsed ms. Returns interpolation alpha in [0,1). */
  update(dtMs: number): number;
  drainEvents(): GameEvent[];
  /** command log for replays: [tick, player, command] */
  log: [number, number, Command][];
  dispose(): void;
  /** ping in ms (online) */
  ping?: number;
}

/** Offline game: commands apply on the next tick; supports pause and speed. */
export class LocalSession implements Session {
  game: Game;
  localPlayer: number;
  readonly online = false;
  speed = 1;
  paused = false;
  status = '';
  log: [number, number, Command][] = [];
  private pending: Command[] = [];
  private acc = 0;
  private events: GameEvent[] = [];

  constructor(game: Game, localPlayer: number) {
    this.game = game;
    this.localPlayer = localPlayer;
  }

  issue(cmd: Command): void {
    if (this.localPlayer < 0) return;
    this.pending.push(cmd);
  }

  update(dtMs: number): number {
    if (this.paused || this.game.over) return 0;
    this.acc += Math.min(dtMs, 250) * this.speed;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 200) {
      const cmds: TickCommand[] = this.pending.map((c) => ({ p: this.localPlayer, c }));
      for (const tc of cmds) this.log.push([this.game.tick, tc.p, tc.c]);
      this.pending = [];
      this.stepOnce(cmds);
      this.acc -= TICK_MS;
      steps++;
    }
    if (steps >= 200) this.acc = 0;
    return this.acc / TICK_MS;
  }

  private stepOnce(cmds: TickCommand[]): void {
    this.game.step(cmds);
    for (const ev of this.game.events) this.events.push(ev);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  dispose(): void {}
}

export { TICKS_PER_TURN };
