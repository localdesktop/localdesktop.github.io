// Top-down bears shared by every faction. Sprite-local space: (0,0) is the centre and the
// bear faces +x. `s` scales the whole animal; s = 1 fits a unit of radius 10.

import { circle, dome, ellipse, line, rgba, tone, type Ctx } from './kit.ts';

export interface Fur {
  fur: string;
  /** paws, ears and other dark points */
  dark: string;
  muzzle: string;
  nose?: string;
  /** inner ear */
  ear?: string;
}

export const FUR: Record<string, Fur> = {
  brown: { fur: '#8a5a33', dark: '#4a2d17', muzzle: '#c49a6c' },
  grizzly: { fur: '#9c7448', dark: '#4d3520', muzzle: '#d2b28a' },
  kodiak: { fur: '#6e4526', dark: '#3a2312', muzzle: '#a57a52' },
  black: { fur: '#2b2522', dark: '#151110', muzzle: '#b08a63' },
  sun: { fur: '#2a2320', dark: '#141010', muzzle: '#e0b05a' },
  sloth: { fur: '#231d1b', dark: '#0f0c0b', muzzle: '#d9cbb6' },
  spectacled: { fur: '#2e2621', dark: '#171210', muzzle: '#e6d3a8' },
  honey: { fur: '#c98d3c', dark: '#6a4516', muzzle: '#ecc98c' },
  cave: { fur: '#5b4634', dark: '#2c2118', muzzle: '#8f7357' },
  polar: { fur: '#eef0ea', dark: '#9aa3a6', muzzle: '#d9dcd4', nose: '#1d1d22' },
  spirit: { fur: '#f3eedf', dark: '#b3a98f', muzzle: '#e2d8bf', nose: '#3a3330' },
  glacier: { fur: '#7d8c99', dark: '#3e4852', muzzle: '#b6c1c9' },
  moon: { fur: '#1f1c22', dark: '#0d0b0f', muzzle: '#9b8b7a' },
  panda: { fur: '#f2f0ea', dark: '#1b1a1d', muzzle: '#f7f5ef' },
};

/** Head with round ears, snout, eyes and nose, centred at (x, 0). */
export function bearHead(ctx: Ctx, x: number, r: number, f: Fur, y = 0): void {
  for (const sy of [-1, 1]) {
    const ex = x - r * 0.45;
    const ey = y + sy * r * 0.78;
    circle(ctx, ex, ey, r * 0.42, f.dark);
    circle(ctx, ex + r * 0.05, ey, r * 0.22, f.ear ?? tone(f.dark, 0.25));
  }
  circle(ctx, x, y, r, dome(ctx, x, y, r, f.fur, 0.35), rgba('#000000', 0.45), 0.6);
  ellipse(ctx, x + r * 0.72, y, r * 0.5, r * 0.38, 0, dome(ctx, x + r * 0.72, y, r * 0.5, f.muzzle, 0.3));
  ellipse(ctx, x + r * 1.12, y, r * 0.17, r * 0.22, 0, f.nose ?? '#141010');
  for (const sy of [-1, 1]) circle(ctx, x + r * 0.32, y + sy * r * 0.36, r * 0.11, '#0b0908');
}

/** A bear on all fours. `stride` is the paw swing; frame drives the diagonal gait. */
export function quadBear(ctx: Ctx, frame: number, s: number, f: Fur, o: { long?: number; wide?: number; hump?: boolean; shag?: boolean } = {}): void {
  const L = 22 * s * (o.long ?? 1);
  const W = 13 * s * (o.wide ?? 1);
  const ph = [0, 1, 0, -1][frame % 4] * 2.2 * s;
  const paws: [number, number, number][] = [
    [L * 0.3, -W * 0.48, ph], [L * 0.3, W * 0.48, -ph], [-L * 0.32, -W * 0.44, -ph], [-L * 0.32, W * 0.44, ph],
  ];
  for (const [px, py, d] of paws) {
    line(ctx, px * 0.7, py * 0.6, px + d, py, f.dark, 3.6 * s);
    ellipse(ctx, px + d, py, 2.4 * s, 2 * s, 0, f.dark);
  }
  circle(ctx, -L * 0.52, 0, 1.8 * s, f.dark);
  ellipse(ctx, -L * 0.05, 0, L * 0.5, W * 0.5, 0, dome(ctx, -L * 0.05, 0, L * 0.5, f.fur, 0.3), rgba('#000000', 0.45), 0.7);
  if (o.hump) ellipse(ctx, L * 0.14, 0, L * 0.18, W * 0.36, 0, rgba(tone(f.fur, 0.25), 0.8));
  ctx.strokeStyle = rgba(o.shag ? tone(f.fur, 0.35) : '#000000', o.shag ? 0.55 : 0.18);
  ctx.lineWidth = 0.7 * s;
  for (let i = 0; i < (o.shag ? 9 : 5); i++) {
    const x = -L * 0.4 + (L * 0.65 * i) / (o.shag ? 8 : 4);
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, sy * W * 0.18);
      ctx.lineTo(x - 2 * s, sy * W * 0.42);
      ctx.stroke();
    }
  }
  bearHead(ctx, L * 0.48, 5 * s, f);
}

/** A bear standing upright, seen from above: shoulders, arms reaching forward, head. */
export function bipedBear(ctx: Ctx, frame: number, s: number, f: Fur): void {
  const ph = [0, 1, 0, -1][frame % 4] * 2.4 * s;
  ellipse(ctx, ph, -4 * s, 3 * s, 2.2 * s, 0, f.dark);
  ellipse(ctx, -ph, 4 * s, 3 * s, 2.2 * s, 0, f.dark);
  ellipse(ctx, -1.5 * s, 0, 5.6 * s, 7.6 * s, 0, dome(ctx, -1.5 * s, 0, 7.6 * s, f.fur, 0.3), rgba('#000000', 0.45), 0.7);
  bipedArms(ctx, s, f);
  bearHead(ctx, 1.6 * s, 4 * s, f);
}

/** The two forward-reaching arms of an upright bear; drawn again on top of held gear. */
export function bipedArms(ctx: Ctx, s: number, f: Fur, reach = 1): void {
  for (const sy of [-1, 1]) {
    line(ctx, -0.5 * s, sy * 5.6 * s, 5 * s * reach, sy * 3.6 * s, f.fur, 3.4 * s);
    circle(ctx, 5.2 * s * reach, sy * 3.6 * s, 1.9 * s, f.dark);
  }
}

/** Paw-print emblem (pad plus four toes), for team badges on buildings and gear. */
export function pawPrint(ctx: Ctx, x: number, y: number, r: number, col: string): void {
  ellipse(ctx, x, y + r * 0.25, r * 0.55, r * 0.45, 0, col);
  for (const [dx, dy] of [[-0.62, -0.25], [-0.22, -0.62], [0.22, -0.62], [0.62, -0.25]]) circle(ctx, x + dx * r, y + dy * r, r * 0.22, col);
}
