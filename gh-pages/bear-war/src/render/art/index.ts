import type { EntityDef } from '../../game/data/types.ts';

export interface TeamPal {
  main: string;
  light: string;
  dark: string;
  index: number;
}

export type DrawFn = (ctx: CanvasRenderingContext2D, c: TeamPal, frame: number, def: EntityDef) => void;

export interface OverlayState {
  t: number;
  built: boolean;
  powered: boolean;
  working: boolean;
  seed: number;
}

export interface ArtDef {
  /** unit sprite box side (world px) */
  size?: number;
  /** extra space around a structure footprint (world px) */
  pad?: number;
  frames?: number;
  draw: DrawFn;
  turret?: DrawFn;
  turretSize?: number;
  /** cheap per-frame decoration in world px, centred on the entity (structures: unrotated) */
  overlay?: (ctx: CanvasRenderingContext2D, c: TeamPal, s: OverlayState, def: EntityDef) => void;
}

const placeholderUnit: ArtDef = {
  draw(ctx, c, _f, def) {
    const r = def.radius ?? 10;
    ctx.fillStyle = c.dark;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.main;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.light;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(r * 0.2, -r * 0.45);
    ctx.lineTo(r * 0.2, r * 0.45);
    ctx.fill();
  },
};

const placeholderBuilding: ArtDef = {
  draw(ctx, c, _f, def) {
    const [w, h] = def.size ?? [2, 2];
    const W = w * 32;
    const H = h * 32;
    ctx.fillStyle = '#555';
    ctx.fillRect(-W / 2 + 2, -H / 2 + 2, W - 4, H - 4);
    ctx.strokeStyle = c.main;
    ctx.lineWidth = 3;
    ctx.strokeRect(-W / 2 + 3, -H / 2 + 3, W - 6, H - 6);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.name.slice(0, 3).toUpperCase(), 0, 0);
  },
};

export const ART: Record<string, ArtDef> = {
  _unit: placeholderUnit,
  _building: placeholderBuilding,
};

import { IRONPAW_ART } from './ironpaw.ts';
import { HORDE_ART } from './horde.ts';
import { STARBORN_ART } from './starborn.ts';
import { NEUTRAL_ART } from './neutral.ts';
Object.assign(ART, IRONPAW_ART, HORDE_ART, STARBORN_ART, NEUTRAL_ART);

/** Register art definitions (called by the per-race art modules). */
export function registerArt(defs: Record<string, ArtDef>): void {
  Object.assign(ART, defs);
}

export function fallbackArt(def: EntityDef): ArtDef {
  return def.kind === 'building' || def.kind === 'mineral' || def.kind === 'geyser' ? placeholderBuilding : placeholderUnit;
}
