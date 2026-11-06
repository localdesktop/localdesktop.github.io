import { TEAM_COLORS } from '../game/constants.ts';
import { RACES, RACE_IDS } from '../game/data/index.ts';
import { Game } from '../game/game.ts';
import { MAPS, loadMap } from '../game/map/maps.ts';
import { NetClient, defaultServerUrl } from '../net/client.ts';
import { NetSession } from '../net/netsession.ts';
import type { RoomInfo, RoomState, S2C } from '../net/protocol.ts';
import type { App } from './app.ts';
import { saveSettings } from './settings.ts';
import { h, mapPreview, select } from './ui.ts';

export function openMultiplayer(app: App): void {
  new Lobby(app).connectScreen();
}

class Lobby {
  app: App;
  client: NetClient | null = null;
  room: RoomState | null = null;
  rooms: RoomInfo[] = [];
  chat: { from: string; text: string; sys?: boolean }[] = [];
  error = '';
  private listTimer = 0;
  private unsub: (() => void) | null = null;

  constructor(app: App) {
    this.app = app;
  }

  private get s() {
    return this.app.settings;
  }

  connectScreen(msg = ''): void {
    const nameIn = h('input', { type: 'text', value: this.s.name, maxLength: 20 }) as HTMLInputElement;
    const urlIn = h('input', { type: 'url', value: this.s.server || defaultServerUrl(), spellcheck: false }) as HTMLInputElement;
    const status = h('p', { class: 'small', style: { color: 'var(--bad)', minHeight: '1em' } }, msg);
    const go = async () => {
      this.s.name = nameIn.value.trim().slice(0, 20) || 'Commander';
      const url = urlIn.value.trim();
      this.s.server = url === defaultServerUrl() ? '' : url;
      saveSettings(this.s);
      status.style.color = 'var(--muted)';
      status.textContent = 'Connecting…';
      const c = new NetClient();
      try {
        await c.connect(url, this.s.name);
      } catch (e) {
        status.style.color = 'var(--bad)';
        status.textContent = `${(e as Error).message}. Make sure an Bear War server is running at that address (see README → Multiplayer).`;
        return;
      }
      this.client = c;
      this.unsub = c.on((m) => this.onMessage(m));
      c.onClose(() => {
        if (this.app.game) return;
        this.stopList();
        this.connectScreen('Disconnected from server.');
      });
      const join = new URLSearchParams(location.search).get('join');
      if (join) c.send({ t: 'join', code: join });
      else this.browse();
    };
    this.app.show(
      h(
        'div',
        { class: 'screen' },
        h(
          'div',
          { class: 'menu', style: { maxWidth: '560px' } },
          h('div', { class: 'title' }, h('h1', { style: { fontSize: '30px' } }, 'Multiplayer')),
          h('div', { class: 'card' },
            h('label', { class: 'field' }, 'Your name', nameIn),
            h('div', { style: { height: '10px' } }),
            h('label', { class: 'field' }, 'Server', urlIn),
            h('p', { class: 'muted small' }, 'Online games run through a small relay server. Anyone can host one, see README.'),
            status,
          ),
          h('div', { class: 'row' },
            h('button', { class: 'mbtn', onclick: () => this.app.mainMenu() }, '← Back'),
            h('button', { class: 'mbtn primary', onclick: go }, 'Connect'),
          ),
        ),
      ),
    );
    // auto-connect when the page was opened through an invite link
    if (new URLSearchParams(location.search).has('join') && !msg) void go();
  }

  private onMessage(m: S2C): void {
    switch (m.t) {
      case 'rooms':
        this.rooms = m.rooms;
        if (!this.room) this.renderBrowse();
        break;
      case 'room':
        if (!m.room) {
          this.room = null;
          this.chat = [];
          this.browse();
        } else {
          const first = !this.room;
          this.room = m.room;
          if (first) this.chat = [];
          this.stopList();
          this.renderRoom();
        }
        break;
      case 'chat':
        this.chat.push({ from: m.from, text: m.text, sys: m.sys });
        if (this.chat.length > 100) this.chat.shift();
        if (this.room && !this.app.game) this.renderRoom();
        break;
      case 'error':
        this.error = m.msg;
        if (this.room) this.renderRoom();
        else this.renderBrowse();
        window.setTimeout(() => (this.error = ''), 4000);
        break;
      case 'start':
        this.startGame(m);
        break;
    }
  }

  private stopList(): void {
    window.clearInterval(this.listTimer);
    this.listTimer = 0;
  }

  browse(): void {
    this.room = null;
    this.client?.send({ t: 'list' });
    this.stopList();
    this.listTimer = window.setInterval(() => this.client?.send({ t: 'list' }), 3000);
    this.renderBrowse();
  }

  private renderBrowse(): void {
    if (this.app.game) return;
    const c = this.client!;
    let map = MAPS[0].id;
    let isPublic = true;
    const codeIn = h('input', { type: 'text', placeholder: 'Game code', maxLength: 5, style: { textTransform: 'uppercase' } }) as HTMLInputElement;
    const list = h('div', {});
    if (!this.rooms.length) list.appendChild(h('p', { class: 'muted small' }, 'No open public games right now, create one!'));
    for (const r of this.rooms) {
      list.appendChild(
        h('div', { class: 'row', style: { marginBottom: '6px' } },
          h('div', {}, h('b', {}, r.name), h('div', { class: 'muted small' }, `${MAPS.find((x) => x.id === r.map)?.name ?? r.map} · ${r.players}/${r.max} players`)),
          h('button', { class: 'mbtn', style: { flex: '0 0 auto', width: 'auto' }, onclick: () => c.send({ t: 'join', code: r.code }) }, 'Join'),
        ),
      );
    }
    this.app.show(
      h(
        'div',
        { class: 'screen' },
        h(
          'div',
          { class: 'menu', style: { maxWidth: '620px' } },
          h('div', { class: 'title' }, h('h1', { style: { fontSize: '30px' } }, 'Multiplayer'), this.client?.motd ? h('p', {}, this.client.motd) : null),
          this.error ? h('p', { style: { color: 'var(--bad)', textAlign: 'center' } }, this.error) : null,
          h('div', { class: 'card' },
            h('h3', {}, 'Create a game'),
            h('div', { class: 'row' },
              h('label', { class: 'field' }, 'Map', select(MAPS.map((m) => ({ value: m.id, label: `${m.name} (${m.players}p)` })), map, (v) => (map = v))),
              h('label', { class: 'toggle', style: { flex: '0 0 auto' } }, 'Public', h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => (isPublic = (e.target as HTMLInputElement).checked) })),
            ),
            h('div', { style: { height: '8px' } }),
            h('button', { class: 'mbtn primary', onclick: () => c.send({ t: 'create', name: `${this.s.name}'s game`, map, maxPlayers: MAPS.find((m) => m.id === map)?.players ?? 2, public: isPublic }) }, 'Create game'),
          ),
          h('div', { class: 'card' },
            h('h3', {}, 'Join with a code'),
            h('div', { class: 'row' }, codeIn, h('button', { class: 'mbtn', style: { flex: '0 0 auto', width: 'auto' }, onclick: () => c.send({ t: 'join', code: codeIn.value }) }, 'Join')),
          ),
          h('div', { class: 'card' }, h('h3', {}, 'Open games'), list),
          h('button', { class: 'mbtn', onclick: () => this.quit() }, '← Back to menu'),
        ),
      ),
    );
  }

  private renderRoom(): void {
    if (this.app.game || !this.room) return;
    const r = this.room;
    const c = this.client!;
    const me = c.id;
    const isHost = r.host === me;
    const raceOpts = [...RACE_IDS.map((x) => ({ value: x, label: RACES[x].name })), { value: 'random', label: 'Random' }];
    const slots = h('div', {});
    r.slots.forEach((s, i) => {
      const mine = s.id === me;
      const editable = mine || (isHost && s.kind === 'ai');
      let who: HTMLElement;
      if (s.kind === 'human') who = h('div', { class: 'who' }, `${s.name}${s.id === r.host ? ' ★' : ''}`);
      else if (isHost)
        who = select(
          [
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
            { value: 'ai:easy', label: 'AI · Easy' },
            { value: 'ai:normal', label: 'AI · Normal' },
            { value: 'ai:hard', label: 'AI · Hard' },
            { value: 'ai:brutal', label: 'AI · Brutal' },
          ],
          s.kind === 'ai' ? `ai:${s.ai}` : s.kind,
          (v) => {
            if (v.startsWith('ai:')) c.send({ t: 'slot', slot: i, kind: 'ai', ai: v.slice(3) as 'easy' });
            else c.send({ t: 'slot', slot: i, kind: v as 'open' });
          },
        );
      else who = h('div', { class: 'who muted' }, s.kind === 'ai' ? `Computer (${s.ai})` : s.kind === 'open' ? 'Open' : 'Closed');
      const occupied = s.kind === 'human' || s.kind === 'ai';
      const row = h(
        'div',
        { class: 'slot' },
        who,
        occupied && editable ? select(raceOpts, s.race, (v) => c.send({ t: 'slot', slot: i, race: v as 'random' })) : h('span', { class: 'muted small' }, occupied ? (s.race === 'random' ? 'Random' : RACES[s.race].name) : ''),
        occupied && editable
          ? select(TEAM_COLORS.map((col, ci) => ({ value: String(ci), label: col.name })), String(s.color), (v) => c.send({ t: 'slot', slot: i, color: Number(v) }))
          : h('span', {}, occupied ? h('span', { class: 'swatch', style: { background: TEAM_COLORS[s.color].main } }) : ''),
        occupied && editable
          ? select(Array.from({ length: r.slots.length }, (_, t) => ({ value: String(t), label: `Team ${t + 1}` })), String(s.team), (v) => c.send({ t: 'slot', slot: i, team: Number(v) }))
          : h('span', { class: 'muted small' }, occupied ? `Team ${s.team + 1}` : ''),
        isHost && s.kind === 'human' && !mine ? h('button', { class: 'qbtn', title: 'Kick', onclick: () => c.send({ t: 'slot', slot: i, kind: 'open' }) }, '✕') : h('span', {}),
      );
      slots.appendChild(row);
    });
    const chatBox = h('div', { class: 'chat' });
    for (const m of this.chat) chatBox.appendChild(h('div', { class: m.sys ? 'muted' : '' }, m.sys ? m.text : `${m.from}: ${m.text}`));
    const chatIn = h('input', { type: 'text', placeholder: 'Say something…', maxLength: 200 }) as HTMLInputElement;
    const send = () => {
      if (chatIn.value.trim()) c.send({ t: 'chat', text: chatIn.value });
      chatIn.value = '';
    };
    chatIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    const link = `${location.origin}${location.pathname}?join=${r.code}${this.s.server ? `&server=${encodeURIComponent(this.s.server)}` : ''}`;
    const el = h(
      'div',
      { class: 'screen' },
      h(
        'div',
        { class: 'menu' },
        h('div', { class: 'title' }, h('h1', { style: { fontSize: '26px' } }, r.name), h('p', {}, `Game code `, h('b', { style: { color: 'var(--accent)', letterSpacing: '0.2em' } }, r.code))),
        this.error ? h('p', { style: { color: 'var(--bad)', textAlign: 'center' } }, this.error) : null,
        h('div', { class: 'row' },
          h('button', { class: 'mbtn', onclick: () => { void navigator.clipboard?.writeText(link); this.chat.push({ from: '', text: 'Invite link copied to clipboard', sys: true }); this.renderRoom(); } }, '🔗 Copy invite link'),
          navigator.share ? h('button', { class: 'mbtn', onclick: () => void navigator.share({ title: 'Bear War', text: `Join my Bear War game (code ${r.code})`, url: link }).catch(() => {}) }, '📤 Share') : null,
        ),
        h('div', { class: 'card' },
          h('h3', {}, 'Settings'),
          isHost
            ? h('div', { class: 'row' },
                h('label', { class: 'field' }, 'Map', select(MAPS.map((m) => ({ value: m.id, label: `${m.name} (${m.players}p)` })), r.map, (v) => c.send({ t: 'settings', map: v }))),
                h('label', { class: 'field' }, 'Speed', select([{ value: '0.75', label: 'Slower' }, { value: '1', label: 'Normal' }, { value: '1.4', label: 'Faster' }], String(r.speed), (v) => c.send({ t: 'settings', speed: Number(v) }))),
              )
            : h('p', {}, `${MAPS.find((m) => m.id === r.map)?.name ?? r.map} · speed ${r.speed}×`),
          h('div', { class: 'map-row' }, mapPreview(r.map, 130), h('p', { class: 'muted small' }, MAPS.find((m) => m.id === r.map)?.desc ?? '')),
        ),
        h('div', { class: 'card' }, h('h3', {}, 'Players'), slots),
        h('div', { class: 'card' }, h('h3', {}, 'Chat'), chatBox, h('div', { class: 'row', style: { marginTop: '8px' } }, chatIn, h('button', { class: 'mbtn', style: { flex: '0 0 auto', width: 'auto' }, onclick: send }, 'Send'))),
        h('div', { class: 'row' },
          h('button', { class: 'mbtn', onclick: () => c.send({ t: 'leaveRoom' }) }, 'Leave'),
          isHost ? h('button', { class: 'mbtn primary', onclick: () => c.send({ t: 'start' }) }, 'Start game ▶') : h('div', { class: 'muted', style: { textAlign: 'center' } }, 'Waiting for the host to start…'),
        ),
      ),
    );
    this.app.show(el);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  private startGame(m: Extract<S2C, { t: 'start' }>): void {
    const c = this.client!;
    this.stopList();
    this.unsub?.();
    const game = new Game({ map: loadMap(m.map), players: m.players, seed: m.seed });
    const session = new NetSession(c, game, m.you, m.speed, { code: m.code, token: m.token, name: this.s.name });
    this.client = null;
    this.app.launch(session);
  }

  private quit(): void {
    this.stopList();
    this.unsub?.();
    this.client?.close();
    this.client = null;
    this.app.mainMenu();
  }
}
