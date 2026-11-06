import { TEAM_COLORS } from '../game/constants.ts';
import { RACES, RACE_IDS, DEFS } from '../game/data/index.ts';
import type { RaceId } from '../game/data/types.ts';
import { Game } from '../game/game.ts';
import { MAPS, loadMap } from '../game/map/maps.ts';
import type { AIDifficulty, PlayerSetup } from '../game/player.ts';
import { LocalSession } from '../net/session.ts';
import { AudioEngine } from '../audio/audio.ts';
import { SpriteCache } from '../render/sprites.ts';
import { GameScreen, type GameResult } from './gamescreen.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import { h, mapPreview, select } from './ui.ts';
import { ReplaySession, downloadText, makeReplay, parseReplay } from '../net/replay.ts';

export const GAME_TITLE = 'Bear War';
const SKIRMISH_KEY = 'bear-war:skirmish';
export const VERSION = '0.1.0';

type RacePick = RaceId | 'random';

interface SlotCfg {
  name: string;
  race: RacePick;
  color: number;
  team: number;
  ai: AIDifficulty | null;
}

export class App {
  root: HTMLElement;
  settings: Settings;
  audio: AudioEngine;
  screen: HTMLElement | null = null;
  game: GameScreen | null = null;
  private icons = new SpriteCache(2, 1.5);
  skirmish = {
    map: MAPS[0].id,
    speed: 1,
    slots: [] as SlotCfg[],
  };

  constructor(root: HTMLElement) {
    this.root = root;
    this.settings = loadSettings();
    this.audio = new AudioEngine(this.settings);
    this.skirmish.slots = [
      { name: this.settings.name, race: 'ironpaw', color: 1, team: 0, ai: null },
      { name: 'Computer', race: 'random', color: 0, team: 1, ai: 'normal' },
    ];
    try {
      const saved = JSON.parse(localStorage.getItem(SKIRMISH_KEY) ?? 'null');
      if (saved && Array.isArray(saved.slots) && saved.slots.length >= 2 && MAPS.some((m) => m.id === saved.map)) {
        this.skirmish.map = saved.map;
        this.skirmish.speed = Number(saved.speed) || 1;
        this.skirmish.slots = saved.slots;
        this.skirmish.slots[0].name = this.settings.name;
      }
    } catch {
      // ignore unreadable saved config
    }
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: false, passive: true });
    window.addEventListener('keydown', unlock, { once: false });
  }

  show(el: HTMLElement): void {
    this.screen?.remove();
    this.screen = el;
    this.root.appendChild(el);
  }

  // ------------------------------------------------------------------ main menu

  mainMenu(): void {
    this.audio.startMusic();
    const m = h(
      'div',
      { class: 'menu' },
      h('div', { class: 'title' }, h('h1', {}, GAME_TITLE), h('p', {}, 'Real-time strategy · three bear clans · one forest')),
      h('button', { class: 'mbtn primary', onclick: () => this.skirmishMenu() }, 'Skirmish vs AI', h('small', {}, 'Play offline against computer opponents')),
      h('button', { class: 'mbtn', onclick: () => this.multiplayerMenu() }, 'Multiplayer', h('small', {}, 'Play online against friends')),
      h('button', { class: 'mbtn', onclick: () => this.helpScreen() }, 'How to Play', h('small', {}, 'Controls, clans and tips')),
      h('button', { class: 'mbtn', onclick: () => this.openReplay() }, 'Watch a Replay', h('small', {}, 'Load a saved .json replay file')),
      h('button', { class: 'mbtn', onclick: () => this.settingsScreen(() => this.mainMenu()) }, 'Settings'),
      h('button', { class: 'mbtn', onclick: () => this.aboutScreen() }, 'About & Licenses'),
      h('p', { class: 'muted small', style: { textAlign: 'center' } }, `v${VERSION} · open source (MIT) · not affiliated with any commercial game publisher`),
    );
    this.show(h('div', { class: 'screen' }, m, document.fullscreenEnabled ? h('button', { class: 'qbtn fs-btn', title: 'Fullscreen', onclick: () => toggleFullscreen() }, '⛶') : null));
  }

  // ------------------------------------------------------------------ skirmish

  private raceOptions(): { value: string; label: string }[] {
    return [...RACE_IDS.map((r) => ({ value: r, label: RACES[r].name })), { value: 'random', label: 'Random' }];
  }

  skirmishMenu(): void {
    const sk = this.skirmish;
    const info = MAPS.find((m) => m.id === sk.map) ?? MAPS[0];
    const maxPlayers = info.players;
    sk.slots = sk.slots.slice(0, maxPlayers);
    const rerender = () => this.skirmishMenu();
    const slotsEl = h('div', {});
    sk.slots.forEach((s, i) => {
      const row = h(
        'div',
        { class: 'slot' },
        h('div', { class: 'who' }, i === 0 ? s.name : 'Computer'),
        select(this.raceOptions(), s.race, (v) => (s.race = v as RacePick)),
        i === 0
          ? h('span', { class: 'muted small' }, 'You')
          : select(
              [
                { value: 'easy', label: 'Easy' },
                { value: 'normal', label: 'Normal' },
                { value: 'hard', label: 'Hard' },
                { value: 'brutal', label: 'Brutal' },
              ],
              s.ai ?? 'normal',
              (v) => (s.ai = v as AIDifficulty),
            ),
        select(
          Array.from({ length: maxPlayers }, (_, t) => ({ value: String(t), label: `Team ${t + 1}` })),
          String(s.team),
          (v) => (s.team = Number(v)),
        ),
        i === 0
          ? h('span', { class: 'swatch', style: { background: TEAM_COLORS[s.color].main } })
          : h('button', { class: 'qbtn', title: 'Remove', onclick: () => { sk.slots.splice(i, 1); rerender(); } }, '✕'),
      );
      slotsEl.appendChild(row);
    });
    const canAdd = sk.slots.length < maxPlayers;
    const m = h(
      'div',
      { class: 'menu' },
      h('div', { class: 'title' }, h('h1', { style: { fontSize: '30px' } }, 'Skirmish')),
      h('div', { class: 'card' }, h('h3', {}, 'Choose your clan'), this.raceCards(sk.slots[0].race, (r) => { sk.slots[0].race = r; rerender(); })),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Battlefield'),
        h(
          'div',
          { class: 'row' },
          h('label', { class: 'field' }, 'Map', select(MAPS.map((m) => ({ value: m.id, label: `${m.name} (${m.players}p)` })), sk.map, (v) => { sk.map = v; rerender(); })),
          h('label', { class: 'field' }, 'Game speed', select([
            { value: '0.75', label: 'Slower' },
            { value: '1', label: 'Normal' },
            { value: '1.4', label: 'Faster' },
          ], String(sk.speed), (v) => (sk.speed = Number(v)))),
        ),
        h('div', { class: 'map-row' }, mapPreview(sk.map, 150), h('p', { class: 'muted small' }, info.desc)),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Players'),
        slotsEl,
        canAdd
          ? h('button', { class: 'mbtn', onclick: () => {
              const used = new Set(sk.slots.map((s) => s.color));
              const color = [0, 2, 3, 4, 5, 6, 7, 1].find((c) => !used.has(c)) ?? 0;
              sk.slots.push({ name: 'Computer', race: 'random', color, team: sk.slots.length, ai: 'normal' });
              rerender();
            } }, '+ Add computer player')
          : null,
      ),
      h('div', { class: 'row' },
        h('button', { class: 'mbtn', onclick: () => this.mainMenu() }, '← Back'),
        h('button', { class: 'mbtn primary', onclick: () => this.startSkirmish() }, 'Start game ▶'),
      ),
    );
    this.show(h('div', { class: 'screen' }, m));
  }

  private raceCards(cur: RacePick, pick: (r: RacePick) => void): HTMLElement {
    const wrap = h('div', { class: 'races' });
    for (const r of RACE_IDS) {
      const race = RACES[r];
      const icon = this.icons.icon(DEFS[race.worker === 'hardhat' ? 'ranger' : race.worker === 'forager' ? 'scrapper' : 'spiritbear'], 1, 128);
      const c = h('div', { class: 'race' + (cur === r ? ' sel' : ''), onclick: () => pick(r) }, icon, h('b', {}, race.name), h('small', {}, race.desc));
      wrap.appendChild(c);
    }
    const rnd = h('div', { class: 'race' + (cur === 'random' ? ' sel' : ''), onclick: () => pick('random'), style: { gridColumn: '1 / -1' } }, h('b', {}, '🎲 Random'));
    wrap.appendChild(rnd);
    return wrap;
  }

  startSkirmish(): void {
    const sk = this.skirmish;
    try {
      localStorage.setItem(SKIRMISH_KEY, JSON.stringify(sk));
    } catch {
      // storage unavailable
    }
    const seed = (Math.random() * 2 ** 31) | 0;
    const rnd = (r: RacePick): RaceId => (r === 'random' ? RACE_IDS[Math.floor(Math.random() * 3)] : r);
    const players: PlayerSetup[] = sk.slots.map((s, i) => ({
      name: i === 0 ? this.settings.name || 'Commander' : `${(s.ai ?? 'normal')[0].toUpperCase()}${(s.ai ?? 'normal').slice(1)} AI`,
      race: rnd(s.race),
      color: s.color,
      team: s.team,
      ai: i === 0 ? null : s.ai ?? 'normal',
    }));
    // ensure at least two teams
    if (new Set(players.map((p) => p.team)).size < 2 && players.length > 1) players.forEach((p, i) => (p.team = i));
    const game = new Game({ map: loadMap(sk.map), players, seed });
    const session = new LocalSession(game, 0);
    session.speed = sk.speed;
    this.launch(session);
  }

  launch(session: LocalSession | import('../net/session.ts').Session): void {
    this.screen?.remove();
    this.screen = null;
    this.audio.stopMusic();
    this.audio.startMusic();
    const gs = new GameScreen(this.root, {
      session,
      settings: this.settings,
      audio: this.audio,
      onMenu: (s) => this.ingameMenu(s),
      onEnd: (r) => this.endScreen(r),
    });
    this.game = gs;
    gs.start();
  }

  // ------------------------------------------------------------------ in-game menu

  ingameMenu(gs: GameScreen): void {
    const s = gs.session;
    const wasPaused = s.paused;
    if (!s.online) s.paused = true;
    const close = () => {
      if (!s.online) s.paused = wasPaused;
      overlay.remove();
    };
    const overlay = h(
      'div',
      { class: 'screen overlay' },
      h(
        'div',
        { class: 'menu', style: { maxWidth: '420px' } },
        h('div', { class: 'title' }, h('h1', { style: { fontSize: '28px' } }, s.online ? 'Menu' : 'Paused')),
        s.localPlayer >= 0 && !s.online && s.log.length >= 0
          ? h('button', { class: 'mbtn', onclick: () => {
              const g = s.game;
              downloadText(`bear-war-${g.tick}.json`, JSON.stringify(makeReplay(g, g.setups, s.log, VERSION)));
            } }, '💾 Save replay so far')
          : null,
        h('button', { class: 'mbtn primary', onclick: close }, 'Resume'),
        document.fullscreenEnabled ? h('button', { class: 'mbtn', onclick: () => toggleFullscreen() }, document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen') : null,
        h('button', { class: 'mbtn', onclick: () => { overlay.remove(); this.settingsScreen(() => this.root.appendChild(overlay), true); } }, 'Settings'),
        h('button', { class: 'mbtn', onclick: () => { overlay.remove(); this.helpScreen(true, () => this.root.appendChild(overlay)); } }, 'How to Play'),
        s.localPlayer >= 0 ? h('button', { class: 'mbtn danger', onclick: () => { s.issue({ c: 'surrender' }); close(); } }, 'Surrender') : null,
        h('button', { class: 'mbtn danger', onclick: () => { if (s.online) s.issue({ c: 'leave' }); overlay.remove(); this.quitGame(); } }, 'Quit to main menu'),
      ),
    );
    this.root.appendChild(overlay);
  }

  openReplay(): void {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      try {
        const rep = parseReplay(await f.text());
        this.launch(new ReplaySession(rep));
      } catch (e) {
        alert(`Could not open replay: ${(e as Error).message}`);
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  quitGame(): void {
    this.game?.dispose();
    this.game = null;
    this.mainMenu();
  }

  // ------------------------------------------------------------------ end screen

  endScreen(r: GameResult): void {
    const g = r.session.game;
    const rows = g.players.map((p) =>
      h(
        'tr',
        {},
        h('td', {}, h('span', { class: 'swatch', style: { background: TEAM_COLORS[p.color].main, marginRight: '6px' } }), `${p.name} (${RACES[p.race].name})`),
        h('td', {}, String(p.stats.mineralsGathered + p.stats.gasGathered)),
        h('td', {}, String(p.stats.unitsProduced)),
        h('td', {}, String(p.stats.unitsKilled + p.stats.buildingsKilled)),
        h('td', {}, String(p.stats.unitsLost + p.stats.buildingsLost)),
        h('td', {}, g.winners.includes(p.index) ? '🏆' : '-'),
      ),
    );
    const spectator = r.session.localPlayer < 0;
    const mins = Math.floor(g.time / 60);
    const secs = Math.floor(g.time % 60).toString().padStart(2, '0');
    const overlay = h(
      'div',
      { class: 'screen overlay' },
      h(
        'div',
        { class: 'menu' },
        h('div', { class: 'banner ' + (spectator ? 'win' : r.won ? 'win' : 'lose') }, spectator ? 'GAME OVER' : r.draw ? 'DRAW' : r.won ? 'VICTORY' : 'DEFEAT'),
        h('p', { class: 'muted', style: { textAlign: 'center' } }, `Game time ${mins}:${secs}`),
        h(
          'div',
          { class: 'card' },
          h('table', { class: 'stats-table' },
            h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Resources'), h('th', {}, 'Units'), h('th', {}, 'Kills'), h('th', {}, 'Losses'), h('th', {}, '')),
            ...rows,
          ),
        ),
        spectator
          ? null
          : h('button', { class: 'mbtn', onclick: () => {
              const rep = makeReplay(g, g.setups, r.session.log, VERSION);
              const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
              downloadText(`bear-war-${stamp}.json`, JSON.stringify(rep));
            } }, '💾 Save replay'),
        h('div', { class: 'row' },
          h('button', { class: 'mbtn', onclick: () => overlay.remove() }, 'Keep watching'),
          h('button', { class: 'mbtn primary', onclick: () => { overlay.remove(); this.quitGame(); } }, 'Main menu'),
        ),
      ),
    );
    this.root.appendChild(overlay);
    if (!spectator) this.audio.say(r.won ? 'Victory' : 'Defeat');
  }

  // ------------------------------------------------------------------ settings

  settingsScreen(back: () => void, overlay = false): void {
    const s = this.settings;
    const save = () => {
      saveSettings(s);
      this.audio.applySettings();
      if (this.game) {
        this.game.input.edgeScroll = s.edgeScroll;
        this.game.input.scrollSpeed = s.scrollSpeed;
        this.game.ctl.view.showAllBars = s.allBars;
        this.game.renderer.fx.lowFx = s.lowFx;
        this.game.renderer.maxDpr = s.maxDpr;
        this.game.resize();
      }
    };
    const range = (label: string, key: 'master' | 'sfx' | 'music' | 'scrollSpeed', min: number, max: number, step: number) =>
      h('label', { class: 'field' }, label, h('input', { type: 'range', min, max, step, value: String(s[key]), oninput: (e: Event) => { s[key] = Number((e.target as HTMLInputElement).value); save(); } }));
    const toggle = (label: string, key: 'voice' | 'edgeScroll' | 'allBars' | 'lowFx' | 'tips') =>
      h('label', { class: 'toggle' }, label, h('input', { type: 'checkbox', checked: s[key], onchange: (e: Event) => { s[key] = (e.target as HTMLInputElement).checked; save(); } }));
    const el = h(
      'div',
      { class: 'screen' + (overlay ? ' overlay' : '') },
      h(
        'div',
        { class: 'menu', style: { maxWidth: '520px' } },
        h('div', { class: 'title' }, h('h1', { style: { fontSize: '28px' } }, 'Settings')),
        h('div', { class: 'card' },
          h('label', { class: 'field' }, 'Player name', h('input', { type: 'text', value: s.name, maxLength: 20, oninput: (e: Event) => { s.name = (e.target as HTMLInputElement).value.slice(0, 20); if (this.skirmish.slots[0]) this.skirmish.slots[0].name = s.name; save(); } })),
        ),
        h('div', { class: 'card' }, h('h3', {}, 'Audio'), range('Master volume', 'master', 0, 1, 0.05), range('Effects', 'sfx', 0, 1, 0.05), range('Music', 'music', 0, 1, 0.05), toggle('Spoken announcements', 'voice')),
        h('div', { class: 'card' }, h('h3', {}, 'Controls'), range('Scroll speed', 'scrollSpeed', 0.4, 2.5, 0.1), toggle('Edge scrolling (mouse)', 'edgeScroll'), toggle('Show tips at the start of a game', 'tips')),
        h('div', { class: 'card' },
          h('h3', {}, 'Graphics'),
          toggle('Always show health bars', 'allBars'),
          toggle('Reduced effects (faster on old phones)', 'lowFx'),
          h('label', { class: 'field' }, 'Resolution', select([
            { value: '1', label: 'Standard (fastest)' },
            { value: '1.5', label: 'High' },
            { value: '2', label: 'Retina' },
            { value: '3', label: 'Maximum' },
          ], String(s.maxDpr), (v) => { s.maxDpr = Number(v); save(); })),
        ),
        h('button', { class: 'mbtn primary', onclick: () => { el.remove(); back(); } }, 'Done'),
      ),
    );
    if (overlay) this.root.appendChild(el);
    else this.show(el);
  }

  // ------------------------------------------------------------------ help & about

  helpScreen(overlay = false, back?: () => void): void {
    const done = () => {
      el.remove();
      if (back) back();
      else this.mainMenu();
    };
    const el = h(
      'div',
      { class: 'screen' + (overlay ? ' overlay' : '') },
      h(
        'div',
        { class: 'menu help' },
        h('div', { class: 'title' }, h('h1', { style: { fontSize: '28px' } }, 'How to Play')),
        h('div', { class: 'card', html: HELP_HTML }),
        h('button', { class: 'mbtn primary', onclick: done }, 'Back'),
      ),
    );
    if (overlay) this.root.appendChild(el);
    else this.show(el);
  }

  aboutScreen(): void {
    this.show(
      h(
        'div',
        { class: 'screen' },
        h(
          'div',
          { class: 'menu help' },
          h('div', { class: 'title' }, h('h1', { style: { fontSize: '28px' } }, 'About')),
          h('div', { class: 'card', html: ABOUT_HTML }),
          h('button', { class: 'mbtn primary', onclick: () => this.mainMenu() }, 'Back'),
        ),
      ),
    );
  }

  multiplayerMenu(): void {
    // implemented in net/lobby.ts (registered at startup)
    this.mp?.(this);
  }
  mp?: (app: App) => void;
}

const HELP_HTML = `
<h3>Goal</h3>
<p>Gather resources, build an army and destroy every enemy structure.</p>
<h3>Economy</h3>
<p>Workers mine <b>minerals</b> and <b>gas</b> (gas needs a refinery on a geyser). Two to three workers per mineral field is ideal. Units cost <b>supply</b>: stock up before you are blocked (Ironpaw Larders, Honey Horde Bumblebears, Starborn Star Totems).</p>
<h3>Clans</h3>
<p><b>Ironpaw</b>: Hardhats construct buildings and must stay until they are finished; they can repair machines. Damaged buildings burn down unless repaired.<br>
<b>Honey Horde</b>: Hives raise cubs; select a Hive to grow cubs into any bear. Foragers settle into buildings, which must stand on honeycomb. Every Horde bear heals over time.<br>
<b>Starborn</b>: Snowcubs call down buildings and are free immediately. Most buildings need a Star Totem's glow. Aurora shields regenerate out of combat.</p>
<h3>Touch controls</h3>
<p>Tap a unit to select it, double-tap to select all of that type. With units selected, tap the ground to move, tap an enemy to attack, tap minerals to mine. Drag with one finger to pan, pinch to zoom. Long-press then drag (or use the ▢ button) to box-select. Use the command card for attack-move, abilities and building. Long-press a button for details. Long-press a group number to assign a control group.</p>
<h3>Mouse &amp; keyboard</h3>
<p>Left-click select · drag to box-select · <kbd>Shift</kbd>+click add/remove · double-click or <kbd>Ctrl</kbd>+click selects all of a type · right-click smart command (move, attack, gather, repair) · <kbd>Shift</kbd> queues orders.<br>
Command-card keys follow the button positions on the left of the keyboard, and the letter on each button matches your layout (QWERTY: <kbd>Q</kbd> <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd> / <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>F</kbd> / <kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd>) · <kbd>Esc</kbd> cancel.<br>
<kbd>Ctrl</kbd>+<kbd>1-9</kbd> set control group · <kbd>1-9</kbd> select (twice to jump) · <kbd>F1</kbd> idle worker · <kbd>F2</kbd> army · <kbd>Tab</kbd> cycle subgroup · <kbd>Space</kbd> last alert · <kbd>Backspace</kbd> cycle bases · arrows / screen edges / middle-drag scroll · wheel zoom.</p>
<h3>Tips</h3>
<p>Set a rally point on minerals and new workers mine automatically. Ground units cannot see up cliffs. Hidden units (Shadowpaws, Little Dippers, dug-in Sappers and hibernating Burrowers) need detection: Flak Turrets, Big Sniff, Lookouts, Bumblebears, Sting Towers, Star Lanterns, Little Dippers or Revelation.</p>`;

const ABOUT_HTML = `
<p><b>${GAME_TITLE}</b> is a free and open-source real-time strategy game for desktop and mobile browsers, inspired by classic RTS gameplay. Every clan, bear, name, graphic and sound in this game is original.</p>
<p>All graphics are drawn procedurally in code and all sound effects and music are synthesized in real time with the Web Audio API, so the game ships <b>no third-party art, audio or fonts</b>.</p>
<p>Source code is released under the <b>MIT License</b>. Runtime dependency: <i>ws</i> (MIT, server only). Build tools: Vite (MIT), TypeScript (Apache-2.0).</p>
<p>This project is not affiliated with or endorsed by any commercial game publisher. All trademarks belong to their respective owners.</p>`;

export function boot(root: HTMLElement): App {
  const app = new App(root);
  app.mainMenu();
  return app;
}

export function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else {
    void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    // lock to landscape where supported (Android)
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    so.lock?.('landscape').catch(() => {});
  }
}

export function colorName(i: number): string {
  return TEAM_COLORS[i]?.name ?? '?';
}
