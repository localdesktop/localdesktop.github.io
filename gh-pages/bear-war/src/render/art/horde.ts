// Honey Horde art: feral bears living alongside giant bees. Amber wax, honeycomb,
// bark and dark wood; team colour shows on honey sacs, stripes, straps and banners.

import type { ArtDef, TeamPal } from './index.ts';
import { FUR, bearHead, bipedArms, bipedBear, pawPrint, quadBear, type Fur } from './bear.ts';
import { circle, dome, ellipse, glow, line, poly, rgba, rnd, rrect, lit, tone, type Ctx, TAU } from './kit.ts';

const WAX = '#e0a42e';
const WAX_L = '#ffd56a';
const WAX_D = '#7e4f10';
const HONEY = '#f29a1a';
const WOOD = '#6b4526';
const WOOD_D = '#2f1d0f';
const BARK = '#4f3520';
const EARTH = '#5e4630';
const BONE = '#e2d6b4';
const BEE_Y = '#f5c730';
const BEE_K = '#1d1712';
const PAPER = '#b5a486';
const STONE = '#7a6c5c';

/** Noisy closed blob path. */
function blob(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, seed: number, amp = 0.12, n = 18): void {
  const r = rnd(seed);
  const offs: number[] = [];
  for (let i = 0; i < n; i++) offs.push(1 + (r() - 0.5) * 2 * amp);
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a0 = (i / n) * TAU;
    const k = offs[i % n];
    const x = cx + Math.cos(a0) * rx * k;
    const y = cy + Math.sin(a0) * ry * k;
    if (i === 0) ctx.moveTo(x, y);
    else {
      const am = ((i - 0.5) / n) * TAU;
      const km = (offs[(i - 1) % n] + k) / 2;
      ctx.quadraticCurveTo(cx + Math.cos(am) * rx * km * 1.04, cy + Math.sin(am) * ry * km * 1.04, x, y);
    }
  }
  ctx.closePath();
}

function fillBlob(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, seed: number, fill: string | CanvasGradient, stroke = WOOD_D, amp = 0.12): void {
  blob(ctx, cx, cy, rx, ry, seed, amp);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function hexPath(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

/** Honeycomb grid over a box; the caller clips. Some cells hold honey, some are empty. */
function combCells(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, r: number, seed: number, base = WAX, honey = 0.25, empty = 0.12): void {
  const R = rnd(seed);
  const dx = r * 1.5;
  const dy = r * Math.sqrt(3);
  const ni = Math.ceil(rx / dx) + 1;
  const nj = Math.ceil(ry / dy) + 1;
  ctx.lineWidth = Math.max(0.5, r * 0.2);
  ctx.strokeStyle = tone(base, -0.55);
  for (let i = -ni; i <= ni; i++) {
    const x = cx + i * dx;
    const off = i & 1 ? dy / 2 : 0;
    for (let j = -nj; j <= nj; j++) {
      const y = cy + j * dy + off;
      const k = R();
      hexPath(ctx, x, y, r * 0.92);
      if (k < honey) {
        ctx.fillStyle = dome(ctx, x, y, r, HONEY, 0.5);
      } else if (k < honey + empty) {
        ctx.fillStyle = tone(base, -0.6);
      } else {
        ctx.fillStyle = tone(base, (R() - 0.5) * 0.25);
      }
      ctx.fill();
      ctx.stroke();
      if (k < honey) circle(ctx, x - r * 0.3, y - r * 0.3, r * 0.22, rgba('#ffffff', 0.55));
    }
  }
}

/** Blob filled with honeycomb and a soft dome shade on top. */
function combBlob(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, seed: number, cell: number, base = WAX, honey = 0.25, amp = 0.12): void {
  ctx.save();
  blob(ctx, cx, cy, rx, ry, seed, amp);
  ctx.clip();
  combCells(ctx, cx, cy, rx * 1.2, ry * 1.2, cell, seed + 1, base, honey);
  const g = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.3, 0, cx, cy, Math.max(rx, ry) * 1.15);
  g.addColorStop(0, 'rgba(255,240,190,0.25)');
  g.addColorStop(0.6, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(40,20,0,0.5)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - rx * 1.3, cy - ry * 1.3, rx * 2.6, ry * 2.6);
  ctx.restore();
  blob(ctx, cx, cy, rx, ry, seed, amp);
  ctx.strokeStyle = WAX_D;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

/** The spreading honeycomb every Horde structure stands on. */
function combGround(ctx: Ctx, w: number, h: number, seed: number, base = '#a8742a'): void {
  ctx.save();
  ctx.filter = 'blur(3px)';
  fillBlob(ctx, 3, 5, w / 2, h / 2, seed, 'rgba(0,0,0,0.35)', '', 0.1);
  ctx.restore();
  combBlob(ctx, 0, 0, w / 2, h / 2, seed, Math.max(3.5, w / 26), base, 0.1, 0.1);
}

/** Wax drips hanging below an edge. */
function drips(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, n: number, seed: number, col = WAX): void {
  const R = rnd(seed);
  for (let i = 0; i < n; i++) {
    const a = 0.25 + (i / Math.max(1, n - 1)) * (Math.PI - 0.5) + (R() - 0.5) * 0.15;
    const x = cx + Math.cos(a) * rx;
    const y = cy + Math.sin(a) * ry;
    const l = 3 + R() * 5;
    ctx.fillStyle = tone(col, 0.1);
    ctx.beginPath();
    ctx.moveTo(x - 2, y - 1);
    ctx.lineTo(x + 2, y - 1);
    ctx.quadraticCurveTo(x + 1.6, y + l * 0.6, x, y + l);
    ctx.quadraticCurveTo(x - 1.6, y + l * 0.6, x - 2, y - 1);
    ctx.fill();
    circle(ctx, x - 0.5, y + l * 0.55, 0.7, 'rgba(255,255,255,0.5)');
  }
}

/** Team-coloured honey sac. */
function sac(ctx: Ctx, x: number, y: number, r: number, c: TeamPal): void {
  circle(ctx, x, y, r, dome(ctx, x, y, r, c.main, 0.55), tone(c.dark, -0.35), 0.6);
  circle(ctx, x + r * 0.15, y + r * 0.2, r * 0.55, rgba(HONEY, 0.35));
  circle(ctx, x - r * 0.35, y - r * 0.35, r * 0.26, rgba('#ffffff', 0.55));
}

function spikes(ctx: Ctx, cx: number, cy: number, r: number, n: number, len: number, seed: number, col = BONE, w = 2.4): void {
  const R = rnd(seed);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + R() * 0.3;
    const l = len * (0.7 + R() * 0.6);
    const bx = cx + Math.cos(a) * r;
    const by = cy + Math.sin(a) * r;
    const nx = Math.cos(a + Math.PI / 2) * w;
    const ny = Math.sin(a + Math.PI / 2) * w;
    poly(ctx, [bx + nx, by + ny, bx + Math.cos(a) * l, by + Math.sin(a) * l, bx - nx, by - ny], col, tone(col, -0.5), 0.6);
  }
}

/** Bee-striped stinger spike from (x0,y0) to the point (x1,y1). */
function stingerSpike(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, w: number): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const nx = Math.cos(a + Math.PI / 2) * w;
  const ny = Math.sin(a + Math.PI / 2) * w;
  const at = (t: number, k: number) => [x0 + (x1 - x0) * t + nx * k, y0 + (y1 - y0) * t + ny * k];
  poly(ctx, [...at(0, 1), x1, y1, ...at(0, -1)], BEE_Y, BEE_K, 0.6);
  poly(ctx, [...at(0.25, 0.75), ...at(0.42, 0.58), ...at(0.42, -0.58), ...at(0.25, -0.75)], BEE_K);
  poly(ctx, [...at(0.62, 0.38), x1, y1, ...at(0.62, -0.38)], BEE_K);
}

/** Translucent insect wing rooted at (x,y), pointing along `ang`. */
function wing(ctx: Ctx, x: number, y: number, len: number, wid: number, ang: number, tint = '#ffffff', a = 0.45): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ellipse(ctx, len / 2, 0, len / 2, wid / 2, 0, rgba(tint, a), rgba('#2a1a08', 0.55), 0.6);
  ctx.strokeStyle = rgba('#2a1a08', 0.3);
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len * 0.92, 0);
  ctx.moveTo(len * 0.3, 0);
  ctx.lineTo(len * 0.7, -wid * 0.3);
  ctx.moveTo(len * 0.4, 0);
  ctx.lineTo(len * 0.75, wid * 0.28);
  ctx.stroke();
  ellipse(ctx, len * 0.4, -wid * 0.15, len * 0.18, wid * 0.12, 0, rgba('#ffffff', 0.35));
  ctx.restore();
}

/** Small honeybee facing `a`. */
function bee(ctx: Ctx, x: number, y: number, s: number, a: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ellipse(ctx, 0, 0, 1.4 * s, 0.85 * s, 0, BEE_Y, BEE_K, 0.3 * s);
  line(ctx, -0.2 * s, -0.75 * s, -0.2 * s, 0.75 * s, BEE_K, 0.4 * s);
  line(ctx, -0.85 * s, -0.5 * s, -0.85 * s, 0.5 * s, BEE_K, 0.35 * s);
  circle(ctx, 1.3 * s, 0, 0.55 * s, BEE_K);
  ellipse(ctx, -0.1 * s, -1 * s, 0.9 * s, 0.5 * s, -0.5, 'rgba(255,255,255,0.7)');
  ellipse(ctx, -0.1 * s, 1 * s, 0.9 * s, 0.5 * s, 0.5, 'rgba(255,255,255,0.7)');
  ctx.restore();
}

/** Bees circling (cx, cy) on a wobbly ring. */
function orbitBees(ctx: Ctx, cx: number, cy: number, r: number, n: number, t: number, seed: number, s = 1.6, speed = 1.6): void {
  for (let i = 0; i < n; i++) {
    const dir = i % 2 ? -1 : 1;
    const a = dir * t * speed * (0.8 + (i % 3) * 0.15) + (i / n) * TAU + seed;
    const rr = r * (0.85 + 0.15 * Math.sin(t * 3 + i * 1.7));
    bee(ctx, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.9, s, a + (dir * Math.PI) / 2);
  }
}

/** Top-down straw skep: concentric coils, optionally bee-striped. */
function skep(ctx: Ctx, x: number, y: number, r: number, striped: boolean, band?: string): void {
  circle(ctx, x, y, r, dome(ctx, x, y, r, striped ? BEE_Y : '#d9a441', 0.45), WOOD_D, 0.8);
  const n = Math.max(3, Math.round(r / 2.2));
  for (let i = 1; i < n; i++) {
    const rr = (r * i) / n;
    const odd = i % 2 === 1;
    if (striped && odd) circle(ctx, x - (r - rr) * 0.08, y - (r - rr) * 0.08, rr + r / n / 2, null, rgba(BEE_K, 0.85), r / n);
    else circle(ctx, x - (r - rr) * 0.08, y - (r - rr) * 0.08, rr, null, rgba(WAX_D, 0.6), 0.7);
  }
  if (band) circle(ctx, x, y, r * 0.82, null, band, r * 0.14);
  circle(ctx, x - r * 0.3, y - r * 0.32, r * 0.25, rgba('#fff6cf', 0.35));
}

/** Stretches the front paws of a quadBear into visible claws. */
function frontClaws(ctx: Ctx, frame: number, s: number, long: number, wide: number, len: number, col = BONE): void {
  const L = 22 * s * long;
  const W = 13 * s * wide;
  const ph = [0, 1, 0, -1][frame % 4] * 2.2 * s;
  for (const [py, d] of [[-W * 0.48, ph], [W * 0.48, -ph]]) {
    const px = L * 0.3 + d + 1.6 * s;
    for (const k of [-1, 0, 1]) line(ctx, px, py + k * 0.9 * s, px + len, py + k * 1.3 * s, col, 0.55 * s);
  }
}

function headX(s: number, long = 1): number {
  return 22 * s * long * 0.48;
}

/** Wooden bee box with a stacked look. */
function beeBox(ctx: Ctx, x: number, y: number, w: number, h: number, stack: number, c: TeamPal): void {
  for (let i = 0; i < stack; i++) {
    const yy = y - i * 4;
    rrect(ctx, x, yy + 4, w, h - 4, 2, tone(WOOD, -0.35), WOOD_D, 0.8);
    rrect(ctx, x + w * 0.3, yy + h - 2.5, w * 0.4, 1.6, 0.6, BEE_K);
  }
  const top = y - (stack - 1) * 4;
  rrect(ctx, x - 1, top - 1, w + 2, h - 3, 2, lit(ctx, x, top, x + w, top + h, '#b8854c', 0.25), WOOD_D, 0.9);
  for (let i = 1; i < 4; i++) line(ctx, x + 1, top + (h - 4) * (i / 4), x + w - 1, top + (h - 4) * (i / 4), 'rgba(60,30,10,0.35)', 0.6);
  rrect(ctx, x + 2, top + (h - 4) * 0.4, w - 4, 3, 1, c.main, tone(c.dark, -0.3), 0.5);
}

function honeyPot(ctx: Ctx, x: number, y: number, r: number, c: TeamPal): void {
  circle(ctx, x + 1, y + 1.5, r, 'rgba(0,0,0,0.3)');
  circle(ctx, x, y, r, dome(ctx, x, y, r, '#a8642c', 0.4), '#3a1f0a', 0.8);
  circle(ctx, x, y, r * 0.62, dome(ctx, x, y, r * 0.62, HONEY, 0.5));
  circle(ctx, x, y, r * 0.62, null, c.main, 1.4);
  circle(ctx, x - r * 0.2, y - r * 0.2, r * 0.15, 'rgba(255,255,255,0.6)');
}

function banner(ctx: Ctx, x: number, y: number, c: TeamPal, h = 12): void {
  circle(ctx, x + 1, y + 2, 2.6, 'rgba(0,0,0,0.3)');
  poly(ctx, [x, y - h, x + 7, y - h + 1, x + 5.5, y - h + 4, x + 7, y - h + 7, x, y - h + 7], c.main, tone(c.dark, -0.3), 0.6);
  line(ctx, x, y, x, y - h - 1, WOOD_D, 1.6);
  circle(ctx, x, y, 2, dome(ctx, x, y, 2, WOOD, 0.4));
}

// ---------------------------------------------------------------- unit bodies

function curledCub(ctx: Ctx, c: TeamPal, w: number, f: Fur): void {
  ctx.rotate(w * 0.18);
  for (const sy of [-1, 1]) ellipse(ctx, -2.6, sy * 2.2, 1.2, 1, 0, f.dark);
  circle(ctx, -0.8, 0, 3.4, dome(ctx, -0.8, 0, 3.4, f.fur, 0.35), rgba('#000000', 0.45), 0.5);
  ellipse(ctx, 1.3, 0, 0.9, 2.3, 0, c.main);
  bearHead(ctx, 2.6, 2.3, f, w * 0.4);
  for (const sy of [-1, 1]) circle(ctx, 1.8, sy * 2.6 + w * 0.3, 0.9, f.dark);
}

function shaggyTufts(ctx: Ctx, rx: number, ry: number, cx: number, n: number, col: string, seed: number): void {
  const R = rnd(seed);
  ctx.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + R() * 0.2;
    if (Math.abs(Math.cos(a)) > 0.85 && Math.cos(a) > 0) continue;
    const x = cx + Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    const l = 1 + R() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x - Math.sin(a) * 0.9, y + Math.cos(a) * 0.9);
    ctx.lineTo(x + Math.cos(a - 0.5) * l, y + Math.sin(a - 0.5) * l);
    ctx.lineTo(x + Math.sin(a) * 0.9, y - Math.cos(a) * 0.9);
    ctx.fill();
  }
}

export const HORDE_ART: Record<string, ArtDef> = {
  // ================================================================ units
  cub: {
    size: 16,
    frames: 4,
    draw(ctx, c, f) {
      curledCub(ctx, c, [0, 1, 0, -1][f], FUR.honey);
    },
  },
  cocoon: {
    size: 28,
    frames: 2,
    draw(ctx, c, f) {
      const s = f ? 1.05 : 1;
      ellipse(ctx, 1.5, 2, 8 * s, 9.5 * s, 0, 'rgba(0,0,0,0.3)');
      ellipse(ctx, 0, 0, 7.6 * s, 9.2 * s, 0, dome(ctx, 0, 0, 9.5, '#e8a32a', 0.5), WAX_D, 0.9);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, 7.6 * s, 9.2 * s, 0, 0, TAU);
      ctx.clip();
      ctx.globalAlpha = 0.35;
      combCells(ctx, 0, 0, 10, 11, 2.2, 7, WAX, 0, 0);
      ctx.globalAlpha = 1;
      // the sleeping cub inside
      const sil = rgba('#4a2306', 0.55);
      circle(ctx, 0, 1.8, 4.2 * s, sil);
      circle(ctx, 0, -3.4, 2.8 * s, sil);
      circle(ctx, -2.2, -5.2, 1.2 * s, sil);
      circle(ctx, 2.2, -5.2, 1.2 * s, sil);
      ctx.restore();
      glow(ctx, 0, 0, 7 * s, c.light, f ? 0.45 : 0.3);
      for (const sy of [-1, 1]) {
        ctx.strokeStyle = c.main;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(0, sy * 3.5, 7.2 * s, 2.2, 0, 0, Math.PI);
        ctx.stroke();
      }
      ellipse(ctx, -2.6, -4.5, 1.6, 2.6, -0.4, 'rgba(255,248,210,0.5)');
    },
  },
  forager: {
    size: 26,
    frames: 4,
    draw(ctx, c, f) {
      quadBear(ctx, f, 0.62, FUR.honey);
      line(ctx, 0.5, -4.2, 0.5, 4.2, c.main, 1.3);
      // pollen basket
      ellipse(ctx, -3, 0, 3.8, 3.3, 0, dome(ctx, -3, 0, 3.8, '#8f6432', 0.35), c.dark, 1);
      ctx.strokeStyle = 'rgba(50,25,5,0.5)';
      ctx.lineWidth = 0.5;
      for (const x of [-5, -3.5, -2, -0.5]) {
        ctx.beginPath();
        ctx.moveTo(x, -2.6);
        ctx.lineTo(x, 2.6);
        ctx.stroke();
      }
      for (const [x, y] of [[-3.8, -1], [-2.2, 1], [-3.2, 1.4], [-2, -1.4]]) circle(ctx, x, y, 1.1, dome(ctx, x, y, 1.1, '#ffd23a', 0.45));
    },
  },
  bumblebear: {
    size: 64,
    frames: 4,
    draw(ctx, c, f) {
      const flap = [1, 0.7, 0.4, 0.7][f];
      // stubby legs and team pollen sacs
      for (const sy of [-1, 1]) {
        ellipse(ctx, 7, sy * 13.5, 3, 2.4, 0, BEE_K);
        line(ctx, -6, sy * 12, -10, sy * 17, BEE_K, 2.2);
        sac(ctx, -10, sy * 18, 4.6, c);
      }
      // fuzzy striped body
      const bx = -2;
      const R = rnd(4);
      for (let i = 0; i < 44; i++) {
        const a = (i / 44) * TAU;
        const x = bx + Math.cos(a) * 15;
        const y = Math.sin(a) * 15;
        const band = Math.floor((x + 16) / 6.5) % 2 === 1;
        circle(ctx, x, y, 2 + R() * 0.8, band ? '#26201a' : '#e8b828');
      }
      circle(ctx, bx, 0, 15, dome(ctx, bx, 0, 15, '#f2c230', 0.35));
      ctx.save();
      ctx.beginPath();
      ctx.arc(bx, 0, 15.5, 0, TAU);
      ctx.clip();
      for (const x0 of [-15.5, -2.5]) {
        ctx.fillStyle = '#231c16';
        ctx.fillRect(bx + x0 + 3, -16, 6.5, 32);
      }
      ctx.fillStyle = rgba('#000000', 0.25);
      ctx.beginPath();
      ctx.arc(bx + 4, 4, 15, 0, TAU);
      ctx.arc(bx - 2, -2, 15, 0, TAU, true);
      ctx.fill();
      ctx.restore();
      circle(ctx, bx - 5, -6, 4, 'rgba(255,250,220,0.25)');
      // antennae
      for (const sy of [-1, 1]) {
        ctx.strokeStyle = BEE_K;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(15, sy * 3);
        ctx.quadraticCurveTo(21, sy * 4, 23, sy * 8);
        ctx.stroke();
        circle(ctx, 23, sy * 8, 1.4, BEE_K);
      }
      bearHead(ctx, 13.5, 6.2, { fur: '#2b2420', dark: '#151110', muzzle: '#e6b866' });
      // four flapping wings over the back
      for (const sy of [-1, 1]) {
        wing(ctx, 3, sy * 8, 16 * flap + 6, 10, sy * (Math.PI / 2 - 0.1), '#eaf6ff', 0.3);
        wing(ctx, -3, sy * 8, 12 * flap + 4, 7.5, sy * (Math.PI / 2 + 0.55), '#eaf6ff', 0.28);
      }
    },
  },
  scrapper: {
    size: 18,
    frames: 4,
    draw(ctx, c, f) {
      frontClaws(ctx, f, 0.45, 1.15, 1, 2.2, '#f4eee0');
      quadBear(ctx, f, 0.45, FUR.brown, { long: 1.15, shag: true });
      line(ctx, -3.4, 0, 1.6, 0, c.main, 1.3);
      for (const sy of [-1, 1]) line(ctx, -1.2, sy * 0.8, -2.4, sy * 2.2, c.main, 0.7);
    },
  },
  buzzbomb: {
    size: 30,
    frames: 4,
    draw(ctx, c, f) {
      ctx.save();
      ctx.translate(-4, 0);
      quadBear(ctx, f, 0.5, FUR.brown, { shag: true });
      ctx.restore();
      skep(ctx, 6.5, 0, 6.2, true, c.main);
      ellipse(ctx, 12, 0, 1.2, 1.8, 0, '#140a04');
      // arms hugging the hive
      for (const sy of [-1, 1]) {
        ctx.strokeStyle = FUR.brown.fur;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, sy * 3.4);
        ctx.quadraticCurveTo(5, sy * 7.5, 8.5, sy * 4.6);
        ctx.stroke();
        circle(ctx, 8.8, sy * 4.4, 1.3, FUR.brown.dark);
      }
    },
    overlay(ctx, _c, s) {
      const p = 0.5 + 0.5 * Math.sin(s.t * 7 + s.seed);
      glow(ctx, 6.5, 0, 9 + p * 3, HONEY, 0.22 + p * 0.25);
      orbitBees(ctx, 6.5, 0, 8, 2, s.t * 2, s.seed, 1);
    },
  },
  stinger: {
    size: 36,
    frames: 4,
    draw(ctx, c, f) {
      quadBear(ctx, f, 0.9, FUR.grizzly, { shag: true });
      // quiver of giant stingers
      for (const [y, l] of [[-4.5, 11], [-1.5, 13], [1.5, 12.5], [4.5, 10.5]] as [number, number][]) stingerSpike(ctx, -2, y * 0.8, -2 - l, y * 1.5, 1.3);
      ctx.save();
      ctx.translate(-4, 0);
      ctx.rotate(-0.15);
      rrect(ctx, -4, -4.5, 8, 9, 2, lit(ctx, -4, -4.5, 4, 4.5, '#7a4a22', 0.3), WOOD_D, 0.7);
      line(ctx, 0, -4.5, 0, 4.5, c.main, 1.6);
      ctx.restore();
    },
  },
  bombardier: {
    size: 46,
    frames: 4,
    draw(ctx, c, f) {
      const s = 1.15;
      quadBear(ctx, f, s, FUR.kodiak, { wide: 1.35, hump: true });
      for (const [x, y, r] of [[3, -6.5, 3.6], [3, 6.5, 3.6], [-5, -4.5, 4.6], [-5, 4.5, 4.6], [-11.5, 0, 3.8]] as [number, number, number][]) sac(ctx, x, y, r, c);
      // wide honey-dripping mouth
      const hx = headX(s);
      const r = 5 * s;
      ellipse(ctx, hx + r * 1.02, 0, r * 0.4, r * 0.62, 0, '#3a0d08', '#140404', 0.6);
      ellipse(ctx, hx + r * 1.1, 0, r * 0.2, r * 0.4, 0, rgba(HONEY, 0.9));
      ellipse(ctx, hx + r * 0.7, 0, r * 0.16, r * 0.2, 0, '#141010');
    },
    overlay(ctx, c, s) {
      glow(ctx, -3, 0, 13, c.light, 0.12 + 0.08 * Math.sin(s.t * 3 + s.seed));
    },
  },
  burrower: {
    size: 46,
    frames: 4,
    draw(ctx, c, f) {
      quadBear(ctx, f, 1.2, FUR.black, { wide: 1.15 });
      // bony back plates with spikes
      for (let i = 0; i < 4; i++) {
        const x = -10 + i * 4.6;
        const w = 6.2 - Math.abs(i - 1.5) * 0.7;
        for (const sy of [-1, 1]) poly(ctx, [x + 1, sy * w * 0.6, x - 4, sy * (w + 5), x - 1.5, sy * w * 0.4], BONE, tone(BONE, -0.55), 0.5);
        poly(ctx, [x + 3, 0, x, -w, x - 3, -w * 0.8, x - 2, 0, x - 3, w * 0.8, x, w], dome(ctx, x, 0, w, '#cbbd97', 0.35), c.main, 1);
        poly(ctx, [x + 1.5, 0, x - 4.5, -1.2, x - 4.5, 1.2], BONE, tone(BONE, -0.5), 0.5);
      }
    },
  },
  burrower_b: {
    size: 46,
    draw(ctx, c) {
      ellipse(ctx, 2, 3, 17, 15, 0, 'rgba(0,0,0,0.3)');
      spikes(ctx, 0, 0, 11, 9, 19, 23, BONE, 2.2);
      fillBlob(ctx, 0, 0, 15, 13.5, 21, dome(ctx, 0, 0, 15, EARTH, 0.35), '#22160c', 0.16);
      ctx.save();
      blob(ctx, 0, 0, 15, 13.5, 21, 0.16);
      ctx.clip();
      ctx.globalAlpha = 0.7;
      combCells(ctx, 5, -4, 6, 5, 2.4, 3, WAX, 0.3);
      ctx.globalAlpha = 1;
      ctx.restore();
      const R = rnd(9);
      for (let i = 0; i < 7; i++) circle(ctx, (R() - 0.5) * 22, (R() - 0.5) * 20, 1 + R() * 1.4, dome(ctx, 0, 0, 3, '#7a5c40', 0.3));
      for (const sy of [-1, 1]) {
        ellipse(ctx, -3, sy * 2.5, 1.6, 0.8, 0, c.light);
        glow(ctx, -3, sy * 2.5, 3.2, c.light, 0.6);
      }
    },
  },
  hornet: {
    size: 52,
    frames: 4,
    draw(ctx, c, f) {
      const flap = [1, 0.7, 0.45, 0.7][f];
      // striped stinger abdomen
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(-13, 0, 9, 5, 0, 0, TAU);
      ctx.fillStyle = dome(ctx, -13, 0, 9, BEE_Y, 0.4);
      ctx.fill();
      ctx.clip();
      ctx.fillStyle = BEE_K;
      for (const x of [-20, -15.5, -11]) ctx.fillRect(x, -6, 2.2, 12);
      ctx.restore();
      ellipse(ctx, -13, 0, 9, 5, 0, null, BEE_K, 0.7);
      poly(ctx, [-21.5, -1.4, -26, 0, -21.5, 1.4], BEE_K);
      ellipse(ctx, -4.2, 0, 1.8, 3.4, 0, c.main, tone(c.dark, -0.3), 0.6);
      // bear torso with dangling paws
      for (const sy of [-1, 1]) {
        circle(ctx, 4, sy * 5.6, 1.8, FUR.brown.dark);
        circle(ctx, -2, sy * 5, 1.6, FUR.brown.dark);
      }
      ellipse(ctx, 0.5, 0, 6.5, 5.4, 0, dome(ctx, 0.5, 0, 6.5, FUR.brown.fur, 0.3), rgba('#000000', 0.45), 0.6);
      bearHead(ctx, 7.5, 4.2, FUR.brown);
      // narrow wasp wings
      for (const sy of [-1, 1]) {
        wing(ctx, 1, sy * 3, 20 * flap + 3, 6, sy * (Math.PI / 2 + 0.55), '#ffcf7a', 0.4);
        wing(ctx, -1, sy * 3, 15 * flap + 2, 4.6, sy * (Math.PI / 2 + 0.95), '#ffcf7a', 0.36);
      }
    },
  },
  denmother: {
    size: 58,
    frames: 4,
    draw(ctx, c, f) {
      const s = 1.45;
      quadBear(ctx, f, s, FUR.grizzly, { hump: true });
      line(ctx, -2, -9.5, -2, 9.5, c.main, 2.4);
      line(ctx, -10, -8.5, -10, 8.5, c.main, 2.4);
      // the den on her back
      fillBlob(ctx, -6, 0, 10.5, 9, 31, dome(ctx, -6, 0, 10.5, '#7a5530', 0.35), WOOD_D, 0.1);
      ctx.save();
      blob(ctx, -6, 0, 10.5, 9, 31, 0.1);
      ctx.clip();
      combCells(ctx, -6, 0, 10, 9, 2.6, 33, WAX, 0.2, 0);
      ctx.fillStyle = 'rgba(40,20,0,0.25)';
      ctx.fillRect(-17, 2, 22, 10);
      ctx.restore();
      for (const [x, y, a] of [[-11, -4, -2.4], [-2, 4.5, 1.2], [-9, 5, 2.2], [-1, -4, -1]] as [number, number, number][]) {
        circle(ctx, x, y, 2.4, '#1c0e04', WOOD_D, 0.6);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        bearHead(ctx, 0.6, 1.3, FUR.honey);
        ctx.restore();
      }
    },
  },
  wildcub: {
    size: 18,
    frames: 4,
    draw(ctx, c, f) {
      const s = 0.42;
      shaggyTufts(ctx, 5, 3.4, -0.5, 16, FUR.black.fur, 5 + f);
      quadBear(ctx, f, s, FUR.black, { shag: true });
      for (const sy of [-1, 1]) line(ctx, -3, sy * 0.6, 0.5, sy * 1.6, c.main, 0.7);
      const hx = headX(s);
      const r = 5 * s;
      for (const sy of [-1, 1]) {
        glow(ctx, hx + r * 0.32, sy * r * 0.36, 2.6, c.light, 0.9);
        circle(ctx, hx + r * 0.32, sy * r * 0.36, 0.55, '#ffffff');
      }
    },
  },
  longtongue: {
    size: 58,
    frames: 4,
    draw(ctx, c, f) {
      const flap = [1, 0.7, 0.4, 0.7][f];
      const curl = [0, 1, 2, 1][f] * 0.6;
      const sun = FUR.sun;
      for (const sy of [-1, 1]) {
        ellipse(ctx, 5, sy * 6.2, 2.4, 2, 0, sun.dark);
        ellipse(ctx, -7, sy * 5.5, 2.4, 2, 0, sun.dark);
      }
      ellipse(ctx, -1, 0, 9, 6.6, 0, dome(ctx, -1, 0, 9, sun.fur, 0.35), rgba('#000000', 0.5), 0.6);
      // the sun bear's crescent, in team colour
      ctx.strokeStyle = c.main;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(1, 0, 4.4, -1.2, 1.2);
      ctx.stroke();
      circle(ctx, -9.5, 0, 1.4, sun.dark);
      // the tongue
      ctx.strokeStyle = '#d9667a';
      ctx.lineCap = 'round';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.bezierCurveTo(18, -1, 22, 2 + curl, 22.5, 6 + curl);
      ctx.bezierCurveTo(23, 9 + curl, 19, 10.5 + curl, 18, 8 + curl);
      ctx.bezierCurveTo(17.4, 6.5 + curl, 19.5, 5.6 + curl, 20, 7 + curl);
      ctx.stroke();
      ctx.strokeStyle = '#f39aa8';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(13, -0.4);
      ctx.bezierCurveTo(18, -1.2, 21.5, 1.6 + curl, 22, 5 + curl);
      ctx.stroke();
      bearHead(ctx, 7.5, 4.6, sun);
      // round bee wings
      for (const sy of [-1, 1]) {
        wing(ctx, 0, sy * 5.5, 15 * flap + 5, 10, sy * (Math.PI / 2 + 0.15), '#fff4d8', 0.3);
        wing(ctx, -4, sy * 5, 10 * flap + 4, 7, sy * (Math.PI / 2 + 0.75), '#fff4d8', 0.28);
      }
    },
  },
  cavetitan: {
    size: 116,
    frames: 4,
    draw(ctx, c, f) {
      const s = 2.8;
      const long = 1.1;
      const wide = 1.3;
      const L = 22 * s * long;
      const W = 13 * s * wide;
      const ph = [0, 1, 0, -1][f] * 2.2 * s;
      const cave = FUR.cave;
      // long pillar legs with huge claws
      for (const [px, sy, d] of [[L * 0.3, -1, ph], [L * 0.3, 1, -ph], [-L * 0.32, -1, -ph], [-L * 0.32, 1, ph]]) {
        const fx = px + d;
        const fy = sy * (W * 0.5 + 6);
        line(ctx, px * 0.8, sy * W * 0.3, fx, fy, tone(cave.fur, -0.15), 11);
        line(ctx, px * 0.8, sy * W * 0.3, fx, fy, rgba('#000000', 0.25), 3);
        for (const k of [-1.5, -0.5, 0.5, 1.5]) {
          ctx.strokeStyle = BONE;
          ctx.lineWidth = 1.8;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(fx + 4, fy + k * 2.4);
          ctx.quadraticCurveTo(fx + 11, fy + k * 2.6, fx + 13, fy + k * 3.4 + sy * 2);
          ctx.stroke();
        }
        ellipse(ctx, fx, fy, 6.8, 5.6, 0, dome(ctx, fx, fy, 6.8, '#3d2e22', 0.3), '#000', 0.6);
      }
      quadBear(ctx, f, s, cave, { long, wide, hump: true, shag: true });
      // honeycomb armor plates over the back
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(-6, 0, 24, 17, 0, 0, TAU);
      ctx.clip();
      combCells(ctx, -6, 0, 27, 20, 4.4, 61, WAX, 0.22, 0.05);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(-6, 0, 24, 17, 0, 0, TAU);
      ctx.strokeStyle = WAX_D;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      for (const [x, y] of [[-6, 0], [-12.6, -3.8], [0.6, 3.8], [-19.2, 0], [7.2, 0]]) {
        hexPath(ctx, x, y, 4);
        ctx.fillStyle = c.main;
        ctx.fill();
        ctx.strokeStyle = tone(c.dark, -0.4);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      spikes(ctx, 14, 0, 8, 5, 8, 63, BONE, 2);
      bearHead(ctx, headX(s, long), 5 * s, cave);
      // old scars
      line(ctx, headX(s, long) - 6, -9, headX(s, long) + 2, -3, rgba('#e8d2b0', 0.5), 1.2);
      line(ctx, headX(s, long) - 8, -6, headX(s, long), 0, rgba('#e8d2b0', 0.5), 1.2);
    },
  },
  swarmcaller: {
    size: 50,
    frames: 4,
    draw(ctx, c, f) {
      const s = 1.25;
      const sp = FUR.spectacled;
      // team-colour cape
      ellipse(ctx, -4, 0, 7.5, 11, 0, dome(ctx, -4, 0, 11, c.main, 0.35), tone(c.dark, -0.35), 0.7);
      for (const y of [-6, 0, 6]) line(ctx, -9, y, -11.5, y * 1.1, c.dark, 1);
      bipedBear(ctx, f, s, sp);
      // hive staff
      line(ctx, -5, 7.5, 15, 6, WOOD_D, 1.8);
      skep(ctx, 15, 6, 3.6, true);
      bipedArms(ctx, s, sp);
      // wax mask
      const hx = 1.6 * s;
      const r = 4 * s;
      ellipse(ctx, hx + r * 0.45, 0, r * 0.8, r * 0.9, 0, dome(ctx, hx + r * 0.45, 0, r, WAX_L, 0.4), WAX_D, 0.7);
      for (const sy of [-1, 1]) {
        ellipse(ctx, hx + r * 0.45, sy * r * 0.38, r * 0.14, r * 0.22, 0, '#1a0c02');
        glow(ctx, hx + r * 0.45, sy * r * 0.38, 2.2, c.light, 0.7);
      }
      line(ctx, hx + r * 0.85, -r * 0.3, hx + r * 0.85, r * 0.3, WAX_D, 0.6);
      poly(ctx, [hx + r * 1.15, -1, hx + r * 1.55, 0, hx + r * 1.15, 1], WAX_D);
    },
    overlay(ctx, _c, s) {
      orbitBees(ctx, 0, 0, 17, 6, s.t, s.seed, 1.5, 2.2);
    },
  },

  // ================================================================ structures
  hive: {
    pad: 10,
    draw(ctx, c, _f, def) {
      const tier = def.id === 'elderhive' ? 2 : def.id === 'royalhive' ? 1 : 0;
      combGround(ctx, 174, 168, 5);
      if (tier === 2) {
        // gnarled roots reaching across the comb
        const R = rnd(17);
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * TAU + R() * 0.3;
          ctx.strokeStyle = '#2e2015';
          ctx.lineCap = 'round';
          ctx.lineWidth = 7 - R() * 2;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 50, Math.sin(a) * 48);
          ctx.quadraticCurveTo(Math.cos(a + 0.25) * 66, Math.sin(a + 0.25) * 64, Math.cos(a + 0.1) * 80, Math.sin(a + 0.1) * 77);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(120,100,60,0.35)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      // tree stump
      const bark = tier === 2 ? '#3a2a1c' : BARK;
      fillBlob(ctx, 0, 2, 66, 62, 9, dome(ctx, 0, 2, 66, bark, 0.3), WOOD_D, 0.08);
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * TAU;
        line(ctx, Math.cos(a) * 56, 2 + Math.sin(a) * 52, Math.cos(a) * 64, 2 + Math.sin(a) * 60, 'rgba(15,8,2,0.45)', 1.2);
      }
      if (tier === 2) {
        for (const [x, y, r] of [[-50, -26, 9], [44, 34, 8], [-30, 48, 7], [52, -14, 6]] as [number, number, number][]) fillBlob(ctx, x, y, r, r * 0.8, x + 99, rgba('#6a7a2e', 0.75), '', 0.3);
      }
      // wild comb on the stump, then the great skep
      combBlob(ctx, 0, -2, 56, 52, 11, 5, WAX, 0.25, 0.1);
      drips(ctx, 0, -2, 54, 50, 9, 40);
      const skeps = [[38], [40, 27], [41, 30, 19]][tier];
      skeps.forEach((r, i) => {
        const y = -6 - i * 6;
        circle(ctx, 3, y + 5, r, 'rgba(0,0,0,0.35)');
        skep(ctx, 0, y, r, false, i === 0 ? c.main : undefined);
        if (i > 0) drips(ctx, 0, y, r * 0.96, r * 0.92, 5, 44 + i);
      });
      // entrance
      ellipse(ctx, 0, 22, 12, 6.5, 0, '#241004', WOOD_D, 1);
      ellipse(ctx, 0, 23, 7.5, 3.6, 0, rgba(HONEY, 0.6));
      // team honey sacs hanging around the rim
      for (const [x, y] of [[-46, -22], [46, -20], [-42, 30], [44, 28], [0, -50]]) sac(ctx, x, y, 7 + tier, c);
      if (tier >= 1) {
        // royal crown of golden comb points
        const cy = -6 - tier * 6;
        const n = tier === 2 ? 9 : 7;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU - Math.PI / 2;
          const r0 = 8 + tier * 2;
          const r1 = r0 + 7 + tier * 3;
          poly(ctx, [Math.cos(a - 0.22) * r0, cy + Math.sin(a - 0.22) * r0, Math.cos(a) * r1, cy + Math.sin(a) * r1, Math.cos(a + 0.22) * r0, cy + Math.sin(a + 0.22) * r0], dome(ctx, 0, cy, r1, WAX_L, 0.5), WAX_D, 0.8);
        }
        circle(ctx, 0, cy, 8 + tier * 2, dome(ctx, 0, cy, 10, WAX_L, 0.5), WAX_D, 1);
        circle(ctx, 0, cy, 5 + tier, dome(ctx, 0, cy, 6, c.main, 0.55), tone(c.dark, -0.4), 1);
      }
      if (tier === 2) {
        for (const [x, y, r] of [[-44, -6, 5], [42, 4, 4], [-30, 36, 4], [30, -36, 5]] as [number, number, number][]) {
          hexPath(ctx, x, y, r);
          ctx.fillStyle = dome(ctx, x, y, r, '#ffb02e', 0.6);
          ctx.fill();
          ctx.strokeStyle = '#6a3a04';
          ctx.stroke();
        }
      }
    },
    overlay(ctx, c, s, def) {
      const tier = def.id === 'elderhive' ? 2 : def.id === 'royalhive' ? 1 : 0;
      const p = 0.35 + 0.2 * Math.sin(s.t * 2 + s.seed);
      glow(ctx, 0, 23, 18, HONEY, p);
      if (tier === 2) glow(ctx, 0, -10, 46, '#ffb02e', 0.12 + 0.06 * Math.sin(s.t * 1.3));
      if (tier >= 1) glow(ctx, 0, -6 - tier * 6, 12, c.light, p * 0.8);
      orbitBees(ctx, 0, 4, 62, 4 + tier * 2, s.t * 0.7, s.seed, 2.2);
    },
  },
  nectartap: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 13);
      // log ring
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU;
        ctx.save();
        ctx.translate(Math.cos(a) * 28, Math.sin(a) * 27);
        ctx.rotate(a + Math.PI / 2);
        rrect(ctx, -9, -4, 18, 8, 3.5, lit(ctx, -9, -4, 9, 4, WOOD, 0.3), WOOD_D, 0.9);
        circle(ctx, 9, 0, 3.6, '#b98a55', WOOD_D, 0.6);
        circle(ctx, 9, 0, 1.6, null, 'rgba(60,30,10,0.5)', 0.5);
        ctx.restore();
      }
      // wax funnel and nectar pool
      circle(ctx, 0, 0, 20, dome(ctx, 0, 0, 20, WAX, 0.4), WAX_D, 1.2);
      drips(ctx, 0, 0, 19, 18, 7, 14);
      circle(ctx, 0, 0, 11, '#5a2c06');
      circle(ctx, 0, 0, 9, dome(ctx, -1, -1, 9, HONEY, 0.5));
      circle(ctx, -3, -3, 2, 'rgba(255,255,255,0.5)');
      // spigots to barrels
      for (const [x, y] of [[-36, -34], [36, 34]]) {
        line(ctx, x * 0.45, y * 0.45, x, y, WOOD_D, 3);
        circle(ctx, x, y, 8, dome(ctx, x, y, 8, '#8a5a2c', 0.35), WOOD_D, 1);
        circle(ctx, x, y, 6, null, c.main, 1.6);
        circle(ctx, x, y, 3, rgba(HONEY, 0.8));
      }
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 16, HONEY, 0.3 + 0.2 * Math.sin(s.t * 2.5 + s.seed));
    },
  },
  cubden: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 21);
      fillBlob(ctx, 0, 0, 38, 34, 22, dome(ctx, -4, -6, 40, '#7a5533', 0.35), WOOD_D, 0.1);
      combBlob(ctx, -4, -8, 24, 18, 24, 4, WAX, 0.25);
      drips(ctx, -4, -8, 23, 17, 7, 25);
      pawPrint(ctx, -4, -10, 9, c.main);
      // den mouths with cubs peeking out
      for (const [x, y, r, hr] of [[6, 18, 11, 4.4], [-22, 12, 7, 2.8], [26, 0, 6.5, 2.6]] as [number, number, number, number][]) {
        ellipse(ctx, x, y, r, r * 0.72, 0, '#1a0c04', WOOD_D, 1);
        ctx.save();
        ctx.translate(x, y + r * 0.15);
        ctx.rotate(Math.PI / 2);
        bearHead(ctx, 0, hr, FUR.honey);
        ctx.restore();
      }
      banner(ctx, 30, -22, c);
    },
  },
  honeycellar: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 31);
      // dug-in cellar frame and trapdoors
      rrect(ctx, -26, -22, 52, 42, 5, '#2e1a0b', WOOD_D, 1);
      rrect(ctx, -23, -19, 23, 36, 2, lit(ctx, -23, -19, 0, 17, '#8f6236', 0.25), WOOD_D, 0.8);
      rrect(ctx, 0, -19, 23, 36, 2, lit(ctx, 0, -19, 23, 17, '#8f6236', 0.25), WOOD_D, 0.8);
      for (const x of [-17, -11, -5, 6, 12, 18]) line(ctx, x, -18, x, 16, 'rgba(40,20,5,0.45)', 0.7);
      for (const y of [-12, 10]) line(ctx, -22, y, 22, y, '#4a3018', 2.4);
      pawPrint(ctx, 0, -1, 9, c.main);
      circle(ctx, -3, 4, 1.6, null, '#c9a46a', 1);
      circle(ctx, 3, 4, 1.6, null, '#c9a46a', 1);
      for (const [x, y, r] of [[-36, -26, 7], [-38, 4, 6], [-30, 30, 7], [34, -28, 6], [37, 2, 7], [30, 30, 6], [0, 32, 6]] as [number, number, number][]) honeyPot(ctx, x, y, r, c);
    },
  },
  thornstump: {
    pad: 6,
    turretSize: 58,
    draw(ctx) {
      combGround(ctx, 70, 68, 41);
      spikes(ctx, 0, 0, 20, 12, 9, 42, '#3a2414', 2);
      circle(ctx, 0, 0, 22, dome(ctx, 0, 0, 22, BARK, 0.35), WOOD_D, 1.2);
      circle(ctx, 0, 0, 17, dome(ctx, -3, -3, 17, '#b98a55', 0.25), '#5a3a1c', 0.8);
      for (const r of [5, 9, 13]) circle(ctx, 0.5, 0.5, r, null, 'rgba(90,50,20,0.5)', 0.7);
    },
    turret(ctx, c) {
      // barbed bramble spike
      poly(ctx, [-6, -5, 26, 0, -6, 5], dome(ctx, 6, 0, 18, '#5a3418', 0.35), WOOD_D, 1);
      for (let i = 0; i < 4; i++) {
        const x = -1 + i * 6;
        const w = 4.3 - i * 1;
        for (const sy of [-1, 1]) poly(ctx, [x, sy * w * 0.8, x - 3, sy * (w + 3.5), x + 2, sy * w * 0.6], BONE, tone(BONE, -0.5), 0.5);
      }
      poly(ctx, [20, -1.2, 27, 0, 20, 1.2], BONE);
      circle(ctx, -5, 0, 6.5, dome(ctx, -5, 0, 6.5, WOOD, 0.4), WOOD_D, 1);
      circle(ctx, -5, 0, 3.6, dome(ctx, -5, 0, 3.6, c.main, 0.5), tone(c.dark, -0.3), 0.6);
    },
  },
  stingtower: {
    pad: 6,
    turretSize: 48,
    draw(ctx) {
      combGround(ctx, 70, 68, 51);
      fillBlob(ctx, 0, 0, 22, 21, 52, dome(ctx, 0, 0, 22, WAX, 0.4), WAX_D, 0.12);
      drips(ctx, 0, 0, 21, 20, 6, 53);
    },
    turret(ctx, c) {
      poly(ctx, [6, -4.5, 18, -2.6, 18, 2.6, 6, 4.5], lit(ctx, 6, -4, 18, 4, WAX_L, 0.3), WAX_D, 0.8);
      ellipse(ctx, 18, 0, 1.4, 2.4, 0, '#1a0c02');
      skep(ctx, 0, 0, 11, true, c.main);
      circle(ctx, 0, 0, 3, BEE_K);
    },
    overlay(ctx, _c, s) {
      orbitBees(ctx, 0, 0, 19, 3, s.t, s.seed, 1.6, 2.4);
    },
  },
  apiary: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 61);
      beeBox(ctx, -36, -32, 28, 24, 2, c);
      beeBox(ctx, 6, -36, 28, 24, 3, c);
      beeBox(ctx, -14, -2, 28, 24, 3, c);
      beeBox(ctx, 18, 10, 24, 22, 1, c);
      beeBox(ctx, -40, 16, 22, 20, 1, c);
      skep(ctx, 34, -6, 8, false, c.main);
    },
    overlay(ctx, _c, s) {
      orbitBees(ctx, 0, -2, 34, 6, s.t * 0.9, s.seed, 1.8);
    },
  },
  stingerden: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 71);
      fillBlob(ctx, 0, 0, 30, 27, 72, dome(ctx, 0, 0, 30, '#6e4a2a', 0.35), WOOD_D, 0.1);
      const R = rnd(73);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.2 + R() * 0.2;
        const l = 38 + R() * 8;
        stingerSpike(ctx, Math.cos(a) * 14, Math.sin(a) * 13, Math.cos(a) * l, Math.sin(a) * l * 0.95, 4.2);
      }
      combBlob(ctx, 0, 0, 18, 16, 74, 3.6, WAX, 0.3);
      circle(ctx, 0, 2, 8, '#1a0c04', WOOD_D, 1);
      circle(ctx, 0, 2, 10, null, c.main, 2.4);
    },
  },
  burrowden: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 81, '#a8772a');
      fillBlob(ctx, 0, 0, 40, 36, 82, dome(ctx, 0, 0, 40, EARTH, 0.3), '#22160c', 0.14);
      const R = rnd(83);
      for (let i = 0; i < 14; i++) {
        const a = R() * TAU;
        const d = 26 + R() * 12;
        circle(ctx, Math.cos(a) * d, Math.sin(a) * d * 0.9, 2 + R() * 2.5, dome(ctx, 0, 0, 4, '#7a5c40', 0.3), '#2e1e10', 0.5);
      }
      const g = ctx.createRadialGradient(0, 2, 2, 0, 2, 24);
      g.addColorStop(0, '#050201');
      g.addColorStop(0.7, '#1e120a');
      g.addColorStop(1, '#3d2a1a');
      fillBlob(ctx, 0, 2, 24, 21, 84, g, '#140a04', 0.1);
      // bone spines ringing the pit, pointing inward
      for (let i = 0; i < 11; i++) {
        const a = (i / 11) * TAU;
        const bx = Math.cos(a) * 26;
        const by = 2 + Math.sin(a) * 23;
        const nx = -Math.sin(a) * 2.6;
        const ny = Math.cos(a) * 2.6;
        poly(ctx, [bx + nx, by + ny, Math.cos(a) * 13, 2 + Math.sin(a) * 11, bx - nx, by - ny], BONE, tone(BONE, -0.5), 0.6);
      }
      for (const sy of [-1, 1]) {
        ellipse(ctx, sy * 4, 3, 2, 1, 0, c.light);
        glow(ctx, sy * 4, 3, 4, c.light, 0.7);
      }
      sac(ctx, -38, -20, 5, c);
      sac(ctx, 38, 20, 5, c);
    },
  },
  hornetnest: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 91);
      // layered paper nest
      fillBlob(ctx, 2, 3, 38, 35, 92, 'rgba(0,0,0,0.35)', '', 0.1);
      fillBlob(ctx, 0, 0, 38, 35, 92, dome(ctx, 0, 0, 38, PAPER, 0.35), '#4a3e2c', 0.1);
      for (let i = 0; i < 7; i++) {
        const r = 34 - i * 4.6;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(-i * 0.8, -i * 0.8, r, r * 0.93, 0, 0, TAU);
        ctx.clip();
        ctx.strokeStyle = i % 3 === 1 ? rgba(c.main, 0.75) : i % 2 ? '#8e7f66' : '#d1c3a6';
        ctx.lineWidth = 3;
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * TAU + i * 0.4;
          ctx.beginPath();
          ctx.arc(-i * 0.8 + Math.cos(a) * r, -i * 0.8 + Math.sin(a) * r * 0.93, 6, 0, TAU);
          ctx.stroke();
        }
        ctx.restore();
        ctx.beginPath();
        ctx.ellipse(-i * 0.8, -i * 0.8, r, r * 0.93, 0, 0, TAU);
        ctx.strokeStyle = 'rgba(60,48,30,0.45)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      ellipse(ctx, 4, 20, 8, 5.5, 0, '#1a1008', '#3a2e1c', 1);
      ellipse(ctx, 4, 20.5, 4.5, 2.6, 0, rgba(HONEY, 0.45));
    },
    overlay(ctx, _c, s) {
      orbitBees(ctx, 0, 0, 42, 3, s.t * 1.2, s.seed, 2);
    },
  },
  swarmpit: {
    pad: 8,
    draw(ctx, c) {
      combGround(ctx, 104, 100, 101);
      combBlob(ctx, 0, 0, 36, 33, 102, 4.2, '#d39a30', 0.3);
      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 24);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.6, '#1c0e04');
      g.addColorStop(1, '#5a3410');
      fillBlob(ctx, 0, 0, 24, 22, 103, g, WAX_D, 0.08);
      drips(ctx, 0, -2, 23, 20, 8, 104, WAX);
      for (const [x, y] of [[-38, -32], [38, -32], [-38, 34], [38, 34]]) banner(ctx, x, y, c, 14);
    },
    overlay(ctx, c, s) {
      glow(ctx, 0, 0, 22, c.light, 0.15 + 0.08 * Math.sin(s.t * 1.7));
      orbitBees(ctx, 0, 0, 16, 5, s.t * 1.8, s.seed, 1.5);
      orbitBees(ctx, 0, 0, 28, 6, -s.t * 1.1, s.seed + 1, 1.8);
    },
  },
  titancavern: {
    pad: 10,
    draw(ctx, c) {
      combGround(ctx, 108, 104, 111);
      // rocky hill of boulders
      const R = rnd(112);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU + 0.3;
        const x = Math.cos(a) * 28;
        const y = Math.sin(a) * 24 - 4;
        const r = 12 + R() * 6;
        fillBlob(ctx, x, y, r, r * 0.85, 113 + i, dome(ctx, x, y, r, ['#7a6c5c', '#6e6050', '#857766'][i % 3], 0.35), '#2c241c', 0.18);
      }
      fillBlob(ctx, 0, -6, 30, 24, 130, dome(ctx, -4, -12, 30, '#8a7a66', 0.35), '#2c241c', 0.12);
      // giant claw marks
      for (const k of [-1, 0, 1]) line(ctx, -14 + k * 5, -24, -2 + k * 5, -8, 'rgba(20,14,8,0.7)', 2.2);
      // cave mouth glowing with honey
      fillBlob(ctx, 0, 16, 20, 13, 131, '#0e0804', '#2c241c', 0.12);
      ellipse(ctx, 0, 18, 11, 6, 0, rgba(HONEY, 0.45));
      ctx.save();
      blob(ctx, 0, 16, 20, 13, 131, 0.12);
      ctx.clip();
      combCells(ctx, 0, 8, 20, 6, 3, 132, WAX, 0.5, 0);
      ctx.restore();
      // bones by the entrance
      for (const [x, y, a] of [[-28, 34, 0.4], [26, 36, -0.5]]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        line(ctx, -7, 0, 7, 0, BONE, 2.4);
        for (const sx of [-7, 7]) for (const sy of [-1, 1]) circle(ctx, sx, sy * 1.4, 1.6, BONE);
        ctx.restore();
      }
      // team hide banner draped over the top
      poly(ctx, [-12, -32, 12, -32, 10, -20, 4, -16, 0, -20, -4, -16, -10, -20], c.main, tone(c.dark, -0.35), 1);
      pawPrint(ctx, 0, -26, 4.5, tone(c.dark, -0.3));
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 16, 18, HONEY, 0.25 + 0.15 * Math.sin(s.t * 1.5 + s.seed));
    },
  },
};
