import './style.css';
import { boot } from './app/app.ts';
import { openMultiplayer } from './app/lobby.ts';
import { saveSettings } from './app/settings.ts';
import { RACE_IDS } from './game/data/index.ts';
import type { RaceId } from './game/data/types.ts';
import { Game } from './game/game.ts';
import { MAPS, loadMap } from './game/map/maps.ts';
import type { AIDifficulty } from './game/player.ts';
import { LocalSession } from './net/session.ts';

const root = document.getElementById('app')!;
const app = boot(root);
app.mp = openMultiplayer;

// expose for debugging in the console
(window as unknown as { bearwar: unknown }).bearwar = app;

// quick start for development / sharing:  ?quick&race=horde&vs=starborn&ai=hard&map=twin-craters
const q = new URLSearchParams(location.search);
if (q.get('server')) {
  app.settings.server = q.get('server')!;
  saveSettings(app.settings);
}
if (q.has('join')) {
  app.multiplayerMenu();
} else if (q.has('quick')) {
  const race = (q.get('race') ?? 'ironpaw') as RaceId;
  const vs = (q.get('vs') ?? 'random') as RaceId | 'random';
  const ai = (q.get('ai') ?? 'normal') as AIDifficulty;
  app.skirmish.slots[0].race = race;
  app.skirmish.slots[1].race = vs;
  app.skirmish.slots[1].ai = ai;
  if (q.get('map')) app.skirmish.map = q.get('map')!;
  app.startSkirmish();
} else if (q.has('attract')) {
  document.body.classList.add('attract');
  app.settings.master = 0;
  app.ingameMenu = () => {};
  app.endScreen = () => location.reload();
  const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const players = [0, 1].map((i) => ({ name: 'AI', race: pick(RACE_IDS), color: i, team: i, ai: 'hard' as const }));
  app.launch(new LocalSession(new Game({ map: loadMap(pick(MAPS).id), players, seed: (Math.random() * 2 ** 31) | 0 }), -1));
  const cam = app.game!.renderer.cam;
  let to = { x: cam.centerX, y: cam.centerY };
  let userUntil = 0;
  let team = -1;
  for (const ev of ['pointerdown', 'wheel', 'keydown']) addEventListener(ev, () => (userUntil = performance.now() + 20000), { capture: true, passive: true });
  const retarget = () => {
    const g = app.game!.session.game;
    const mine = g.entities.filter((e) => e.alive && e.owner >= 0 && (team < 0 || g.players[e.owner].team === team));
    const army = mine.filter((e) => !e.isBuilding && !e.def.worker);
    const fighting = army.filter((e) => e.cds.some((c) => c > 0));
    to = pick(fighting.length ? fighting : army.length ? army : mine) ?? to;
  };
  setInterval(retarget, 8000);
  const glide = () => {
    if (app.game!.ctl.view.team !== team) {
      team = app.game!.ctl.view.team;
      userUntil = 0;
      retarget();
    }
    if (performance.now() > userUntil) cam.centerOn(cam.centerX + (to.x - cam.centerX) * 0.02, cam.centerY + (to.y - cam.centerY) * 0.02);
    requestAnimationFrame(glide);
  };
  glide();
  document.querySelector<HTMLElement>('.spec-auto')?.click();
}

if (!q.has('attract')) {
  // AdSense H5 Games Ads: the preroll is a no-op until game ads are enabled for the site
  ((window as unknown as { adsbygoogle?: object[] }).adsbygoogle ??= []).push({ type: 'preroll' });
  const ads = Object.assign(document.createElement('script'), { async: true, crossOrigin: 'anonymous', src: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8496762857844623' });
  if (import.meta.env.DEV) ads.dataset.adbreakTest = 'on';
  document.head.append(ads);
}

// offline support: cache the whole game once it has been loaded (production builds only)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker registration failed', err));
  });
}

// prevent pinch-zoom / double-tap zoom of the page itself on iOS
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
