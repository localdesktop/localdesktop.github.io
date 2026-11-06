import { describe, expect, it } from 'vitest';
import { Room, type RoomClient } from '../src/net/room.ts';
import type { S2C } from '../src/net/protocol.ts';

function client(id: string): RoomClient & { inbox: S2C[] } {
  const inbox: S2C[] = [];
  return { id, name: id, inbox, send: (m) => inbox.push(m) };
}

describe('room', () => {
  it('runs a lobby, starts a game and emits turns with commands', () => {
    const a = client('alice');
    const b = client('bob');
    const room = new Room('ABCDE', a, 'test', 'twin-craters', 2, true);
    expect(room.join(b)).toBeNull();
    expect(room.start(b, 0)).toMatch(/host/);
    // same team is rejected
    room.setSlot(a, { t: 'slot', slot: 1, team: 0 });
    room.setSlot(b, { t: 'slot', slot: 1, team: 0 });
    expect(room.start(a, 0)).toMatch(/two teams/);
    room.setSlot(b, { t: 'slot', slot: 1, team: 1 });
    expect(room.start(a, 0)).toBeNull();
    const startA = a.inbox.find((m) => m.t === 'start') as Extract<S2C, { t: 'start' }>;
    const startB = b.inbox.find((m) => m.t === 'start') as Extract<S2C, { t: 'start' }>;
    expect(startA.seed).toBe(startB.seed);
    expect(startA.you).toBe(0);
    expect(startB.you).toBe(1);
    expect(startA.players).toEqual(startB.players);

    room.command(b, [{ c: 'stop', ids: [1] }]);
    room.tickClock(600 + 250); // ~3 turns after start
    const turns = a.inbox.filter((m) => m.t === 'turn') as Extract<S2C, { t: 'turn' }>[];
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0].n).toBe(0);
    expect(turns[0].c).toEqual([[1, { c: 'stop', ids: [1] }]]);
    expect(b.inbox.filter((m) => m.t === 'turn').length).toBe(turns.length);
  });

  it('pauses for a disconnected player and drops them after the grace period', () => {
    const a = client('a');
    const b = client('b');
    const room = new Room('QWERT', a, 'test', 'twin-craters', 2, false);
    room.join(b);
    room.setSlot(b, { t: 'slot', slot: 1, team: 1 });
    room.start(a, 0);
    room.ack(a, 1000);
    room.leave(b); // connection lost, no 'leave' command
    room.tickClock(600 + 100 * 40);
    room.tickClock(600 + 100 * 41);
    expect(a.inbox.some((m) => m.t === 'pause')).toBe(true);
    const before = (a.inbox.filter((m) => m.t === 'turn') as Extract<S2C, { t: 'turn' }>[]).flatMap((t) => t.c ?? []);
    expect(before).not.toContainEqual([1, { c: 'leave' }]);
    room.tickClock(600 + 100 * 41 + 46000); // grace period expires
    room.tickClock(600 + 100 * 41 + 46200);
    const after = (a.inbox.filter((m) => m.t === 'turn') as Extract<S2C, { t: 'turn' }>[]).flatMap((t) => t.c ?? []);
    expect(after).toContainEqual([1, { c: 'leave' }]);
  });

  it('lets a disconnected player rejoin and resume from their last turn', () => {
    const a = client('a');
    const b = client('b');
    const room = new Room('RJOIN', a, 'test', 'twin-craters', 2, false);
    room.join(b);
    room.setSlot(b, { t: 'slot', slot: 1, team: 1 });
    room.start(a, 0);
    const token = (b.inbox.find((m) => m.t === 'start') as Extract<S2C, { t: 'start' }>).token;
    expect(token.length).toBeGreaterThan(10);
    room.tickClock(600 + 100 * 10);
    room.leave(b);
    room.command(a, [{ c: 'stop', ids: [5] }]);
    room.tickClock(600 + 100 * 14);
    const b2 = client('b2');
    expect(room.rejoin(b2, 'wrong', 0)).toMatch(/Invalid/);
    expect(room.rejoin(b2, token, 8)).toBeNull();
    const rj = b2.inbox.find((m) => m.t === 'rejoined') as Extract<S2C, { t: 'rejoined' }>;
    expect(rj.turns[0][0]).toBe(8);
    expect(rj.turns.flatMap(([, c]) => c ?? [])).toContainEqual([0, { c: 'stop', ids: [5] }]);
    // the rejoined client receives new turns and its commands are accepted again
    room.command(b2, [{ c: 'stop', ids: [9] }]);
    room.tickClock(600 + 100 * 16);
    const last = b2.inbox.filter((m) => m.t === 'turn') as Extract<S2C, { t: 'turn' }>[];
    expect(last.flatMap((t) => t.c ?? [])).toContainEqual([1, { c: 'stop', ids: [9] }]);
  });

  it('caps commands per turn and strips unknown fields', () => {
    const a = client('a');
    const b = client('b');
    const room = new Room('CAPPP', a, 'test', 'twin-craters', 2, false);
    room.join(b);
    room.setSlot(b, { t: 'slot', slot: 1, team: 1 });
    room.start(a, 0);
    const many = (n: number) => Array.from({ length: n }, () => ({ c: 'stop', ids: [1], junk: 'x'.repeat(1000) }));
    room.command(a, many(65));
    room.command(a, many(3000));
    room.command(a, [{ c: 'nonsense' }, { c: 'move', ids: [1, 'x', null], x: 5, y: Infinity }]);
    room.tickClock(600 + 50);
    const turn = a.inbox.find((m) => m.t === 'turn' && m.c) as Extract<S2C, { t: 'turn' }>;
    expect(turn.c!.length).toBe(64);
    expect(turn.c![0][1]).toEqual({ c: 'stop', ids: [1] });
  });

  it('keeps a bounded turn history and rate-limits rejoins', () => {
    const a = client('a');
    const b = client('b');
    const room = new Room('HISTO', a, 'test', 'twin-craters', 2, false);
    room.join(b);
    room.setSlot(b, { t: 'slot', slot: 1, team: 1 });
    room.start(a, 0);
    const token = (b.inbox.find((m) => m.t === 'start') as Extract<S2C, { t: 'start' }>).token;
    for (let t = 1; t <= 2000; t++) {
      room.ack(a, t);
      room.ack(b, t);
      room.tickClock(600 + t * 100);
    }
    room.leave(b);
    const b2 = client('b2');
    expect(room.rejoin(b2, token, 0, 1e9)).toMatch(/behind/);
    expect(room.rejoin(b2, token, 1900, 1e9)).toBeNull();
    const rj = b2.inbox.find((m) => m.t === 'rejoined') as Extract<S2C, { t: 'rejoined' }>;
    expect(rj.turns[0][0]).toBe(1900);
    // a second rejoin right away is refused; later it takes over the connection
    const b3 = client('b3');
    expect(room.rejoin(b3, token, 1900, 1e9 + 500)).toMatch(/too fast/);
    expect(room.rejoin(b3, token, 1900, 1e9 + 5000)).toBeNull();
    expect(b2.inbox.some((m) => m.t === 'room' && m.room === null)).toBe(true);
  });

  it('does not wait for a player who surrendered', () => {
    const a = client('a');
    const b = client('b');
    const room = new Room('SURRN', a, 'test', 'twin-craters', 2, false);
    room.join(b);
    room.setSlot(b, { t: 'slot', slot: 1, team: 1 });
    room.start(a, 0);
    room.command(b, [{ c: 'surrender' }]);
    room.leave(b);
    for (let t = 1; t <= 60; t++) {
      room.ack(a, t);
      room.tickClock(600 + t * 100);
    }
    expect(a.inbox.some((m) => m.t === 'pause')).toBe(false);
  });

  it('rejects bad slot indexes and chat from non-members', () => {
    const a = client('a');
    const b = client('b');
    const room = new Room('SLOTS', a, 'test', 'twin-craters', 2, false);
    room.setSlot(a, { t: 'slot', slot: '__proto__' as unknown as number, race: 'horde' });
    room.setSlot(a, { t: 'slot', slot: 1.5, race: 'horde' });
    expect(([] as unknown as { race?: string }).race).toBeUndefined();
    room.chat(b, 'hello from outside');
    expect(a.inbox.some((m) => m.t === 'chat' && m.text === 'hello from outside')).toBe(false);
  });

  it('detects desyncs from mismatching hashes', () => {
    const a = client('a');
    const b = client('b');
    const room = new Room('ZXCVB', a, 'test', 'twin-craters', 2, false);
    room.join(b);
    room.setSlot(b, { t: 'slot', slot: 1, team: 1 });
    room.start(a, 0);
    room.ack(a, 50, 111, 100);
    room.ack(b, 50, 222, 100);
    expect(a.inbox.some((m) => m.t === 'desync')).toBe(true);
  });
});
