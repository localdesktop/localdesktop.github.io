// Bear War multiplayer relay + static file server.
//
//   npm run build && npm start          (serves dist/ and the /ws lobby on PORT, default 8787)
//
// The server never simulates the game: it hosts lobbies and runs the lockstep turn
// clock (see src/net/room.ts). Every client runs the deterministic simulation itself.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, type RoomClient } from '../src/net/room.ts';
import { PROTOCOL_VERSION, type C2S, type S2C } from '../src/net/protocol.ts';
import { MAPS } from '../src/game/map/maps.ts';
import { simHash } from './simhash.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DIST = path.resolve(import.meta.dirname, '..', 'dist');
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 500);
const MOTD = process.env.MOTD ?? '';
const SIM_HASH = simHash();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

// ------------------------------------------------------------------ static files

/** Request path, or null if it is malformed (bad escapes, NUL bytes, unparsable URL). */
function requestPath(raw: string | undefined): string | null {
  try {
    const p = decodeURIComponent(new URL(raw ?? '/', 'http://x').pathname);
    return p.includes('\0') ? null : p;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  try {
    serveStatic(req, res);
  } catch (err) {
    console.error('request error', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let p = requestPath(req.url);
  if (p === null) {
    res.writeHead(400).end();
    return;
  }
  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size, sim: SIM_HASH }));
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(DIST, p));
  if (!file.startsWith(DIST + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(DIST, 'index.html');
    fs.readFile(target, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(fs.existsSync(DIST) ? 'Not found' : 'Client not built yet. Run `npm run build` first.');
        return;
      }
      const ext = path.extname(target);
      const immutable = target.includes(`${path.sep}assets${path.sep}`);
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    });
  });
}

// ------------------------------------------------------------------ websocket lobby

interface Client extends RoomClient {
  ws: WebSocket;
  room: Room | null;
  hello: boolean;
  alive: boolean;
  budget: number;
}

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();

function newCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = '';
    for (let i = 0; i < 5; i++) s += A[crypto.randomInt(A.length)];
    if (!rooms.has(s)) return s;
  }
}

function cleanName(n: unknown): string {
  return String(n ?? '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 20) || 'Player';
}

function maxPlayers(map: string): number {
  return MAPS.find((m) => m.id === map)?.players ?? 2;
}

function publicRooms() {
  return [...rooms.values()].filter((r) => r.isPublic && !r.started).map((r) => r.info()).slice(0, 50);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  if (requestPath(req.url) !== '/ws') {
    socket.destroy();
    return;
  }
  try {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch (err) {
    console.error('upgrade error', err);
    socket.destroy();
  }
});

wss.on('connection', (ws: WebSocket) => {
  const c: Client = {
    id: crypto.randomUUID(),
    name: 'Player',
    ws,
    room: null,
    hello: false,
    alive: true,
    budget: 120,
    send(msg: S2C) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  clients.set(c.id, c);
  // protocol errors (oversized or invalid frames) close the socket; never crash the server
  ws.on('error', () => ws.terminate());
  ws.on('pong', () => (c.alive = true));
  ws.on('message', (raw) => {
    if (--c.budget < 0) return; // rate limited (refilled every second)
    let m: C2S;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    try {
      handle(c, m);
    } catch (err) {
      console.error('handler error', err);
    }
  });
  ws.on('close', () => {
    clients.delete(c.id);
    c.room?.leave(c);
  });
});

function handle(c: Client, m: C2S): void {
  if (m.t === 'hello') {
    c.name = cleanName(m.name);
    // lockstep needs identical simulations: refuse other versions instead of desyncing later
    const sim = typeof m.sim === 'string' ? m.sim : '';
    if (m.v !== PROTOCOL_VERSION || (sim !== SIM_HASH && sim !== 'dev')) {
      c.send({ t: 'error', msg: 'Your game version does not match this server. Please reload the page to update.' });
      c.ws.close(4001, 'version mismatch');
      return;
    }
    c.hello = true;
    c.send({ t: 'welcome', id: c.id, v: PROTOCOL_VERSION, motd: MOTD });
    return;
  }
  if (!c.hello) return;
  switch (m.t) {
    case 'ping':
      c.send({ t: 'pong', at: m.at });
      return;
    case 'list':
      c.send({ t: 'rooms', rooms: publicRooms() });
      return;
    case 'create': {
      if (rooms.size >= MAX_ROOMS) {
        c.send({ t: 'error', msg: 'Server is full, try again later' });
        return;
      }
      c.room?.leave(c);
      const map = MAPS.some((x) => x.id === m.map) ? m.map : MAPS[0].id;
      const room = new Room(newCode(), c, String(m.name ?? ''), map, maxPlayers(map), !!m.public);
      room.onEmpty = () => rooms.delete(room.code);
      rooms.set(room.code, room);
      c.room = room;
      c.send({ t: 'room', room: room.state() });
      return;
    }
    case 'join': {
      const room = rooms.get(String(m.code ?? '').toUpperCase().trim());
      if (!room) {
        c.send({ t: 'error', msg: 'Game not found, check the code' });
        return;
      }
      if (c.room && c.room !== room) {
        c.room.leave(c);
        c.room = null;
      }
      const err = room.join(c);
      if (err) c.send({ t: 'error', msg: err });
      else c.room = room;
      return;
    }
    case 'leaveRoom':
      c.room?.leave(c);
      c.room = null;
      c.send({ t: 'room', room: null });
      return;
    case 'rejoin': {
      const room = rooms.get(String(m.code ?? '').toUpperCase());
      if (!room) {
        c.send({ t: 'error', msg: 'That game has ended' });
        return;
      }
      const err = room.rejoin(c, String(m.token ?? ''), Number(m.from));
      if (err) c.send({ t: 'error', msg: err });
      else c.room = room;
      return;
    }
  }
  const room = c.room;
  if (!room) return;
  switch (m.t) {
    case 'slot':
      room.setSlot(c, m);
      return;
    case 'settings':
      room.settings(c, m, maxPlayers);
      return;
    case 'chat':
      room.chat(c, m.text);
      return;
    case 'start': {
      const err = room.start(c, Date.now());
      if (err) c.send({ t: 'error', msg: err });
      return;
    }
    case 'cmd':
      room.command(c, m.c);
      return;
    case 'ack':
      room.ack(c, Number(m.turn), m.hash, m.htick);
      return;
  }
}

// turn clocks
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    r.tickClock(now);
    if (r.abandoned) {
      for (const m of r.members.values()) (m as Client).room = null;
      rooms.delete(r.code);
    }
  }
}, 10);

// rate-limit refill + heartbeat
setInterval(() => {
  for (const c of clients.values()) c.budget = Math.min(240, c.budget + 120);
}, 1000);
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 20000);

server.listen(PORT, HOST, () => {
  console.log(`Bear War server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (sim ${SIM_HASH})`);
  if (!fs.existsSync(DIST)) console.log('Note: dist/ not found, run `npm run build` to serve the client from here.');
});
