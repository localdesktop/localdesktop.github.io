// Sprite cache. Every sprite is drawn procedurally (see art/*.ts) into an offscreen
// canvas once per (type, team colour, frame) and then blitted with rotation.

import { TEAM_COLORS } from '../game/constants.ts';
import type { EntityDef } from '../game/data/types.ts';
import { ART, fallbackArt, type ArtDef, type TeamPal } from './art/index.ts';

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** size in world px */
  w: number;
  h: number;
}

const NEUTRAL_PAL: TeamPal = { main: '#9aa4ad', light: '#d5dde4', dark: '#4a525a', index: -1 };

export function teamPal(color: number): TeamPal {
  const c = TEAM_COLORS[color] ?? TEAM_COLORS[0];
  return { main: c.main, light: c.light, dark: c.dark, index: color };
}

export class SpriteCache {
  unitScale: number;
  buildingScale: number;
  private cache = new Map<string, Sprite>();

  constructor(unitScale = 2, buildingScale = 1.5) {
    this.unitScale = unitScale;
    this.buildingScale = buildingScale;
  }

  art(def: EntityDef): ArtDef {
    return ART[def.art ?? def.id] ?? ART[def.id] ?? fallbackArt(def);
  }

  /** layer: 'body' | 'turret'; frame: animation frame index */
  get(def: EntityDef, color: number, layer: 'body' | 'turret' = 'body', frame = 0): Sprite | null {
    const art = this.art(def);
    const frames = art.frames ?? 1;
    const f = frames > 1 ? ((frame % frames) + frames) % frames : 0;
    const key = `${def.id}|${color}|${layer}|${f}`;
    let s = this.cache.get(key);
    if (s) return s;
    if (layer === 'turret' && !art.turret) return null;
    const isStruct = def.kind === 'building' || def.kind === 'mineral' || def.kind === 'geyser';
    const scale = isStruct ? this.buildingScale : this.unitScale;
    let w: number;
    let h: number;
    if (isStruct && def.size) {
      w = def.size[0] * 32 + (art.pad ?? 8) * 2;
      h = def.size[1] * 32 + (art.pad ?? 8) * 2;
    } else {
      w = h = art.size ?? (def.radius ?? 10) * 3;
    }
    if (layer === 'turret') w = h = art.turretSize ?? w;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(h * scale);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(scale, 0, 0, scale, (w * scale) / 2, (h * scale) / 2);
    const pal = color < 0 ? NEUTRAL_PAL : teamPal(color);
    try {
      if (layer === 'turret') art.turret!(ctx, pal, f, def);
      else art.draw(ctx, pal, f, def);
    } catch (err) {
      console.error('sprite draw failed', def.id, err);
    }
    s = { canvas: c, w, h };
    this.cache.set(key, s);
    return s;
  }

  /** Icon for UI buttons/portraits (unrotated, facing right for units). */
  icon(def: EntityDef, color: number, px: number): HTMLCanvasElement {
    const key = `icon|${def.id}|${color}|${px}`;
    const hit = this.cache.get(key);
    if (hit) return hit.canvas;
    const s = this.get(def, color, 'body', 0)!;
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const ctx = c.getContext('2d')!;
    const isStruct = def.kind !== 'unit' && def.kind !== 'cub' && def.kind !== 'cocoon';
    const span = isStruct ? Math.max(s.w, s.h) : (def.radius ?? 10) * 2.6;
    const k = px / span;
    ctx.translate(px / 2, px / 2);
    if (!isStruct) ctx.rotate(-Math.PI / 2);
    ctx.drawImage(s.canvas, (-s.w * k) / 2, (-s.h * k) / 2, s.w * k, s.h * k);
    const t = this.get(def, color, 'turret', 0);
    if (t) ctx.drawImage(t.canvas, (-t.w * k) / 2, (-t.h * k) / 2, t.w * k, t.h * k);
    this.cache.set(key, { canvas: c, w: px, h: px });
    return c;
  }

  clear(): void {
    this.cache.clear();
  }
}
