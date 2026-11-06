import { canCarry, cargoUsed } from '../game/systems/cargo.ts';
import { DEFS, RESEARCH_DEFS } from '../game/data/index.ts';
import { TEAM_COLORS } from '../game/constants.ts';
import type { EntityDef } from '../game/data/types.ts';
import type { Entity } from '../game/entity.ts';
import type { Game } from '../game/game.ts';
import { armorOf, maxHp, maxShields, weaponDamage, weaponRangePx } from '../game/stats.ts';
import { TILE } from '../game/constants.ts';
import type { SpriteCache } from '../render/sprites.ts';
import { GRID_CODES, buildCard, layout, watchGridLabels, type CmdButton } from './commandcard.ts';
import type { Controller } from './controller.ts';
import { iconSvg } from './icons.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export interface HudCallbacks {
  onMenu(): void;
  /** spectator/replay speed control; undefined when not available */
  setSpeed?(speed: number): void;
  togglePause?(): boolean;
  /** online chat; undefined in offline games */
  chat?(text: string): void;
  boxMode(): boolean;
  setBoxMode(on: boolean): void;
  touch(): boolean;
}

export class Hud {
  root: HTMLElement;
  g: Game;
  ctl: Controller;
  sprites: SpriteCache;
  cb: HudCallbacks;
  minimapCanvas: HTMLCanvasElement;
  buttons: (CmdButton | null)[] = [];
  private elMin: HTMLElement;
  private elGas: HTMLElement;
  private elSup: HTMLElement;
  private elSupWrap: HTMLElement;
  private elTime: HTMLElement;
  private elSel: HTMLElement;
  private elCard: HTMLElement;
  private elMsgs: HTMLElement;
  private elStatus: HTMLElement;
  private elTip: HTMLElement;
  private elPlace: HTMLElement;
  private elHint: HTMLElement;
  private elGroups: HTMLElement;
  private cardBtns: HTMLButtonElement[] = [];
  /** current innerHTML of each command button */
  private cardInner: string[] = [];
  private iconUrls = new Map<string, string>();
  private lastSelVer = -1;
  private lastCtlVer = -1;
  private cardTimer = 0;
  private selTimer = 0;
  private lastCardKey = '';
  private selKey = '';
  private tipFor: CmdButton | null = null;
  private groupBtns: HTMLButtonElement[] = [];
  private idleBtn: HTMLButtonElement | null = null;
  private chatBox: HTMLInputElement | null = null;
  private stopGridLabels: (() => void) | null = null;

  constructor(parent: HTMLElement, g: Game, ctl: Controller, sprites: SpriteCache, cb: HudCallbacks) {
    this.g = g;
    this.ctl = ctl;
    this.sprites = sprites;
    this.cb = cb;
    const root = (this.root = el('div', 'hud', parent));
    // keep keyboard focus off HUD buttons so hotkeys (and Space) always reach the game
    root.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });

    const mm = el('div', 'hud-minimap panel', root);
    this.minimapCanvas = el('canvas', '', mm);

    const menu = el('button', 'hud-menu panel', root);
    menu.innerHTML = iconSvg('menu', 20);
    menu.title = 'Menu (F10)';
    menu.addEventListener('click', () => cb.onMenu());

    const top = el('div', 'hud-top panel', root);
    const res = (cls: string) => {
      const w = el('div', 'res', top);
      el('span', 'ico ' + cls, w);
      return { wrap: w, val: el('b', '', w) };
    };
    this.elMin = res('min').val;
    this.elGas = res('gas').val;
    const sup = res('sup');
    this.elSup = sup.val;
    this.elSupWrap = sup.wrap;
    this.elTime = el('div', 'clock', top);

    if (ctl.player < 0) {
      top.style.display = 'none';
      this.buildSpectatorBar(root);
    }
    this.elMsgs = el('div', 'hud-msgs', root);
    this.elStatus = el('div', 'hud-status panel', root);
    this.elTip = el('div', 'hud-tip panel', root);
    this.elHint = el('div', 'hud-hint panel', root);

    this.elPlace = el('div', 'hud-place', root);
    const ok = el('button', 'ok', this.elPlace);
    ok.textContent = '✓ Build';
    ok.addEventListener('click', () => {
      if (this.ctl.confirmPlacement(false)) this.refreshCard(true);
    });
    const no = el('button', 'no', this.elPlace);
    no.textContent = '✕ Cancel';
    no.addEventListener('click', () => {
      this.ctl.cancelModes();
      this.ctl.bump();
    });

    const bottom = el('div', 'hud-bottom', root);
    const left = el('div', 'hud-left', bottom);
    this.elGroups = el('div', 'hud-groups', left);
    this.buildGroups();
    this.elSel = el('div', 'hud-sel panel empty', left);
    this.elCard = el('div', 'hud-card panel', bottom);
    for (let i = 0; i < 12; i++) {
      const b = el('button', 'cbtn empty', this.elCard);
      b.dataset.i = String(i);
      this.attachButton(b, i);
      this.cardBtns.push(b);
    }
    this.stopGridLabels = watchGridLabels(() => this.refreshCard(true));
  }

  // ------------------------------------------------------------------ spectator

  private specRows: HTMLElement[] = [];
  private speedSel?: HTMLSelectElement;
  private autoBtn?: HTMLElement;
  private calm = 0;

  private buildSpectatorBar(root: HTMLElement): void {
    const bar = el('div', 'hud-spec panel', root);
    const ctrl = el('div', 'spec-ctrl', bar);
    if (this.cb.togglePause) {
      const pb = el('button', 'qbtn', ctrl);
      pb.textContent = '⏸';
      pb.addEventListener('click', () => (pb.textContent = this.cb.togglePause!() ? '▶' : '⏸'));
    }
    if (this.cb.setSpeed) {
      const sel = (this.speedSel = el('select', 'spec-speed', ctrl) as HTMLSelectElement);
      for (const sp of [0.5, 1, 2, 4, 8, 16, 32]) sel.add(new Option(`${sp}×`, String(sp), sp === 1, sp === 1));
      sel.addEventListener('change', () => {
        this.autoBtn!.classList.remove('on');
        this.cb.setSpeed!(Number(sel.value));
      });
      const auto = (this.autoBtn = el('button', 'qbtn spec-auto', ctrl));
      auto.textContent = 'Auto';
      auto.title = 'Fast-forward quiet moments, slow down for fights';
      auto.addEventListener('click', () => auto.classList.toggle('on'));
    }
    for (const p of this.g.players) {
      const row = el('button', 'spec-row', bar);
      row.title = 'See this team\'s vision (click again to see everything)';
      row.innerHTML = `<span class="swatch" style="background:${TEAM_COLORS[p.color].main}"></span><b></b><span class="m"></span><span class="gs"></span><span class="sp"></span>`;
      (row.querySelector('b') as HTMLElement).textContent = p.name;
      row.addEventListener('click', () => {
        const team = this.ctl.view.team === p.team ? -1 : p.team;
        this.ctl.view.team = team;
        this.specRows.forEach((r, i) => r.classList.toggle('on', this.g.players[i].team === team));
      });
      this.specRows.push(row);
    }
  }

  private updateSpectator(dt: number): void {
    const sel = this.speedSel;
    if (sel && this.autoBtn!.classList.contains('on')) {
      const fighting = this.g.entities.filter((e) => e.alive && e.cds.some((c) => c > 0)).length;
      const want = fighting > 12 ? 0.5 : fighting ? 1 : this.g.entities.some((e) => e.alive && e.wantMove && e.def.weapons && !e.def.worker) ? 4 : 32;
      const cur = Number(sel.value);
      // slow down at once, speed up only after 3 calm seconds so volleys don't flicker the speed
      if (want <= cur) this.calm = 3;
      if (want < cur || (want > cur && (this.calm -= dt) <= 0)) {
        sel.value = String(want);
        this.cb.setSpeed!(want);
      }
    }
    this.g.players.forEach((p, i) => {
      const row = this.specRows[i];
      if (!row) return;
      row.classList.toggle('dead', p.defeated);
      setText(row.querySelector('.m') as HTMLElement, `◆ ${Math.floor(p.minerals)}`);
      setText(row.querySelector('.gs') as HTMLElement, `● ${Math.floor(p.gas)}`);
      setText(row.querySelector('.sp') as HTMLElement, `⌂ ${Math.ceil(p.supplyUsed)}/${p.supplyMax}`);
    });
  }

  // ------------------------------------------------------------------ quick buttons

  private buildGroups(): void {
    const box = el('button', 'qbtn', this.elGroups);
    box.innerHTML = iconSvg('select', 18);
    box.title = 'Box select mode (touch)';
    box.addEventListener('click', () => {
      this.cb.setBoxMode(!this.cb.boxMode());
      box.classList.toggle('on', this.cb.boxMode());
    });
    if (!this.cb.touch()) box.style.display = 'none';
    const army = el('button', 'qbtn', this.elGroups);
    army.innerHTML = iconSvg('army', 18);
    army.title = 'Select army (F2)';
    army.addEventListener('click', () => this.ctl.selectArmy());
    const idle = el('button', 'qbtn', this.elGroups);
    this.idleBtn = idle;
    idle.innerHTML = iconSvg('worker', 18) + '<span class="n"></span>';
    idle.title = 'Idle worker (F1). Long-press: all idle workers';
    this.longPress(idle, () => this.ctl.selectIdleWorker(false), () => this.ctl.selectIdleWorker(true));
    if (this.cb.chat) {
      const cbtn = el('button', 'qbtn', this.elGroups);
      cbtn.textContent = '💬';
      cbtn.title = 'Chat (Enter)';
      cbtn.addEventListener('click', () => this.openChat());
    }
    for (let i = 1; i <= 5; i++) {
      const b = el('button', 'qbtn empty', this.elGroups);
      b.innerHTML = `${i}<span class="n"></span>`;
      b.title = `Control group ${i}: tap to select (double-tap to jump), long-press to assign. Keys: ${i} / Ctrl+${i}`;
      let lastTap = 0;
      this.longPress(
        b,
        () => {
          const now = performance.now();
          if (this.ctl.groupSelect(i) && now - lastTap < 350) this.ctl.centerOnSelection();
          lastTap = now;
        },
        () => {
          this.ctl.groupSet(i);
          navigator.vibrate?.(20);
        },
      );
      this.groupBtns.push(b);
    }
  }

  private longPress(b: HTMLElement, tap: () => void, hold: () => void): void {
    let timer = 0;
    let held = false;
    b.addEventListener('pointerdown', () => {
      held = false;
      timer = window.setTimeout(() => {
        held = true;
        hold();
      }, 450);
    });
    const end = () => window.clearTimeout(timer);
    b.addEventListener('pointerup', end);
    b.addEventListener('pointerleave', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (!held) tap();
    });
    b.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  // ------------------------------------------------------------------ chat

  openChat(): void {
    if (!this.cb.chat || this.chatBox) return;
    const input = el('input', 'hud-chat panel', this.root);
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Message all players, Enter to send, Esc to cancel';
    this.chatBox = input;
    const close = () => {
      input.remove();
      this.chatBox = null;
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (input.value.trim()) this.cb.chat!(input.value);
        close();
      } else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => window.setTimeout(close, 150));
    window.setTimeout(() => input.focus(), 0);
  }

  get chatOpen(): boolean {
    return !!this.chatBox;
  }

  // ------------------------------------------------------------------ command card

  private attachButton(b: HTMLButtonElement, i: number): void {
    let timer = 0;
    let held = false;
    b.addEventListener('pointerdown', (ev) => {
      held = false;
      if (ev.pointerType !== 'mouse') {
        timer = window.setTimeout(() => {
          held = true;
          const cb = this.buttons[i];
          if (cb) this.showTip(cb, b);
        }, 420);
      }
    });
    const clear = () => {
      window.clearTimeout(timer);
      if (held) this.hideTip();
    };
    b.addEventListener('pointerup', clear);
    b.addEventListener('pointercancel', clear);
    b.addEventListener('pointerenter', (ev) => {
      if (ev.pointerType === 'mouse') {
        const cb = this.buttons[i];
        if (cb) this.showTip(cb, b);
      }
    });
    b.addEventListener('pointerleave', () => {
      window.clearTimeout(timer);
      this.hideTip();
    });
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (held) return;
      this.press(i);
    });
    b.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  press(i: number): void {
    const cb = this.buttons[i];
    if (!cb || this.ctl.player < 0) return;
    if (!cb.enabled) {
      if (cb.why) this.message(cb.why, 'error');
      this.ctl.fb.ack('error');
      return;
    }
    this.ctl.doAction(cb.action);
    this.refreshCard(true);
  }

  /** Press the command-card button for a physical key (`KeyboardEvent.code`). */
  pressHotkey(code: string): boolean {
    const i = GRID_CODES.indexOf(code);
    if (i < 0 || !this.buttons[i]) return false;
    this.press(i);
    return true;
  }

  private iconUrl(def: EntityDef, color: number, px: number): string {
    const key = `${def.id}|${color}|${px}`;
    let u = this.iconUrls.get(key);
    if (!u) {
      u = this.sprites.icon(def, color, px).toDataURL();
      this.iconUrls.set(key, u);
    }
    return u;
  }

  private myColor(): number {
    return this.g.players[this.ctl.player]?.color ?? 0;
  }

  refreshCard(force = false): void {
    const ctl = this.ctl;
    const g = this.g;
    const all = ctl.selected();
    const active = ctl.sel.activeEntities(g);
    const owner = ctl.player < 0 ? (active[0]?.owner ?? -1) : ctl.player;
    const btns = buildCard(g, owner, all, active, ctl.page);
    this.buttons = layout(btns);
    // on small screens an empty command card is just wasted space
    this.elCard.classList.toggle('none', btns.length === 0);
    const p = g.players[owner];
    const key = this.buttons.map((b) => (b ? `${b.key}|${b.enabled}|${b.label}|${b.hotkey ?? ''}|${b.badge ?? ''}` : '-')).join(',') + ctl.page + JSON.stringify(ctl.targeting);
    const keyFull = key + (p ? `|${Math.floor(p.minerals / 25)}|${Math.floor(p.gas / 25)}` : '');
    if (!force && keyFull === this.lastCardKey) return;
    this.lastCardKey = keyFull;
    const armedKey = ctl.targeting ? (ctl.targeting.t === 'ability' ? 'ab:' + ctl.targeting.ab : ctl.targeting.t === 'amove' ? 'attack' : ctl.targeting.t) : ctl.placing ? 'build:' + ctl.placing.id : '';
    // Only touch the DOM where something changed: replacing a button's contents between
    // pointerdown and pointerup makes the browser drop the click.
    this.buttons.forEach((b, i) => {
      const elb = this.cardBtns[i];
      if (!b) {
        if (elb.className !== 'cbtn empty') elb.className = 'cbtn empty';
        if (this.cardInner[i]) {
          this.cardInner[i] = '';
          elb.innerHTML = '';
        }
        return;
      }
      const poor = !!(b.cost && p && (p.minerals < b.cost.m || p.gas < b.cost.g));
      const cls = 'cbtn' + (b.enabled ? '' : ' disabled') + (poor ? ' poor' : '') + (b.key === armedKey ? ' armed' : '');
      if (elb.className !== cls) elb.className = cls;
      let inner = '';
      if (b.def) inner = `<img src="${this.iconUrl(b.def, this.myColor(), 64)}" alt="">`;
      else inner = iconSvg(b.svg ?? 'move', 26);
      if (b.hotkey && !this.cb.touch()) inner += `<span class="hk">${b.hotkey}</span>`;
      if (b.badge) inner += `<span class="badge">${b.badge}</span>`;
      if (this.cardInner[i] !== inner) {
        this.cardInner[i] = inner;
        elb.innerHTML = inner;
        elb.setAttribute('aria-label', b.label);
      }
    });
  }

  // ------------------------------------------------------------------ tooltip

  private showTip(b: CmdButton, anchor: HTMLElement): void {
    this.tipFor = b;
    const p = this.g.players[this.ctl.player];
    let html = `<b>${b.label}</b>`;
    if (b.hotkey && !this.cb.touch()) html += ` <span class="muted">(${b.hotkey})</span>`;
    if (b.cost || b.energy || b.supply) {
      html += '<div class="cost">';
      if (b.cost) {
        html += `<span style="color:${p && p.minerals < b.cost.m ? 'var(--bad)' : ''}"><i class="ico min"></i>${b.cost.m}</span>`;
        if (b.cost.g) html += `<span style="color:${p && p.gas < b.cost.g ? 'var(--bad)' : ''}"><i class="ico gas"></i>${b.cost.g}</span>`;
      }
      if (b.supply) html += `<span><i class="ico sup"></i>${b.supply}</span>`;
      if (b.energy) html += `<span style="color:#c9a0ff">⚡${b.energy}</span>`;
      if (b.time) html += `<span class="muted">⏱${b.time}s</span>`;
      html += '</div>';
    }
    if (!b.enabled && b.why) html += `<div class="why">${b.why}</div>`;
    html += `<p>${b.desc}</p>`;
    this.elTip.innerHTML = html;
    this.elTip.classList.add('show');
    const r = anchor.getBoundingClientRect();
    const tr = this.elTip.getBoundingClientRect();
    let x = r.left + r.width / 2 - tr.width / 2;
    x = Math.max(6, Math.min(window.innerWidth - tr.width - 6, x));
    let y = r.top - tr.height - 8;
    if (y < 6) y = r.bottom + 8;
    this.elTip.style.left = x + 'px';
    this.elTip.style.top = y + 'px';
  }

  hideTip(): void {
    this.tipFor = null;
    this.elTip.classList.remove('show');
  }

  // ------------------------------------------------------------------ messages & status

  message(text: string, kind: 'error' | 'info' | 'alert' = 'info'): void {
    const m = el('div', 'msg ' + kind, this.elMsgs);
    m.textContent = text;
    while (this.elMsgs.children.length > 3) this.elMsgs.firstChild!.remove();
    window.setTimeout(() => m.remove(), 3000);
  }

  setStatus(text: string): void {
    this.elStatus.textContent = text;
    this.elStatus.classList.toggle('show', !!text);
  }

  // ------------------------------------------------------------------ per-frame update

  update(dt: number): void {
    const g = this.g;
    const ctl = this.ctl;
    const p = g.players[ctl.player];
    if (p) {
      setText(this.elMin, String(Math.floor(p.minerals)));
      setText(this.elGas, String(Math.floor(p.gas)));
      setText(this.elSup, `${fmtSupply(p.supplyUsed)}/${p.supplyMax}`);
      this.elSupWrap.classList.toggle('blocked', p.supplyUsed >= p.supplyMax && p.supplyMax < 200);
    }
    setText(this.elTime, fmtTime(g.time));
    if (ctl.player < 0) this.updateSpectator(dt);
    // placement controls (touch)
    const placing = !!ctl.placing && this.cb.touch();
    this.elPlace.classList.toggle('show', placing);
    let hint = '';
    if (ctl.targeting) {
      const t = ctl.targeting;
      hint = t.t === 'ability' ? 'Choose a target' : t.t === 'amove' ? 'Attack: tap a target or location' : t.t === 'rally' ? 'Set rally point' : t.t === 'gather' ? 'Tap minerals or a refinery' : t.t === 'repair' ? 'Tap something to repair' : t.t === 'load' ? 'Tap a unit to pick up' : t.t === 'unload' ? 'Tap where to unload' : 'Tap a destination';
    } else if (ctl.placing) hint = this.cb.touch() ? 'Drag to position, then ✓ Build' : 'Click to place (Shift: keep placing)';
    else if (this.cb.boxMode()) hint = 'Drag to select units';
    setText(this.elHint, hint);
    this.elHint.classList.toggle('show', !!hint && !placing);

    this.cardTimer -= dt;
    if (ctl.version !== this.lastCtlVer || this.cardTimer <= 0) {
      this.lastCtlVer = ctl.version;
      this.cardTimer = 0.25;
      this.refreshCard();
    }
    this.selTimer -= dt;
    if (ctl.sel.version !== this.lastSelVer || this.selTimer <= 0) {
      this.lastSelVer = ctl.sel.version;
      this.selTimer = 0.2;
      this.refreshSelection();
    }
    // idle workers
    if (this.idleBtn) {
      let idle = 0;
      for (const e of g.entities) if (e.alive && e.owner === ctl.player && e.def.worker && e.orders.length === 0 && !e.inside) idle++;
      setText(this.idleBtn.querySelector('.n') as HTMLElement, idle ? String(idle) : '');
      this.idleBtn.classList.toggle('alert', idle > 0);
    }
    // control group counts
    this.groupBtns.forEach((b, i) => {
      const n = ctl.sel.groups[i + 1].filter((id) => g.get(id)).length;
      b.classList.toggle('empty', n === 0);
      const s = b.querySelector('.n')!;
      setText(s as HTMLElement, n ? String(n) : '');
    });
    if (this.tipFor && !this.cb.touch()) {
      // keep tooltip text fresh (affordability), cheap enough
    }
  }

  private refreshSelection(): void {
    const g = this.g;
    const ctl = this.ctl;
    const es = ctl.selected();
    const box = this.elSel;
    if (!es.length) {
      box.classList.add('empty');
      box.innerHTML = '';
      this.selKey = '';
      return;
    }
    box.classList.remove('empty');
    if (es.length === 1) {
      this.renderSingle(es[0]);
      return;
    }
    // multi: grid of icons
    const key = 'multi:' + es.map((e) => e.id).join(',') + '|' + ctl.sel.active;
    if (key !== this.selKey) {
      this.selKey = key;
      box.innerHTML = '';
      const grid = el('div', 'sel-grid', box);
      for (const e of es.slice(0, 48)) {
        const c = el('div', 'cell' + (e.def.id === ctl.sel.active ? ' active' : ''), grid);
        c.dataset.id = String(e.id);
        const img = el('img', '', c);
        img.src = this.iconUrl(e.def, g.players[e.owner]?.color ?? -1, 48);
        el('div', 'hp', c);
        c.addEventListener('click', (ev) => {
          const ent = g.get(e.id);
          if (!ent) return;
          if (ev.shiftKey) {
            ctl.sel.remove(g, [ent]);
            ctl.bump();
          } else if (ev.ctrlKey || ev.metaKey) {
            ctl.select(ctl.selected().filter((x) => x.def.id === ent.def.id));
          } else if (ctl.sel.active !== ent.def.id) {
            ctl.sel.active = ent.def.id;
            ctl.sel.version++;
            ctl.bump();
          } else ctl.select([ent]);
        });
      }
      if (es.length > 48) {
        const more = el('div', 'muted small', grid);
        more.textContent = `+${es.length - 48}`;
      }
    }
    const cells = box.querySelectorAll<HTMLElement>('.cell');
    cells.forEach((c) => {
      const e = g.get(Number(c.dataset.id));
      const hp = c.querySelector<HTMLElement>('.hp')!;
      if (!e) {
        c.style.opacity = '0.3';
        return;
      }
      const f = e.hp / maxHp(e, g.players[e.owner]);
      hp.style.width = `calc(${Math.max(0, f) * 100}% - 4px)`;
      hp.style.background = f > 0.6 ? 'var(--good)' : f > 0.3 ? 'var(--warn)' : 'var(--bad)';
    });
  }

  private renderSingle(e: Entity): void {
    const g = this.g;
    const ctl = this.ctl;
    const box = this.elSel;
    const key = 'single:' + e.id + '|' + e.def.id + '|' + e.queue.map((q) => q.id).join(',') + '|' + e.built + '|' + (e.morphTo ?? '') + '|' + e.cargo.join(',');
    const p = g.players[e.owner];
    if (key !== this.selKey) {
      this.selKey = key;
      box.innerHTML = '';
      const por = el('div', 'sel-portrait', box);
      const img = el('img', '', por);
      img.src = this.iconUrl(e.def, p?.color ?? -1, 96);
      const info = el('div', 'sel-info', box);
      const name = el('div', 'sel-name', info);
      name.innerHTML = `${e.def.name}${p ? `<small>${escapeHtml(p.name)}</small>` : ''}`;
      const bars = el('div', 'bars', info);
      if (!e.isResource) {
        if (e.def.shields) el('div', 'bar sh', bars).innerHTML = '<i></i><span></span>';
        el('div', 'bar hp', bars).innerHTML = '<i></i><span></span>';
        if (e.def.energy) el('div', 'bar en', bars).innerHTML = '<i></i><span></span>';
        if ((e.isBuilding && !e.built) || e.morphTo) el('div', 'bar pr', bars).innerHTML = '<i></i><span></span>';
      }
      el('div', 'sel-stats', info);
      if (e.def.cargo && e.owner === ctl.player && e.cargo.length) {
        // passengers: click one to let it out
        const row = el('div', 'cargo', info);
        for (const id of e.cargo) {
          const u = g.get(id);
          if (!u) continue;
          const s = el('div', 'qslot', row);
          s.title = `${u.def.name}: click to unload`;
          el('img', '', s).src = this.iconUrl(u.def, p?.color ?? 0, 48);
          s.addEventListener('click', () => ctl.issue({ c: 'unload', ids: [e.id], u: id }));
        }
      }
      if (e.isBuilding && e.owner === ctl.player && (e.def.produces || e.def.researches || e.def.morphs) && e.built) {
        const q = el('div', 'queue', info);
        for (let i = 0; i < 5; i++) {
          const s = el('div', 'qslot', q);
          s.dataset.slot = String(i);
          s.title = 'Click to cancel';
          s.addEventListener('click', () => {
            const ent = g.get(e.id);
            if (ent && ent.queue[i]) ctl.issue({ c: 'cancel', id: ent.id, slot: i });
          });
        }
      }
    }
    // dynamic parts
    const mh = maxHp(e, p);
    const set = (sel: string, frac: number, text: string) => {
      const b = box.querySelector<HTMLElement>(sel);
      if (!b) return;
      (b.firstChild as HTMLElement).style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      setText(b.lastChild as HTMLElement, text);
    };
    if (!e.isResource) {
      set('.bar.hp', e.hp / mh, `${Math.ceil(e.hp)} / ${mh}`);
      if (e.def.shields) set('.bar.sh', e.shields / maxShields(e), `${Math.ceil(e.shields)} / ${maxShields(e)}`);
      if (e.def.energy) set('.bar.en', e.energy / e.def.energy, `${Math.floor(e.energy)} / ${e.def.energy}`);
      if (e.isBuilding && !e.built) set('.bar.pr', e.progress, `Building ${Math.floor(e.progress * 100)}%`);
      else if (e.morphTo) set('.bar.pr', e.morphT / Math.max(1, e.morphTotal), `${DEFS[e.morphTo].name} ${Math.floor((e.morphT / Math.max(1, e.morphTotal)) * 100)}%`);
    }
    const stats = box.querySelector<HTMLElement>('.sel-stats');
    if (stats) {
      const parts: string[] = [];
      if (e.isResource) parts.push(`Remaining: ${e.def.kind === 'geyser' ? e.amount : e.amount}`);
      else {
        parts.push(`Armor ${armorOf(e, p)}`);
        for (const w of e.def.weapons ?? []) {
          const dmg = weaponDamage(p, w, e) - (w.bonus ? 0 : 0);
          parts.push(`${w.name}: ${w.dmg + (p && w.upg ? p.level(w.upg) * (w.upgDmg ?? 1) : 0)}${w.hits && w.hits > 1 ? '×' + w.hits : ''} dmg, range ${(weaponRangePx(e, w, p) / TILE).toFixed(0)}`);
          void dmg;
        }
        if (e.kills) parts.push(`Kills ${e.kills}`);
        if (e.def.spawnsCubs) parts.push(`Cubs ${e.cubs.length}`);
        if (e.def.refinery) {
          const gey = g.get(e.link);
          parts.push(`Gas left: ${gey ? Math.floor(gey.amount) : 0}`);
        }
        if (e.carry) parts.push(`Carrying ${e.carry} ${e.carryKind === 1 ? 'minerals' : 'gas'}`);
        if (e.def.cargo && e.owner === ctl.player && canCarry(g, e)) parts.push(`Cargo ${cargoUsed(g, e)}/${e.def.cargo}`);
        if (e.hasteT > 0) parts.push('⏩ Moonlight Haste');
        if (e.isBuilding && e.def.needsPower && !e.powered) parts.push('⚡ UNPOWERED');
      }
      setText(stats, parts.join(' · '));
    }
    const slots = box.querySelectorAll<HTMLElement>('.queue .qslot');
    slots.forEach((s, i) => {
      const it = e.queue[i];
      const want = it ? it.kind + it.id + it.level : '';
      if (s.dataset.want !== want) {
        s.dataset.want = want;
        if (!it) s.innerHTML = '';
        else if (it.kind === 'research') s.innerHTML = iconSvg(RESEARCH_DEFS[it.id]?.icon ?? 'up_weapon', 22) + '<div class="prog"></div>';
        else s.innerHTML = `<img src="${this.iconUrl(DEFS[it.id], p?.color ?? 0, 48)}" alt=""><div class="prog"></div>`;
      }
      const prog = s.querySelector<HTMLElement>('.prog');
      if (prog && it) prog.style.width = `${(it.progress / it.total) * 100}%`;
    });
  }

  dispose(): void {
    this.stopGridLabels?.();
    this.root.remove();
  }
}

function setText(e: HTMLElement, t: string): void {
  if (e.textContent !== t) e.textContent = t;
}

function fmtSupply(v: number): string {
  return String(Math.ceil(v));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
