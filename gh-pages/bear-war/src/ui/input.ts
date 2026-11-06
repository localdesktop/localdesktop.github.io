// Pointer / keyboard / touch handling for the game view.
//
// Desktop: left-click select, drag box, right-click smart command, Shift queue,
//          Ctrl/double-click select type, wheel zoom, middle-drag/arrow/edge scroll.
// Touch:   tap own unit = select, tap ground/enemy/resource = command selection,
//          one-finger drag = pan, long-press + drag (or box mode) = box select,
//          two fingers = pinch zoom & pan, double-tap = select all of that type.

import { canBoard } from '../game/systems/cargo.ts';
import type { Entity } from '../game/entity.ts';
import type { Controller } from './controller.ts';
import type { Hud } from './hud.ts';
import type { Minimap } from '../render/minimap.ts';

/** Pointer capture can throw (e.g. for pointers the browser considers inactive); never let it break input. */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    // ignore
  }
}

interface TouchPt {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

export class Input {
  canvas: HTMLCanvasElement;
  ctl: Controller;
  hud: Hud;
  minimap: Minimap;
  touchMode = false;
  boxMode = false;
  edgeScroll = true;
  scrollSpeed = 1;
  onMenu: (() => void) | null = null;
  onPause: (() => void) | null = null;
  private keys = new Set<string>();
  private mouse = { x: -1, y: -1, inside: false };
  private leftDown: { x: number; y: number; t: number } | null = null;
  private dragging = false;
  private midDrag: { x: number; y: number } | null = null;
  private lastClick = { t: 0, x: 0, y: 0 };
  private touches = new Map<number, TouchPt>();
  private touchState: 'none' | 'tap' | 'pan' | 'box' | 'pinch' | 'place' = 'none';
  private longTimer = 0;
  private longFired = false;
  private pinch = { d: 0, mx: 0, my: 0, zoom: 1 };
  private lastTap = { t: 0, x: 0, y: 0 };
  private mmDown = false;
  private disposers: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, ctl: Controller, hud: Hud, minimap: Minimap) {
    this.canvas = canvas;
    this.ctl = ctl;
    this.hud = hud;
    this.minimap = minimap;
    this.touchMode = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(ev, fn as EventListener, opts));
    };
    on(canvas, 'pointerdown', (e) => this.down(e));
    on(window, 'pointermove', (e) => this.move(e));
    on(window, 'pointerup', (e) => this.up(e));
    on(window, 'pointercancel', (e) => this.up(e, true));
    on(canvas, 'wheel', (e) => this.wheel(e), { passive: false });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    // edge scrolling: track whether the mouse is inside the window at all
    on(window, 'mouseout', (e) => {
      if (!(e as MouseEvent).relatedTarget) this.mouse.inside = false;
    });
    on(window, 'keydown', (e) => this.keydown(e));
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    const mm = minimap.canvas;
    on(mm, 'pointerdown', (e) => this.mmDownH(e));
    on(mm, 'contextmenu', (e) => e.preventDefault());
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private world(sx: number, sy: number): { x: number; y: number } {
    const cam = this.ctl.r.cam;
    return { x: cam.toWorldX(sx), y: cam.toWorldY(sy) };
  }

  private pick(sx: number, sy: number, touch: boolean): Entity | undefined {
    const w = this.world(sx, sy);
    const slack = (touch ? 18 : 6) / this.ctl.r.cam.zoom;
    return this.ctl.pickVisible(w.x, w.y, slack);
  }

  // ------------------------------------------------------------------ pointer

  private down(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touchMode = true;
      this.touchDown(e);
      return;
    }
    capture(this.canvas, e.pointerId);
    const ctl = this.ctl;
    if (e.button === 1) {
      this.midDrag = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      if (ctl.placing || ctl.targeting) {
        ctl.cancelModes();
        ctl.bump();
        return;
      }
      const w = this.world(e.clientX, e.clientY);
      ctl.smart(w.x, w.y, this.pick(e.clientX, e.clientY, false), e.shiftKey);
      return;
    }
    if (e.button !== 0) return;
    if (ctl.placing) {
      const w = this.world(e.clientX, e.clientY);
      ctl.updatePlacement(w.x, w.y);
      ctl.confirmPlacement(e.shiftKey);
      return;
    }
    if (ctl.targeting) {
      const w = this.world(e.clientX, e.clientY);
      ctl.targetAt(w.x, w.y, this.pick(e.clientX, e.clientY, false), e.shiftKey);
      return;
    }
    this.leftDown = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.dragging = false;
  }

  private move(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touchMove(e);
      return;
    }
    if (this.mmDown) {
      this.mmMove(e);
      return;
    }
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.inside = true;
    const ctl = this.ctl;
    if (this.midDrag) {
      ctl.r.cam.pan(this.midDrag.x - e.clientX, this.midDrag.y - e.clientY);
      this.midDrag = { x: e.clientX, y: e.clientY };
      return;
    }
    const w = this.world(e.clientX, e.clientY);
    if (ctl.placing) ctl.updatePlacement(w.x, w.y);
    if (this.leftDown) {
      const dx = e.clientX - this.leftDown.x;
      const dy = e.clientY - this.leftDown.y;
      if (!this.dragging && dx * dx + dy * dy > 36) this.dragging = true;
      if (this.dragging) ctl.view.dragBox = { x0: this.leftDown.x, y0: this.leftDown.y, x1: e.clientX, y1: e.clientY };
    } else if (e.target === this.canvas) {
      ctl.view.hover = this.pick(e.clientX, e.clientY, false) ?? null;
    }
  }

  private up(e: PointerEvent, cancel = false): void {
    if (e.pointerType === 'touch') {
      this.touchUp(e, cancel);
      return;
    }
    if (this.mmDown) {
      this.mmDown = false;
      return;
    }
    if (e.button === 1) {
      this.midDrag = null;
      return;
    }
    const ctl = this.ctl;
    if (this.leftDown && e.button === 0 && !cancel) {
      if (this.dragging) {
        const a = this.world(this.leftDown.x, this.leftDown.y);
        const b = this.world(e.clientX, e.clientY);
        ctl.boxSelect(a.x, a.y, b.x, b.y, e.shiftKey);
      } else {
        const now = performance.now();
        const dbl = now - this.lastClick.t < 320 && Math.abs(e.clientX - this.lastClick.x) < 8 && Math.abs(e.clientY - this.lastClick.y) < 8;
        this.lastClick = { t: now, x: e.clientX, y: e.clientY };
        const w = this.world(e.clientX, e.clientY);
        ctl.clickSelect(w.x, w.y, e.shiftKey, dbl || e.ctrlKey || e.metaKey, 6 / ctl.r.cam.zoom);
      }
    }
    this.leftDown = null;
    this.dragging = false;
    ctl.view.dragBox = null;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const cam = this.ctl.r.cam;
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    cam.setZoom(cam.zoom * f, e.clientX, e.clientY);
  }

  // ------------------------------------------------------------------ touch

  private touchDown(e: PointerEvent): void {
    capture(this.canvas, e.pointerId);
    this.touches.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    window.clearTimeout(this.longTimer);
    if (this.touches.size === 2) {
      // switch to pinch
      this.ctl.view.dragBox = null;
      this.touchState = 'pinch';
      const [a, b] = [...this.touches.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, zoom: this.ctl.r.cam.zoom };
      return;
    }
    if (this.touches.size > 2) return;
    this.longFired = false;
    if (this.ctl.placing) {
      this.touchState = 'place';
      const w = this.world(e.clientX, e.clientY);
      this.ctl.updatePlacement(w.x, w.y);
      return;
    }
    this.touchState = this.boxMode ? 'box' : 'tap';
    this.longTimer = window.setTimeout(() => {
      if (this.touchState === 'tap') {
        this.longFired = true;
        this.touchState = 'box';
        navigator.vibrate?.(15);
      }
    }, 380);
  }

  private touchMove(e: PointerEvent): void {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const px = t.x;
    const py = t.y;
    t.x = e.clientX;
    t.y = e.clientY;
    const ctl = this.ctl;
    const cam = ctl.r.cam;
    if (this.touchState === 'pinch' && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      cam.pan(this.pinch.mx - mx, this.pinch.my - my);
      if (this.pinch.d > 10) cam.setZoom(this.pinch.zoom * (d / this.pinch.d), mx, my);
      this.pinch.mx = mx;
      this.pinch.my = my;
      return;
    }
    const moved = Math.hypot(t.x - t.sx, t.y - t.sy);
    if (this.touchState === 'tap' && moved > 12) {
      window.clearTimeout(this.longTimer);
      this.touchState = 'pan';
    }
    if (this.touchState === 'pan') {
      cam.pan(px - t.x, py - t.y);
    } else if (this.touchState === 'box') {
      if (moved > 8) ctl.view.dragBox = { x0: t.sx, y0: t.sy, x1: t.x, y1: t.y };
    } else if (this.touchState === 'place') {
      const w = this.world(t.x, t.y);
      ctl.updatePlacement(w.x, w.y);
    }
  }

  private touchUp(e: PointerEvent, cancel: boolean): void {
    const t = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    window.clearTimeout(this.longTimer);
    if (!t) return;
    const ctl = this.ctl;
    if (this.touchState === 'pinch') {
      if (this.touches.size === 0) this.touchState = 'none';
      else {
        // remaining finger continues as a pan
        this.touchState = 'pan';
        for (const r of this.touches.values()) {
          r.sx = r.x;
          r.sy = r.y;
        }
      }
      return;
    }
    if (cancel) {
      this.touchState = 'none';
      ctl.view.dragBox = null;
      return;
    }
    if (this.touchState === 'box') {
      if (ctl.view.dragBox) {
        const a = this.world(t.sx, t.sy);
        const b = this.world(t.x, t.y);
        ctl.boxSelect(a.x, a.y, b.x, b.y, false);
      } else if (this.longFired) {
        // long-press without dragging: select all of that type on screen
        const ent = this.pick(t.x, t.y, true);
        if (ent && ent.owner === ctl.player) ctl.select(ctl.onScreenOfType(ent.def.id));
      }
      ctl.view.dragBox = null;
      this.touchState = 'none';
      return;
    }
    if (this.touchState === 'tap') this.tap(t.x, t.y);
    this.touchState = 'none';
  }

  private tap(sx: number, sy: number): void {
    const ctl = this.ctl;
    const w = this.world(sx, sy);
    const ent = this.pick(sx, sy, true);
    if (ctl.targeting) {
      ctl.targetAt(w.x, w.y, ent, false);
      return;
    }
    const now = performance.now();
    const dbl = now - this.lastTap.t < 350 && Math.hypot(sx - this.lastTap.x, sy - this.lastTap.y) < 30;
    this.lastTap = { t: now, x: sx, y: sy };
    const own = ctl.ownSelected();
    // only units take tap-commands; buildings set their rally with the Rally button, so
    // tapping around with a building selected never moves the rally point by accident
    const hasCommandable = own.some((e) => e.isUnit && e.def.kind === 'unit');
    if (ent && ent.owner === ctl.player) {
      if (dbl && ctl.sel.has(ent.id)) ctl.select(ctl.onScreenOfType(ent.def.id));
      else if (own.length && own.some((e) => e.def.worker) && ((ent.def.refinery && ent.built) || (ent.isBuilding && !ent.built) || (ent.def.depot && own.some((x) => x.carry > 0)))) {
        // workers: tap own refinery / unfinished building / depot = work on it
        ctl.smart(w.x, w.y, ent, false);
      } else if (!ctl.sel.has(ent.id) && own.some((e) => canBoard(ctl.g, e, ent))) {
        // tap a transport or bunker with passengers selected: climb in
        ctl.smart(w.x, w.y, ent, false);
      } else ctl.select([ent]);
      return;
    }
    if (hasCommandable) {
      ctl.smart(w.x, w.y, ent, false);
      return;
    }
    if (ent) ctl.select([ent]);
    else {
      ctl.sel.clear();
      ctl.bump();
    }
  }

  // ------------------------------------------------------------------ minimap

  private mmDownH(e: PointerEvent): void {
    e.preventDefault();
    const ctl = this.ctl;
    const r = this.minimap.canvas.getBoundingClientRect();
    const w = this.minimap.toWorld(e.clientX - r.left, e.clientY - r.top);
    if (e.button === 2) {
      ctl.smart(w.x, w.y, undefined, e.shiftKey);
      return;
    }
    if (ctl.targeting) {
      ctl.targetAt(w.x, w.y, undefined, e.shiftKey);
      return;
    }
    this.mmDown = true;
    capture(this.minimap.canvas, e.pointerId);
    ctl.r.cam.centerOn(w.x, w.y);
    const move = (ev: PointerEvent) => {
      if (!this.mmDown) return;
      const p = this.minimap.toWorld(ev.clientX - r.left, ev.clientY - r.top);
      ctl.r.cam.centerOn(p.x, p.y);
    };
    const upH = () => {
      this.mmDown = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', upH);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', upH);
  }

  private mmMove(_e: PointerEvent): void {}

  // ------------------------------------------------------------------ keyboard

  private keydown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const ctl = this.ctl;
    this.keys.add(e.code);
    const k = e.key;
    if (k === 'Escape') {
      ctl.escape();
      e.preventDefault();
      return;
    }
    if (k === 'Enter') {
      this.hud.openChat();
      e.preventDefault();
      return;
    }
    if (/^Digit[0-9]$/.test(e.code)) {
      const i = Number(e.code.slice(5));
      if (e.ctrlKey || e.metaKey) ctl.groupSet(i);
      else if (e.shiftKey) ctl.groupAdd(i);
      else {
        const now = performance.now();
        const again = (this as unknown as { _lg?: { i: number; t: number } })._lg;
        if (ctl.groupSelect(i) && again && again.i === i && now - again.t < 350) ctl.centerOnSelection();
        (this as unknown as { _lg?: { i: number; t: number } })._lg = { i, t: now };
      }
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'F10':
        this.onMenu?.();
        e.preventDefault();
        return;
      case 'Pause':
        this.onPause?.();
        e.preventDefault();
        return;
      case 'F1':
        ctl.selectIdleWorker(e.ctrlKey);
        e.preventDefault();
        return;
      case 'F2':
        ctl.selectArmy();
        e.preventDefault();
        return;
      case 'Space':
        ctl.jumpToAlert();
        e.preventDefault();
        return;
      case 'Backspace':
        ctl.cycleBase();
        e.preventDefault();
        return;
      case 'Tab':
        ctl.sel.cycle(ctl.g);
        ctl.bump();
        e.preventDefault();
        return;
      case 'Equal':
      case 'NumpadAdd':
        ctl.r.cam.setZoom(ctl.r.cam.zoom * 1.15);
        return;
      case 'Minus':
      case 'NumpadSubtract':
        ctl.r.cam.setZoom(ctl.r.cam.zoom / 1.15);
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Match the key's position, not the character it prints, so the grid
    // stays in the same place on every keyboard layout.
    if (this.hud.pressHotkey(e.code)) e.preventDefault();
  }

  /** Per-frame camera movement (arrow keys, edge scrolling). */
  update(dt: number): void {
    const cam = this.ctl.r.cam;
    const speed = 900 * this.scrollSpeed * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= speed;
    if (this.keys.has('ArrowRight')) dx += speed;
    if (this.keys.has('ArrowUp')) dy -= speed;
    if (this.keys.has('ArrowDown')) dy += speed;
    if (this.edgeScroll && !this.touchMode && this.mouse.inside && this.mouse.x >= 0 && document.hasFocus()) {
      const m = 6;
      if (this.mouse.x <= m) dx -= speed;
      if (this.mouse.x >= window.innerWidth - m) dx += speed;
      if (this.mouse.y <= m) dy -= speed;
      if (this.mouse.y >= window.innerHeight - m) dy += speed;
    }
    if (dx || dy) cam.pan(dx, dy);
    this.canvas.classList.toggle('targeting', !!this.ctl.targeting || !!this.ctl.placing);
  }

  get shift(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }
}
