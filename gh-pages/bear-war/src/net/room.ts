// Room + lockstep turn clock. Pure TypeScript (no Node or DOM APIs) so it can run in
// the relay server or, in the future, inside a browser acting as host.

import type { Command } from '../game/types.ts';
import type { PlayerSetup } from '../game/player.ts';
import { RACE_IDS } from '../game/data/index.ts';
import {
  BASE_TURN_MS, DROP_AFTER_MS, MAX_LAG_TURNS, type RoomInfo, type RoomState, type S2C, type Slot, type C2S,
} from './protocol.ts';

export interface RoomClient {
  id: string;
  name: string;
  send(msg: S2C): void;
}

const DEFAULT_COLORS = [1, 0, 2, 3, 4, 5, 6, 7];

/** Unguessable rejoin token (crypto RNG: Math.random's state can be reconstructed). */
function randomToken(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
const MAX_CMDS_PER_TURN = 64;
/** turns kept for reconnecting players (2 minutes at normal speed) */
const HISTORY_TURNS = 1200;
const REJOIN_COOLDOWN_MS = 2000;

const COMMANDS = new Set([
  'move', 'smart', 'amove', 'attack', 'patrol', 'stop', 'hold', 'gather', 'return', 'build', 'repair', 'train',
  'research', 'morph', 'cancel', 'rally', 'ability', 'autocast', 'load', 'unload', 'surrender', 'leave',
]);
const NUM_FIELDS = ['x', 'y', 't', 'tx', 'ty', 'id', 'slot', 'u'];
const STR_FIELDS = ['d', 'r', 'a'];

/**
 * Rebuild a command from untrusted input with only known fields of the right types, so
 * relayed turns stay small. The simulation still validates every command itself.
 */
export function sanitizeCommand(raw: unknown): Command | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.c !== 'string' || !COMMANDS.has(r.c)) return null;
  const out: Record<string, unknown> = { c: r.c };
  if (Array.isArray(r.ids)) out.ids = r.ids.slice(0, 400).filter((v) => typeof v === 'number' && Number.isFinite(v));
  for (const k of NUM_FIELDS) if (typeof r[k] === 'number' && Number.isFinite(r[k])) out[k] = r[k];
  for (const k of STR_FIELDS) if (typeof r[k] === 'string' && (r[k] as string).length <= 40) out[k] = r[k];
  if (r.q === true) out.q = true;
  if (r.c === 'autocast') out.on = r.on === true;
  return out as unknown as Command;
}

export class Room {
  code: string;
  name: string;
  host: string;
  map: string;
  speed = 1;
  isPublic: boolean;
  slots: Slot[] = [];
  members = new Map<string, RoomClient>();
  started = false;
  onEmpty: () => void = () => {};

  // in-game state
  private playerOf = new Map<string, number>();
  private gone = new Set<number>();
  private turn = 0;
  private queue: [number, Command][] = [];
  private cmdCount = new Map<number, number>();
  private startTime = 0;
  private pausedAt = 0;
  private pauseTotal = 0;
  private paused = false;
  private acks = new Map<number, number>();
  private hashes = new Map<number, Map<number, number>>();
  private desynced = false;
  /** secret per-player tokens for reconnecting */
  private tokens = new Map<string, number>();
  /** players that disconnected without leaving (player index -> name) */
  private away = new Map<number, string>();
  /** recent turns (for players who reconnect) */
  private history: [number, [number, Command][] | null][] = [];
  private lastRejoin = new Map<number, number>();

  constructor(code: string, host: RoomClient, name: string, map: string, maxPlayers: number, isPublic: boolean) {
    this.code = code;
    this.host = host.id;
    this.name = name.slice(0, 32) || `${host.name}'s game`;
    this.map = map;
    this.isPublic = isPublic;
    this.resize(maxPlayers);
    this.slots[0] = { kind: 'human', id: host.id, name: host.name, race: 'random', color: DEFAULT_COLORS[0], team: 0 };
    this.members.set(host.id, host);
  }

  private resize(n: number): void {
    n = Math.max(2, Math.min(8, n | 0));
    while (this.slots.length < n) {
      const i = this.slots.length;
      this.slots.push({ kind: i === 1 ? 'open' : 'closed', race: 'random', color: DEFAULT_COLORS[i], team: i });
    }
    while (this.slots.length > n) {
      const s = this.slots.pop()!;
      if (s.kind === 'human' && s.id) {
        // kicked by shrinking: move them to a free slot if possible
        const free = this.slots.findIndex((x) => x.kind === 'open' || x.kind === 'closed');
        if (free >= 0) this.slots[free] = { ...s, color: this.slots[free].color, team: this.slots[free].team };
      }
    }
  }

  info(): RoomInfo {
    return {
      code: this.code, name: this.name, map: this.map, started: this.started,
      players: this.slots.filter((s) => s.kind === 'human').length, max: this.slots.filter((s) => s.kind !== 'closed').length,
    };
  }

  state(): RoomState {
    return { code: this.code, name: this.name, host: this.host, map: this.map, speed: this.speed, public: this.isPublic, slots: this.slots, started: this.started };
  }

  broadcast(msg: S2C): void {
    for (const c of this.members.values()) c.send(msg);
  }

  private sync(): void {
    this.broadcast({ t: 'room', room: this.state() });
  }

  sys(text: string): void {
    this.broadcast({ t: 'chat', from: '', text, sys: true });
  }

  // ------------------------------------------------------------------ lobby

  join(c: RoomClient): string | null {
    if (this.started) return 'Game already started';
    if (this.members.has(c.id)) return null;
    const i = this.slots.findIndex((s) => s.kind === 'open');
    if (i < 0) return 'Room is full';
    this.slots[i] = { ...this.slots[i], kind: 'human', id: c.id, name: c.name };
    this.members.set(c.id, c);
    this.sys(`${c.name} joined`);
    this.sync();
    return null;
  }

  leave(c: RoomClient): void {
    if (!this.members.has(c.id)) return;
    this.members.delete(c.id);
    if (this.started) {
      const p = this.playerOf.get(c.id);
      this.playerOf.delete(c.id);
      if (p !== undefined && !this.gone.has(p)) {
        // unexpected disconnect: the turn clock pauses the game and drops the player
        // if they don't reconnect in time (explicit quits send a 'leave' command first)
        this.away.set(p, c.name);
        this.sys(`${c.name} lost connection…`);
      }
    } else {
      const i = this.slots.findIndex((s) => s.id === c.id);
      if (i >= 0) this.slots[i] = { kind: 'open', race: 'random', color: this.slots[i].color, team: this.slots[i].team };
      this.sys(`${c.name} left`);
    }
    if (this.host === c.id) {
      const next = [...this.members.values()][0];
      if (next) {
        this.host = next.id;
        this.sys(`${next.name} is now the host`);
      }
    }
    if (this.members.size === 0) this.onEmpty();
    else if (!this.started) this.sync();
  }

  setSlot(c: RoomClient, m: Extract<C2S, { t: 'slot' }>): void {
    if (this.started || !this.members.has(c.id)) return;
    if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot >= this.slots.length) return;
    const s = this.slots[m.slot];
    if (!s) return;
    const isHost = c.id === this.host;
    const own = s.id === c.id;
    if (!own && !isHost) return;
    if (m.race !== undefined && (m.race === 'random' || RACE_IDS.includes(m.race))) s.race = m.race;
    if (m.color !== undefined && Number.isInteger(m.color) && m.color >= 0 && m.color < 8) {
      if (!this.slots.some((x, i) => i !== m.slot && x.kind !== 'closed' && x.kind !== 'open' && x.color === m.color)) s.color = m.color;
    }
    if (m.team !== undefined && Number.isInteger(m.team) && m.team >= 0 && m.team < 8) s.team = m.team;
    if (isHost && m.kind !== undefined && s.kind !== 'human') {
      if (m.kind === 'open' || m.kind === 'closed' || m.kind === 'ai') {
        s.kind = m.kind;
        if (m.kind === 'ai') {
          s.ai = s.ai ?? 'normal';
          s.name = 'Computer';
        } else {
          delete s.ai;
          delete s.name;
        }
      }
    }
    if (isHost && m.kind !== undefined && s.kind === 'human' && s.id !== this.host && (m.kind === 'open' || m.kind === 'closed')) {
      // kick
      const victim = this.members.get(s.id!);
      this.slots[m.slot] = { kind: m.kind, race: 'random', color: s.color, team: s.team };
      if (victim) {
        this.members.delete(victim.id);
        victim.send({ t: 'room', room: null });
        victim.send({ t: 'error', msg: 'You were removed from the room' });
      }
    }
    if (isHost && m.ai !== undefined && s.kind === 'ai' && ['easy', 'normal', 'hard', 'brutal'].includes(m.ai)) s.ai = m.ai;
    this.sync();
  }

  settings(c: RoomClient, m: Extract<C2S, { t: 'settings' }>, maxForMap: (map: string) => number): void {
    if (this.started || c.id !== this.host) return;
    if (m.map !== undefined) {
      this.map = m.map;
      this.resize(maxForMap(m.map));
    }
    if (m.speed !== undefined && [0.75, 1, 1.4].includes(m.speed)) this.speed = m.speed;
    this.sync();
  }

  chat(c: RoomClient, text: string): void {
    if (!this.members.has(c.id)) return;
    const t = String(text).replace(/[\u0000-\u001f]/g, '').slice(0, 200).trim();
    if (t) this.broadcast({ t: 'chat', from: c.name, text: t });
  }

  start(c: RoomClient, now: number): string | null {
    if (c.id !== this.host) return 'Only the host can start';
    if (this.started) return 'Already started';
    const occ = this.slots.filter((s) => s.kind === 'human' || s.kind === 'ai');
    if (occ.length < 2) return 'Need at least two players';
    if (new Set(occ.map((s) => s.team)).size < 2) return 'Need at least two teams';
    if (new Set(occ.map((s) => s.color)).size < occ.length) return 'Players need different colours';
    const players: PlayerSetup[] = occ.map((s) => ({
      name: s.kind === 'ai' ? `Computer (${s.ai})` : s.name ?? 'Player',
      race: s.race === 'random' ? RACE_IDS[Math.floor(Math.random() * RACE_IDS.length)] : s.race,
      color: s.color,
      team: s.team,
      ai: s.kind === 'ai' ? s.ai ?? 'normal' : null,
    }));
    this.playerOf.clear();
    occ.forEach((s, i) => {
      if (s.kind === 'human' && s.id) this.playerOf.set(s.id, i);
    });
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.started = true;
    this.turn = 0;
    this.queue = [];
    this.startTime = now + 600;
    this.pauseTotal = 0;
    this.paused = false;
    this.acks.clear();
    for (const p of this.playerOf.values()) this.acks.set(p, -1);
    this.history = [];
    this.lastRejoin.clear();
    this.tokens.clear();
    for (const m of this.members.values()) {
      const you = this.playerOf.get(m.id) ?? -1;
      let token = '';
      if (you >= 0) {
        token = randomToken();
        this.tokens.set(token, you);
      }
      m.send({ t: 'start', seed, map: this.map, players, you, speed: this.speed, code: this.code, token });
    }
    return null;
  }

  /**
   * A player whose connection dropped comes back: resume their turn stream from turn
   * `from`. A rejoin also takes over from an older connection the server still thinks
   * is alive (half-open socket, second tab).
   */
  rejoin(c: RoomClient, token: string, from: number, now = Date.now()): string | null {
    if (!this.started) return 'Game has not started';
    const p = this.tokens.get(String(token));
    if (p === undefined) return 'Invalid rejoin token';
    if (this.gone.has(p)) return 'You were dropped from this game';
    if (now - (this.lastRejoin.get(p) ?? -1e15) < REJOIN_COOLDOWN_MS) return 'Reconnecting too fast, try again';
    const first = this.history.length ? this.history[0][0] : this.turn;
    const start = Math.min(this.turn, Math.floor(Number(from) || 0));
    if (start < first) return 'Too far behind to rejoin this game';
    this.lastRejoin.set(p, now);
    for (const [id, idx] of [...this.playerOf]) {
      if (idx !== p || id === c.id) continue;
      this.playerOf.delete(id);
      const old = this.members.get(id);
      this.members.delete(id);
      old?.send({ t: 'error', msg: 'This game was resumed from another connection' });
      old?.send({ t: 'room', room: null });
    }
    this.playerOf.set(c.id, p);
    this.members.set(c.id, c);
    this.away.delete(p);
    c.send({ t: 'rejoined', turns: this.history.slice(start - first) });
    this.sys(`${c.name} reconnected`);
    return null;
  }

  // ------------------------------------------------------------------ in game

  command(c: RoomClient, cmds: unknown): void {
    if (!this.started || !Array.isArray(cmds)) return;
    const p = this.playerOf.get(c.id);
    if (p === undefined || this.gone.has(p)) return;
    let n = this.cmdCount.get(p) ?? 0;
    for (const raw of cmds) {
      if (n >= MAX_CMDS_PER_TURN) break;
      const cmd = sanitizeCommand(raw);
      if (!cmd) continue;
      this.queue.push([p, cmd]);
      n++;
      // a player who quit or surrendered no longer holds up the game
      if (cmd.c === 'leave' || cmd.c === 'surrender') {
        this.gone.add(p);
        break;
      }
    }
    this.cmdCount.set(p, n);
  }

  ack(c: RoomClient, turn: number, hash?: number, htick?: number): void {
    const p = this.playerOf.get(c.id);
    if (p === undefined || !Number.isFinite(turn)) return;
    this.acks.set(p, Math.max(this.acks.get(p) ?? -1, turn));
    if (hash !== undefined && htick !== undefined && !this.desynced) {
      let m = this.hashes.get(htick);
      if (!m) {
        m = new Map();
        this.hashes.set(htick, m);
      }
      m.set(p, hash);
      const live = [...this.acks.keys()].filter((q) => !this.gone.has(q));
      if (live.every((q) => m!.has(q))) {
        const vals = new Set(live.map((q) => m!.get(q)));
        if (vals.size > 1) {
          this.desynced = true;
          this.broadcast({ t: 'desync', tick: htick });
          this.sys('Desync detected, the simulation diverged between players');
        }
        this.hashes.delete(htick);
      }
      if (this.hashes.size > 20) this.hashes.delete(this.hashes.keys().next().value!);
    }
  }

  /** Called frequently by the host process; emits turns on schedule. */
  tickClock(now: number): void {
    if (!this.started) return;
    const live = [...this.acks.entries()].filter(([p]) => !this.gone.has(p));
    const minAck = live.length ? Math.min(...live.map(([, a]) => a)) : this.turn;
    const lag = this.turn - minAck;
    if (!this.paused && lag > MAX_LAG_TURNS && live.length) {
      this.paused = true;
      this.pausedAt = now;
      const waiting = live.filter(([, a]) => this.turn - a > MAX_LAG_TURNS / 2).map(([p]) => this.nameOf(p));
      this.broadcast({ t: 'pause', waiting });
    }
    if (this.paused) {
      if (lag <= MAX_LAG_TURNS / 3 || !live.length) {
        this.paused = false;
        this.pauseTotal += now - this.pausedAt;
        this.broadcast({ t: 'resume' });
      } else if (now - this.pausedAt > DROP_AFTER_MS) {
        for (const [p, a] of live) {
          if (this.turn - a > MAX_LAG_TURNS / 2) {
            this.gone.add(p);
            this.away.delete(p);
            this.queue.push([p, { c: 'leave' }]);
            this.sys(`${this.nameOf(p)} was dropped (not responding)`);
          }
        }
        this.paused = false;
        this.pauseTotal += now - this.pausedAt;
        this.broadcast({ t: 'resume' });
      } else return;
    }
    const turnMs = BASE_TURN_MS / this.speed;
    const target = Math.floor((now - this.startTime - this.pauseTotal) / turnMs);
    let guard = 0;
    while (this.turn <= target && guard++ < 50) {
      const c = this.queue.length ? this.queue : undefined;
      this.broadcast(c ? { t: 'turn', n: this.turn, c } : { t: 'turn', n: this.turn });
      this.history.push([this.turn, c ?? null]);
      if (this.history.length > HISTORY_TURNS + 200) this.history.splice(0, this.history.length - HISTORY_TURNS);
      this.queue = [];
      this.cmdCount.clear();
      this.turn++;
    }
  }

  private nameOf(p: number): string {
    for (const [id, idx] of this.playerOf) if (idx === p) return this.members.get(id)?.name ?? `Player ${p + 1}`;
    return this.away.get(p) ?? `Player ${p + 1}`;
  }

  /** All humans gone (left, dropped or disconnected with nobody left to wait for them)? */
  get abandoned(): boolean {
    if (!this.started) return false;
    const humans = [...this.tokens.values()];
    return humans.every((p) => this.gone.has(p) || this.away.has(p)) && this.members.size === 0;
  }
}
