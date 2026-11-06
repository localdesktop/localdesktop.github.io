import { TICK_MS } from '../game/constants.ts';
import type { Game } from '../game/game.ts';
import type { Command, GameEvent, TickCommand } from '../game/types.ts';
import { NetClient } from './client.ts';
import { HASH_EVERY, TURN_TICKS, type S2C } from './protocol.ts';
import type { Session } from './session.ts';

/**
 * Lockstep session: the simulation only advances through turns received from the
 * server, so every client executes exactly the same commands on exactly the same tick.
 */
export class NetSession implements Session {
  game: Game;
  localPlayer: number;
  readonly online = true;
  speed: number;
  paused = false;
  status = '';
  log: [number, number, Command][] = [];
  ping = 0;
  onChat: ((from: string, text: string, sys: boolean) => void) | null = null;
  private client: NetClient;
  private turns = new Map<number, [number, Command][]>();
  private maxTurn = -1;
  private next = 0;
  private sub = 0;
  private acc = 0;
  private events: GameEvent[] = [];
  private pending: Command[] = [];
  private unsub: () => void;
  private unsubClose: () => void;
  private starving = 0;
  private desyncMsg = 0;
  private waitMsg = '';
  private disconnected = false;

  private rejoinInfo: { code: string; token: string; name: string } | null;
  private reconnecting = false;
  private disposed = false;
  private rejoinError = '';
  private leaveSent = false;

  constructor(client: NetClient, game: Game, you: number, speed: number, rejoin?: { code: string; token: string; name: string }) {
    this.client = client;
    this.game = game;
    this.localPlayer = you;
    this.speed = speed;
    this.rejoinInfo = rejoin && rejoin.token ? rejoin : null;
    this.unsub = client.on((m) => this.onMessage(m));
    this.unsubClose = client.onClose(() => this.onDisconnect());
  }

  private onDisconnect(): void {
    this.disconnected = true;
    if (!this.disposed && !this.game.over && this.rejoinInfo) void this.reconnect();
  }

  /** Mobile connections drop (app switch, network change): reconnect and resume where we were. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting || !this.rejoinInfo) return;
    this.reconnecting = true;
    const url = this.client.url;
    const deadline = performance.now() + 40000;
    while (!this.disposed && performance.now() < deadline && !this.rejoinError) {
      const c = new NetClient();
      try {
        await c.connect(url, this.rejoinInfo.name);
      } catch {
        await new Promise((r) => window.setTimeout(r, 2000));
        continue;
      }
      if (this.disposed) {
        c.close();
        break;
      }
      this.unsub();
      this.unsubClose();
      this.client = c;
      this.unsub = c.on((m) => this.onMessage(m));
      this.unsubClose = c.onClose(() => this.onDisconnect());
      c.send({ t: 'rejoin', code: this.rejoinInfo.code, token: this.rejoinInfo.token, from: this.next });
      this.reconnecting = false;
      return;
    }
    this.reconnecting = false;
  }

  private onMessage(m: S2C): void {
    switch (m.t) {
      case 'turn':
        this.turns.set(m.n, m.c ?? []);
        if (m.n > this.maxTurn) this.maxTurn = m.n;
        break;
      case 'pause':
        this.paused = true;
        this.waitMsg = `Waiting for ${m.waiting.join(', ') || 'players'}…`;
        break;
      case 'resume':
        this.paused = false;
        this.waitMsg = '';
        break;
      case 'desync':
        this.desyncMsg = performance.now() + 8000;
        break;
      case 'chat':
        this.onChat?.(m.from, m.text, !!m.sys);
        break;
      case 'rejoined':
        for (const [n, c] of m.turns) {
          if (n < this.next) continue;
          this.turns.set(n, c ?? []);
          if (n > this.maxTurn) this.maxTurn = n;
        }
        this.disconnected = false;
        break;
      case 'error':
        if (this.disconnected) this.rejoinError = m.msg;
        break;
    }
  }

  issue(cmd: Command): void {
    if (this.localPlayer < 0) return;
    this.pending.push(cmd);
  }

  chat(text: string): void {
    const t = text.trim().slice(0, 200);
    if (t) this.client.send({ t: 'chat', text: t });
  }

  flush(): void {
    if (this.pending.length) {
      this.client.send({ t: 'cmd', c: this.pending });
      this.pending = [];
    }
  }

  update(dtMs: number): number {
    this.flush();
    this.ping = Math.round(this.client.rtt);
    const tickMs = TICK_MS / this.speed;
    const bufferedTicks = (this.maxTurn - this.next + 1) * TURN_TICKS - this.sub;
    // catch up smoothly when we have fallen behind (e.g. after the tab was hidden)
    const mult = bufferedTicks > 6 ? 1 + Math.min(8, (bufferedTicks - 6) / 4) : 1;
    this.acc += Math.min(dtMs, 1000) * mult;
    let steps = 0;
    while (this.acc >= tickMs && steps < 60) {
      const turn = this.turns.get(this.next);
      if (!turn) {
        this.acc = Math.min(this.acc, tickMs);
        this.starving += dtMs;
        break;
      }
      this.starving = 0;
      let cmds: TickCommand[] = [];
      if (this.sub === 0 && turn.length) {
        cmds = turn.map(([p, c]) => ({ p, c }));
        for (const tc of cmds) this.log.push([this.game.tick, tc.p, tc.c]);
      }
      this.game.step(cmds);
      for (const ev of this.game.events) this.events.push(ev);
      this.acc -= tickMs;
      steps++;
      this.sub++;
      if (this.sub >= TURN_TICKS) {
        this.sub = 0;
        this.turns.delete(this.next);
        const done = this.next;
        this.next++;
        if (done % HASH_EVERY === 0) this.client.send({ t: 'ack', turn: this.next, hash: this.game.hash(), htick: this.game.tick });
        else if (done % 5 === 0) this.client.send({ t: 'ack', turn: this.next });
      }
    }
    // once defeated, tell the server so the game doesn't wait for us if we close the tab
    if (!this.leaveSent && this.localPlayer >= 0 && this.game.players[this.localPlayer]?.defeated && !this.game.over) {
      this.leaveSent = true;
      this.client.send({ t: 'cmd', c: [{ c: 'leave' }] });
    }
    if (this.disconnected) this.status = this.rejoinError ? `Disconnected: ${this.rejoinError}` : this.reconnecting ? 'Connection lost, reconnecting…' : 'Disconnected from server';
    else if (this.waitMsg) this.status = this.waitMsg;
    else if (performance.now() < this.desyncMsg) this.status = 'Desync detected, results may differ between players';
    else if (this.starving > 1500 && !this.game.over) this.status = 'Waiting for server…';
    else this.status = '';
    return Math.min(0.999, this.acc / tickMs);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  dispose(): void {
    this.disposed = true;
    this.flush();
    this.unsub();
    this.unsubClose();
    this.client.close();
  }
}
