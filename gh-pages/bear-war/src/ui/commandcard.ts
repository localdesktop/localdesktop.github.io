import { ABILITY_DEFS, DEFS, RESEARCH_DEFS, buildablesFor, switchingMode } from '../game/data/index.ts';
import type { Cost, EntityDef } from '../game/data/types.ts';
import type { Entity } from '../game/entity.ts';
import type { Game } from '../game/game.ts';
import type { Command } from '../game/types.ts';
import { canCarry } from '../game/systems/cargo.ts';

export type TargetMode =
  | { t: 'move' }
  | { t: 'amove' }
  | { t: 'patrol' }
  | { t: 'gather' }
  | { t: 'repair' }
  | { t: 'rally' }
  | { t: 'load' }
  | { t: 'unload' }
  | { t: 'ability'; ab: string };

export type Action =
  | { kind: 'target'; mode: TargetMode }
  | { kind: 'cmd'; cmd: Command }
  | { kind: 'page'; page: Page }
  | { kind: 'place'; def: string };

export type Page = 'main' | 'build1' | 'build2';

export interface CmdButton {
  key: string;
  /** Filled in by layout() from the button's grid slot. */
  hotkey?: string;
  label: string;
  svg?: string;
  def?: EntityDef;
  enabled: boolean;
  why?: string;
  cost?: Cost;
  supply?: number;
  time?: number;
  energy?: number;
  desc: string;
  action: Action;
  badge?: string;
  /** grid slot 0..11 (row-major, 4 columns); undefined = next free */
  slot?: number;
}

const ids = (es: Entity[]) => es.map((e) => e.id);

export function buildCard(g: Game, player: number, all: Entity[], active: Entity[], page: Page): CmdButton[] {
  const p = g.players[player];
  const own = all.filter((e) => e.owner === player);
  const act = active.filter((e) => e.owner === player);
  if (!act.length || !p) return [];
  const lead = act[0];
  const d = lead.def;
  const out: CmdButton[] = [];
  const allIds = ids(own);
  const actIds = ids(act);

  // cocoons, growing units, construction: cancel only
  if (d.kind === 'cocoon' || (lead.isUnit && lead.morphTo && !switchingMode(lead.morphTo, d))) {
    out.push(cancelBtn({ c: 'cancel', id: lead.id, slot: -1 }, 11));
    return out;
  }
  if (lead.isBuilding && !lead.built) {
    out.push(cancelBtn({ c: 'cancel', id: lead.id, slot: -1 }, 11));
    return out;
  }
  if (d.kind === 'cub') {
    const hive = g.get(lead.hive);
    if (hive) return buildCard(g, player, [hive], [hive], page);
    return [];
  }

  // ---------------- build menus
  if (page === 'build1' || page === 'build2') {
    const list = buildablesFor(p.race, page === 'build1' ? 1 : 2);
    list.forEach((b, i) => {
      const missing = g.missingTech(p, b.requires);
      out.push({
        key: 'build:' + b.id, label: b.name, def: b, enabled: !missing,
        why: missing ? `Requires ${missing}` : undefined, cost: b.cost, time: b.time, desc: b.desc,
        action: { kind: 'place', def: b.id }, slot: i,
      });
    });
    out.push({ key: 'back', label: 'Back', svg: 'back', enabled: true, desc: 'Return to commands', action: { kind: 'page', page: 'main' }, slot: 11 });
    return out;
  }

  // ---------------- units
  if (lead.isUnit) {
    const movable = (d.speed ?? 0) > 0;
    if (movable) {
      out.push({ key: 'move', label: 'Move', svg: 'move', enabled: true, desc: 'Move to a location or follow a unit.', action: { kind: 'target', mode: { t: 'move' } }, slot: 0 });
      out.push({ key: 'stop', label: 'Stop', svg: 'stop', enabled: true, desc: 'Stop all orders.', action: { kind: 'cmd', cmd: { c: 'stop', ids: allIds } }, slot: 1 });
      out.push({ key: 'hold', label: 'Hold', svg: 'hold', enabled: true, desc: 'Hold position: attack only what is in range.', action: { kind: 'cmd', cmd: { c: 'hold', ids: allIds } }, slot: 2 });
      out.push({ key: 'patrol', label: 'Patrol', svg: 'patrol', enabled: true, desc: 'Patrol between here and a location.', action: { kind: 'target', mode: { t: 'patrol' } }, slot: 3 });
    } else if (d.weapons) {
      out.push({ key: 'stop', label: 'Stop', svg: 'stop', enabled: true, desc: 'Stop.', action: { kind: 'cmd', cmd: { c: 'stop', ids: allIds } }, slot: 1 });
    }
    if (own.some((e) => e.def.weapons)) {
      out.push({ key: 'attack', label: 'Attack', svg: 'attack', enabled: true, desc: 'Attack a target, or attack-move to a location (engage enemies on the way).', action: { kind: 'target', mode: { t: 'amove' } }, slot: 4 });
    }
    if (d.cargo) {
      const able = act.some((e) => canCarry(g, e));
      const why = able ? undefined : `Requires ${RESEARCH_DEFS[d.cargoReq ?? '']?.name ?? 'research'}`;
      out.push({ key: 'load', label: 'Load', svg: 'load', enabled: able, why, desc: `Pick up a unit (carries ${d.cargo} slots: small units 1, medium 2, large 4).`, action: { kind: 'target', mode: { t: 'load' } }, slot: 8 });
      out.push({
        key: 'unload', label: 'Unload All', svg: 'unload', enabled: able && act.some((e) => e.cargo.length > 0), why: why ?? 'Nothing on board',
        desc: 'Fly to a location and unload everything.', action: { kind: 'target', mode: { t: 'unload' } }, slot: 9,
      });
    }
    let slot = 5;
    if (d.worker) {
      out.push({ key: 'gather', label: 'Gather', svg: 'gather', enabled: true, desc: 'Harvest minerals or gas.', action: { kind: 'target', mode: { t: 'gather' } }, slot: 5 });
      out.push({ key: 'return', label: 'Return', svg: 'return', enabled: act.some((e) => e.carry > 0), desc: 'Return carried resources.', action: { kind: 'cmd', cmd: { c: 'return', ids: actIds } }, slot: 6 });
      if (d.id === 'hardhat') out.push({ key: 'repair', label: 'Repair', svg: 'repair', enabled: true, desc: 'Repair mechanical units and structures (costs resources). Also resumes unfinished construction.', action: { kind: 'target', mode: { t: 'repair' } }, slot: 7 });
      out.push({ key: 'b1', label: 'Build', svg: 'build', enabled: true, desc: 'Basic structures.', action: { kind: 'page', page: 'build1' }, slot: 8 });
      out.push({ key: 'b2', label: 'Advanced', svg: 'build2', enabled: true, desc: 'Advanced structures.', action: { kind: 'page', page: 'build2' }, slot: 9 });
      return out;
    }
    for (const abId of d.abilities ?? []) {
      const ab = ABILITY_DEFS[abId];
      if (!ab || ['gather', 'return', 'repair', 'build', 'build2'].includes(abId)) continue;
      if (ab.passive) {
        if (ab.requires && !p.has(ab.requires)) continue;
        out.push({ key: 'ab:' + ab.id, label: ab.name, svg: ab.icon, enabled: false, why: 'Passive', desc: ab.desc, action: { kind: 'cmd', cmd: { c: 'stop', ids: [] } }, slot: slot++ });
        continue;
      }
      const missing = g.missingTech(p, ab.needs);
      const researched = (!ab.requires || p.has(ab.requires)) && !missing;
      let why: string | undefined;
      if (missing) why = `Requires ${missing}`;
      else if (!researched) why = `Requires ${RESEARCH_DEFS[ab.requires!]?.name ?? ab.requires} research`;
      const energyOk = !ab.energy || act.some((e) => e.energy >= ab.energy!);
      if (researched && !energyOk) why = 'Not enough energy';
      const enabled = researched && energyOk;
      const action: Action = ab.target === 'none'
        ? { kind: 'cmd', cmd: { c: 'ability', ids: actIds, a: ab.id } }
        : { kind: 'target', mode: { t: 'ability', ab: ab.id } };
      out.push({ key: 'ab:' + ab.id, label: ab.name, svg: ab.icon, enabled, why, energy: ab.energy, desc: ab.desc, action, slot: slot++ });
    }
    for (const m of d.unitMorphs ?? []) {
      const md = DEFS[m];
      const missing = g.missingTech(p, md.requires);
      out.push({
        key: 'morph:' + m, label: `Grow ${md.name}`, def: md, enabled: !missing, why: missing ? `Requires ${missing}` : undefined,
        cost: md.cost, time: md.time, desc: md.desc, action: { kind: 'cmd', cmd: { c: 'morph', ids: actIds, d: m } }, slot: slot++,
      });
    }
    return out;
  }

  // ---------------- structures
  let slot = 0;
  const cubs = act.reduce((s, e) => s + e.cubs.length, 0);
  for (const u of d.produces ?? []) {
    const ud = DEFS[u];
    const missing = g.missingTech(p, ud.requires);
    const unpowered = d.needsPower && !act.some((e) => e.powered);
    out.push({
      key: 'train:' + u, label: (ud.count ?? 1) > 1 ? `${ud.name} ×${ud.count}` : ud.name, def: ud,
      enabled: !missing && !unpowered && (!d.spawnsCubs || cubs > 0),
      why: missing ? `Requires ${missing}` : unpowered ? 'Unpowered: needs a Star Totem\'s glow' : d.spawnsCubs && cubs === 0 ? 'No cubs available' : undefined,
      cost: ud.cost, supply: (ud.supply ?? 0) * (ud.count ?? 1), time: ud.time, desc: ud.desc,
      action: { kind: 'cmd', cmd: { c: 'train', ids: actIds, d: u } }, slot: slot++,
    });
  }
  for (const r of d.researches ?? []) {
    const rd = RESEARCH_DEFS[r];
    const lvl = p.level(r) + (p.researching[r] ?? 0);
    if (lvl >= rd.costs.length) continue;
    const reqs = rd.reqs?.[lvl];
    const missing = g.missingTech(p, reqs);
    const busy = (p.researching[r] ?? 0) > 0;
    const label = rd.costs.length > 1 ? `${rd.name} ${lvl + 1}` : rd.name;
    out.push({
      key: 'research:' + r, label, svg: rd.icon, enabled: !missing && !busy, why: busy ? 'Researching…' : missing ? `Requires ${missing}` : undefined,
      cost: rd.costs[lvl], time: rd.times[lvl], desc: rd.desc, action: { kind: 'cmd', cmd: { c: 'research', ids: actIds, r } }, slot: slot++,
    });
  }
  for (const m of d.morphs ?? []) {
    const md = DEFS[m];
    const missing = g.missingTech(p, md.requires);
    const busy = act.every((e) => e.queue.some((q) => q.kind === 'morph'));
    out.push({
      key: 'bmorph:' + m, label: `Evolve ${md.name}`, def: md, enabled: !missing && !busy,
      why: busy ? 'Already evolving' : missing ? `Requires ${missing}` : undefined, cost: md.cost, time: md.time, desc: md.desc,
      action: { kind: 'cmd', cmd: { c: 'morph', ids: actIds, d: m } }, slot: slot++,
    });
  }
  for (const abId of d.abilities ?? []) {
    const ab = ABILITY_DEFS[abId];
    if (!ab) continue;
    const energyOk = !ab.energy || act.some((e) => e.energy >= ab.energy!);
    const action: Action = ab.target === 'none'
      ? { kind: 'cmd', cmd: { c: 'ability', ids: actIds, a: ab.id } }
      : { kind: 'target', mode: { t: 'ability', ab: ab.id } };
    out.push({ key: 'ab:' + ab.id, label: ab.name, svg: ab.icon, enabled: energyOk, why: energyOk ? undefined : 'Not enough energy', energy: ab.energy, desc: ab.desc, action, slot: slot++ });
  }
  if ((d.weapons && !d.produces) || d.bunker) {
    out.push({ key: 'stop', label: 'Stop', svg: 'stop', enabled: true, desc: 'Stop attacking.', action: { kind: 'cmd', cmd: { c: 'stop', ids: allIds } }, slot: 0 });
    out.push({ key: 'attack', label: 'Attack', svg: 'attack', enabled: true, desc: 'Attack a target.', action: { kind: 'target', mode: { t: 'amove' } }, slot: 1 });
  }
  if (d.bunker) {
    out.push({
      key: 'unload', label: 'Unload All', svg: 'unload', enabled: act.some((e) => e.cargo.length > 0), why: 'Nobody inside',
      desc: `Send everyone out. Up to ${d.cargo} infantry can take cover inside (right-click the bunker with them) and fire out with +${d.bunker} range.`,
      action: { kind: 'cmd', cmd: { c: 'unload', ids: actIds } }, slot: 2,
    });
  }
  if (d.produces || d.spawnsCubs) {
    out.push({ key: 'rally', label: 'Rally', svg: 'rally', enabled: true, desc: 'Set where new units go. Rally to minerals to auto-mine.', action: { kind: 'target', mode: { t: 'rally' } }, slot: 11 });
  }
  return out;
}

function cancelBtn(cmd: Command, slot: number): CmdButton {
  return { key: 'cancel', label: 'Cancel', svg: 'cancel', enabled: true, desc: 'Cancel and refund 75%.', action: { kind: 'cmd', cmd }, slot };
}

/**
 * Physical key positions for the 4×3 command card, row-major.
 * `code` names come from the QWERTY reference, but they identify the key's
 * position, so the same corners work on AZERTY, Dvorak, and other layouts.
 */
export const GRID_CODES = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];

const QWERTY_LABELS = ['Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
let gridLabels = QWERTY_LABELS.slice();

function glyph(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const chars = [...raw];
  if (chars.length !== 1) return fallback;
  const ch = chars[0].toUpperCase();
  return ch.trim() ? ch : fallback;
}

/** Character printed on that physical key. QWERTY letters until the OS layout is known. */
export function gridLabel(slot: number): string {
  return gridLabels[slot] ?? '';
}

interface KeyLayoutMap {
  get(code: string): string | undefined;
}

/** Not in the DOM lib this project typechecks against. Chromium implements it. */
interface KeyboardWithLayout {
  getLayoutMap?: () => Promise<KeyLayoutMap>;
}

/** Read the OS layout so the letters on the buttons match the keycaps. */
export function watchGridLabels(onChange: () => void): () => void {
  let dead = false;
  const read = (): void => {
    const keyboard = (navigator as Navigator & { keyboard?: KeyboardWithLayout }).keyboard;
    const get = keyboard?.getLayoutMap?.bind(keyboard);
    if (!get) return;
    void get()
      .then((map) => {
        if (dead) return;
        const next = GRID_CODES.map((code, i) => glyph(map.get(code), QWERTY_LABELS[i]));
        if (next.every((ch, i) => ch === gridLabels[i])) return;
        gridLabels = next;
        onChange();
      })
      .catch(() => {});
  };
  read();
  window.addEventListener('focus', read);
  return () => {
    dead = true;
    window.removeEventListener('focus', read);
  };
}

/** Lay buttons out on a 4x3 grid, honouring preferred slots. */
export function layout(buttons: CmdButton[]): (CmdButton | null)[] {
  const grid: (CmdButton | null)[] = new Array(12).fill(null);
  const rest: CmdButton[] = [];
  for (const b of buttons) {
    if (b.slot !== undefined && b.slot < 12 && !grid[b.slot]) grid[b.slot] = b;
    else rest.push(b);
  }
  for (const b of rest) {
    const i = grid.indexOf(null);
    if (i < 0) break;
    grid[i] = b;
  }
  for (let i = 0; i < grid.length; i++) {
    const b = grid[i];
    if (b) b.hotkey = gridLabel(i);
  }
  return grid;
}
