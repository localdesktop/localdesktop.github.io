import { DEFS, family } from '../game/data/index.ts';
import type { Entity } from '../game/entity.ts';
import type { Game } from '../game/game.ts';

/** Display priority of entity types within a mixed selection (lower first). */
function typeRank(e: Entity): number {
  if (e.isBuilding) return 50 + (e.def.order ?? 0);
  if (e.def.worker) return 40;
  if (e.def.kind === 'cub' || e.def.kind === 'cocoon') return 45;
  return (e.def.order ?? 0) - (e.def.energy ? 0.5 : 0);
}

export class Selection {
  ids: number[] = [];
  groups: number[][] = Array.from({ length: 10 }, () => []);
  /** def id of the subgroup whose commands are shown */
  active: string | null = null;
  version = 0;

  entities(g: Game): Entity[] {
    const out: Entity[] = [];
    let changed = false;
    for (const id of this.ids) {
      const e = g.get(id);
      if (e && !e.inside) out.push(e);
      else if (!e) changed = true;
    }
    if (changed) {
      this.ids = this.ids.filter((id) => g.get(id));
      this.version++;
      this.fixActive(g);
    }
    return out;
  }

  set(g: Game, es: Entity[]): void {
    const sorted = [...es].sort((a, b) => typeRank(a) - typeRank(b) || a.id - b.id);
    this.ids = sorted.map((e) => e.id);
    this.active = sorted[0]?.def.id ?? null;
    this.version++;
    void g;
  }

  add(g: Game, es: Entity[]): void {
    const cur = this.entities(g);
    for (const e of es) if (!cur.includes(e)) cur.push(e);
    const keep = this.active;
    this.set(g, cur);
    if (keep && cur.some((e) => e.def.id === keep)) this.active = keep;
  }

  remove(g: Game, es: Entity[]): void {
    const set = new Set(es.map((e) => e.id));
    this.ids = this.ids.filter((id) => !set.has(id));
    this.version++;
    this.fixActive(g);
  }

  clear(): void {
    this.ids = [];
    this.active = null;
    this.version++;
  }

  has(id: number): boolean {
    return this.ids.includes(id);
  }

  fixActive(g: Game): void {
    const es = this.ids.map((id) => g.get(id)).filter((e): e is Entity => !!e);
    if (!es.some((e) => e.def.id === this.active)) this.active = es[0]?.def.id ?? null;
  }

  /** cycle the active subgroup (Tab) */
  cycle(g: Game): void {
    const types: string[] = [];
    for (const e of this.entities(g)) if (!types.includes(e.def.id)) types.push(e.def.id);
    if (types.length < 2) return;
    const i = types.indexOf(this.active ?? '');
    this.active = types[(i + 1) % types.length];
    this.version++;
  }

  activeEntities(g: Game): Entity[] {
    return this.entities(g).filter((e) => e.def.id === this.active || sameFamily(e.def.id, this.active));
  }

  saveGroup(i: number, g: Game): void {
    this.groups[i] = this.entities(g).map((e) => e.id);
  }
  addToGroup(i: number, g: Game): void {
    const cur = new Set(this.groups[i]);
    for (const e of this.entities(g)) cur.add(e.id);
    this.groups[i] = [...cur];
  }
  loadGroup(i: number, g: Game): Entity[] {
    const es = this.groups[i].map((id) => g.get(id)).filter((e): e is Entity => !!e);
    this.groups[i] = es.map((e) => e.id);
    return es;
  }
}

/** Unit modes share commands; hive tiers too. */
function sameFamily(a: string, b: string | null): boolean {
  return !!b && family(DEFS[a]) === family(DEFS[b]);
}
