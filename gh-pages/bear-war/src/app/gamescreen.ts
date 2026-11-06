import { TILE } from '../game/constants.ts';
import { DEFS, RESEARCH_DEFS } from '../game/data/index.ts';
import type { Entity } from '../game/entity.ts';
import type { GameEvent } from '../game/types.ts';
import type { Session } from '../net/session.ts';
import { Renderer } from '../render/renderer.ts';
import { Minimap } from '../render/minimap.ts';
import { Controller, type Feedback } from '../ui/controller.ts';
import { Hud } from '../ui/hud.ts';
import { Input } from '../ui/input.ts';
import type { AudioEngine } from '../audio/audio.ts';
import { saveSettings, type Settings } from './settings.ts';
import { supplyError } from '../game/systems/structures.ts';

export interface GameResult {
  won: boolean;
  draw: boolean;
  session: Session;
}

export interface GameScreenOptions {
  session: Session;
  settings: Settings;
  audio: AudioEngine;
  onMenu: (screen: GameScreen) => void;
  onEnd: (result: GameResult) => void;
}

export class GameScreen {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  session: Session;
  renderer: Renderer;
  minimap: Minimap;
  ctl: Controller;
  hud: Hud;
  input: Input;
  opts: GameScreenOptions;
  private raf = 0;
  private last = 0;
  private mmTimer = 0;
  private ended = false;
  private endTimer = -1;
  private fpsAcc = 0;
  private fpsN = 0;
  fps = 60;
  private onResize = () => this.resize();
  private bgTimer = 0;
  private lastFrame = 0;
  private lastBg = 0;
  /**
   * Online games must keep simulating even when the browser stops delivering animation
   * frames (hidden or occluded tab, app switch on mobile), or every other player would
   * be paused waiting for us. A watchdog timer steps the session whenever frames stall.
   */
  private watchdog = () => {
    const now = performance.now();
    if (now - this.lastFrame < 300) {
      this.lastBg = now;
      return;
    }
    const dt = Math.min(1000, now - (this.lastBg || now));
    this.lastBg = now;
    this.session.update(dt);
    const evs = this.session.drainEvents();
    this.handleEvents(evs.filter((e) => e.k === 'gameover' || e.k === 'defeat'));
  };
  private onVisibility = () => {
    if (document.hidden) return;
    this.last = performance.now();
    this.resize();
    if (this.pendingCenter && window.innerWidth > 1) {
      this.renderer.cam.centerOn(this.pendingCenter.x, this.pendingCenter.y);
      this.pendingCenter = null;
    }
  };

  constructor(parent: HTMLElement, opts: GameScreenOptions) {
    this.opts = opts;
    this.session = opts.session;
    const g = this.session.game;
    this.root = document.createElement('div');
    this.root.className = 'game-root';
    parent.appendChild(this.root);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'world';
    this.root.appendChild(this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.renderer.maxDpr = opts.settings.maxDpr;
    this.renderer.setGame(g);
    this.renderer.fx.lowFx = opts.settings.lowFx;
    if (this.renderer.terrain && (matchMedia('(pointer: coarse)').matches || opts.settings.lowFx)) this.renderer.terrain.budgetMs = 4;
    const audio = opts.audio;
    const fb: Feedback = {
      ack: (kind, e?: Entity) => {
        if (kind === 'click') audio.ui('click');
        else if (kind === 'error') audio.ui('error');
        else audio.ack(kind, e?.def.race);
      },
      message: (text, kind) => this.hud.message(text, kind === 'error' ? 'error' : 'info'),
    };
    this.ctl = new Controller(g, this.session, this.renderer, fb);
    this.ctl.view.showAllBars = opts.settings.allBars;
    let boxMode = false;
    const touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.hud = new Hud(this.root, g, this.ctl, this.renderer.sprites, {
      onMenu: () => opts.onMenu(this),
      boxMode: () => boxMode,
      setBoxMode: (on) => {
        boxMode = on;
        this.input.boxMode = on;
      },
      touch: () => touch,
      chat: 'chat' in this.session ? (text: string) => (this.session as unknown as { chat(t: string): void }).chat(text) : undefined,
      setSpeed: this.session.online ? undefined : (sp: number) => (this.session.speed = sp),
      togglePause: this.session.online ? undefined : () => (this.session.paused = !this.session.paused),
    });
    this.minimap = new Minimap(this.hud.minimapCanvas);
    this.minimap.setGame(g, this.renderer.terrain!);
    this.input = new Input(this.canvas, this.ctl, this.hud, this.minimap);
    this.input.edgeScroll = opts.settings.edgeScroll;
    this.input.onMenu = () => opts.onMenu(this);
    this.input.onPause = () => {
      if (!this.session.online) this.session.paused = !this.session.paused;
      this.hud.setStatus(this.session.paused ? 'Paused' : '');
    };
    this.input.scrollSpeed = opts.settings.scrollSpeed;
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize(true);
    const chatSink = this.session as { onChat?: ((from: string, text: string, sys: boolean) => void) | null };
    if ('onChat' in chatSink) chatSink.onChat = (from, text, sys) => this.hud.message(sys ? text : `${from}: ${text}`, 'info');
    // start looking at our base
    const me = g.players[this.session.localPlayer];
    const base = me ? g.map.bases[me.startBase] : g.map.bases[0];
    if (base) {
      this.pendingCenter = { x: (base.tx + 2.5) * TILE, y: (base.ty + 2.5) * TILE };
      if (window.innerWidth > 1) {
        this.renderer.cam.centerOn(this.pendingCenter.x, this.pendingCenter.y);
        this.pendingCenter = null;
      }
    }
    if (me) {
      const hall = g.entities.find((e) => e.owner === me.index && e.def.townHall);
      if (hall) this.ctl.lastAlert = { x: hall.x, y: hall.y };
    }
  }

  private showTips(): void {
    const touch = this.input.touchMode;
    const race = this.session.game.players[this.session.localPlayer]?.race;
    const tips = touch
      ? [
          'Tap a unit to select it. Tap the ground to move, an enemy to attack, minerals to mine.',
          'Drag with one finger to pan, pinch to zoom. Long-press and drag to box-select.',
          'Select your main building and train workers, and keep them mining!',
          race === 'horde' ? 'Honey Horde: select a Hive to grow its cubs into bears. Raise Bumblebears for supply.' : race === 'starborn' ? 'Starborn: call down Star Totems first, most structures need their glow.' : 'Ironpaw: Hardhats must stay while constructing. Build Larders for supply.',
        ]
      : [
          'Left-click to select, drag to box-select, right-click to move, attack or mine.',
          'Select your main building and train workers (hotkeys are shown on the buttons).',
          'Ctrl+1–9 sets control groups, F2 selects your army, A attack-moves.',
          race === 'horde' ? 'Honey Horde: select a Hive to grow its cubs into bears. Raise Bumblebears for supply.' : race === 'starborn' ? 'Starborn: call down Star Totems first, most structures need their glow.' : 'Ironpaw: Hardhats must stay while constructing. Build Larders for supply.',
        ];
    tips.forEach((t, i) => window.setTimeout(() => this.hud.message(t, 'info'), 1500 + i * 4500));
    this.opts.settings.tips = false;
    saveSettings(this.opts.settings);
  }

  start(): void {
    if (this.opts.settings.tips && this.session.localPlayer >= 0 && !this.session.online) this.showTips();
    this.last = performance.now();
    this.lastFrame = this.last;
    if (this.session.online) this.bgTimer = window.setInterval(this.watchdog, 100);
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.input.dispose();
    this.hud.dispose();
    this.session.dispose();
    window.clearInterval(this.bgTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  private pendingCenter: { x: number; y: number } | null = null;

  resize(first = false): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cam = this.renderer.cam;
    // a hidden tab can report a 0x0 window; wait until we are visible
    if (w < 2 || h < 2) return;
    const firstReal = cam.w < 2 || first;
    this.renderer.resize(w, h);
    const touch = this.input?.touchMode ?? matchMedia('(pointer: coarse)').matches;
    // phones: ~22 tiles across in landscape, ~11 in portrait; desktop: ~30 tiles
    const base = touch ? Math.min(Math.max(w, h) / (TILE * 22), Math.min(w, h) / (TILE * 11)) : Math.max(w, h) / (TILE * 30);
    cam.minZoom = base * 0.5;
    cam.maxZoom = base * 2.4;
    if (firstReal || !(cam.zoom > 0)) cam.zoom = base;
    else cam.setZoom(cam.zoom);
    const mmSize = Math.min(w, h) < 520 || w < 760 ? 104 : 182;
    this.minimap.resize(mmSize);
    const bottom = this.root.querySelector('.hud-bottom') as HTMLElement | null;
    cam.insetBottom = bottom ? Math.min(h * 0.4, bottom.getBoundingClientRect().height) : 0;
    cam.clamp();
  }

  private frame(t: number): void {
    const dtMs = Math.min(100, t - this.last);
    this.last = t;
    this.lastFrame = performance.now();
    this.lastBg = this.lastFrame;
    const dt = dtMs / 1000;
    this.fpsAcc += dtMs;
    this.fpsN++;
    if (this.fpsAcc > 1000) {
      this.fps = (this.fpsN * 1000) / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
      this.adaptQuality();
    }
    const s = this.session;
    const g = s.game;
    const alpha = s.update(dtMs);
    const events = s.drainEvents();
    if (events.length) {
      this.renderer.fx.onEvents(events, g);
      this.opts.audio.onEvents(events, g, s.localPlayer, this.renderer.cam);
      this.handleEvents(events);
    }
    this.input.update(dt);
    const ctl = this.ctl;
    ctl.view.selection = ctl.selected();
    if (ctl.placing) {
      // keep validity fresh while the world changes
      ctl.view.placement = { def: ctl.placing, tx: ctl.placeTx, ty: ctl.placeTy, ...ctl.placementMask(ctl.placing, ctl.placeTx, ctl.placeTy) };
    }
    this.renderer.draw(g, alpha, ctl.view, dt);
    this.mmTimer -= dt;
    if (this.mmTimer <= 0) {
      this.mmTimer = 0.1;
      this.minimap.draw(g, ctl.view.team, s.localPlayer, this.renderer.cam, 0.1);
    }
    this.hud.update(dt);
    this.hud.setStatus(s.status || (s.paused && !s.online && s.localPlayer >= 0 ? 'Paused, press Pause to resume' : ''));
    if (g.over && !this.ended) {
      if (this.endTimer < 0) this.endTimer = 2.5;
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.ended = true;
        const me = g.players[s.localPlayer];
        const won = !!me && g.winners.includes(me.index);
        this.opts.onEnd({ won, draw: g.winners.length === 0, session: s });
      }
    }
  }

  private slowSeconds = 0;

  /** Automatically trade resolution/effects for frame rate on slow devices. */
  private adaptQuality(): void {
    if (document.hidden) return;
    this.slowSeconds = this.fps < 38 ? this.slowSeconds + 1 : Math.max(0, this.slowSeconds - 1);
    if (this.slowSeconds < 4) return;
    this.slowSeconds = 0;
    const r = this.renderer;
    if (!r.fx.lowFx) {
      r.fx.lowFx = true;
      if (r.terrain) r.terrain.budgetMs = 3;
      return;
    }
    if (r.maxDpr > 1) {
      r.maxDpr = Math.max(1, r.maxDpr - 0.25);
      this.resize();
    }
  }

  private handleEvents(events: GameEvent[]): void {
    const g = this.session.game;
    const me = this.session.localPlayer;
    const audio = this.opts.audio;
    for (const ev of events) {
      switch (ev.k) {
        case 'error':
          if (ev.owner === me) {
            this.hud.message(ev.msg, 'error');
            audio.ui('error');
          }
          break;
        case 'alert':
          if (ev.owner !== me) break;
          if (ev.kind === 'supply') {
            this.hud.message(supplyError(g, g.players[me]), 'error');
            audio.say('Not enough supply');
          } else {
            const txt = ev.kind === 'base' ? 'Your base is under attack' : 'Your forces are under attack';
            this.hud.message(txt, 'alert');
            audio.say(txt);
            audio.ui('alert');
            this.minimap.pings.push({ x: ev.x, y: ev.y, t: 2.5, color: '#ff4a3c' });
            this.ctl.lastAlert = { x: ev.x, y: ev.y };
          }
          break;
        case 'built':
          if (ev.owner === me) {
            const d = DEFS[ev.def];
            this.hud.message(`${d.name} complete`, 'info');
            audio.ui('complete');
            this.ctl.lastAlert = { x: ev.x, y: ev.y };
          }
          break;
        case 'researched':
          if (ev.owner === me) {
            const r = RESEARCH_DEFS[ev.id];
            const name = r.costs.length > 1 ? `${r.name} level ${ev.level}` : r.name;
            this.hud.message(`Research complete: ${name}`, 'info');
            audio.ui('research');
            audio.say('Research complete');
          }
          break;
        case 'revealed': {
          const p = g.players[ev.player];
          if (p.index === me) this.hud.message('You have no main base, your structures are revealed!', 'alert');
          else this.hud.message(`${p.name} has been revealed`, 'info');
          break;
        }
        case 'defeat': {
          const p = g.players[ev.player];
          this.hud.message(p.index === me ? 'You have been defeated' : `${p.name} has been ${p.left ? 'disconnected' : 'defeated'}`, p.index === me ? 'alert' : 'info');
          break;
        }
      }
    }
  }
}
