// Starborn art: mystic polar, spirit, moon and panda bears who draw on starlight. Ivory fur,
// gold armor and gold-and-ivory star temples, cyan and aurora-green glows over deep night
// blue; team colour on gems and trims.

import type { ArtDef, TeamPal } from './index.ts';
import { FUR, bearHead, bipedArms, bipedBear, pawPrint, quadBear, type Fur } from './bear.ts';
import { circle, dome, ellipse, footShadow, glow, line, lit, poly, rgba, rrect, tone, type Ctx, TAU } from './kit.ts';

const GOLD = '#d2ae5b';
const GOLD_D = '#7d5f24';
const IVORY = '#efe6cc';
const NIGHT = '#1c2450';
const CYAN = '#74e8ff';
const AURORA = '#7dffc0';
const STAR = '#fff4c2';
const VIOLET = '#b07bff';

const SHADOW: Fur = { fur: '#221d2a', dark: '#0c0a10', muzzle: '#3a3344', nose: '#000000' };

function gem(ctx: Ctx, x: number, y: number, r: number, c: TeamPal): void {
  poly(ctx, [x, y - r, x + r * 0.8, y, x, y + r, x - r * 0.8, y], dome(ctx, x, y, r, c.light, 0.5), tone(c.dark, -0.3), 0.6);
  circle(ctx, x - r * 0.2, y - r * 0.3, r * 0.22, 'rgba(255,255,255,0.8)');
}

/** n-pointed star polygon. */
function star(ctx: Ctx, x: number, y: number, r: number, fill: string | CanvasGradient, n = 4, inner = 0.38, rot = -Math.PI / 2, stroke?: string): void {
  const pts: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i / (n * 2)) * TAU;
    const k = i % 2 ? r * inner : r;
    pts.push(x + Math.cos(a) * k, y + Math.sin(a) * k);
  }
  poly(ctx, pts, fill, stroke, 0.6);
}

/** Faint lines between points, then a bright star on each. */
function constellation(ctx: Ctx, pts: number[][], links: number[][], col: string, r: number, lw = 0.7, a = 0.55): void {
  for (const [i, j] of links) line(ctx, pts[i][0], pts[i][1], pts[j][0], pts[j][1], rgba(col, a), lw);
  for (const p of pts) {
    circle(ctx, p[0], p[1], r * 1.6, rgba(col, 0.25));
    star(ctx, p[0], p[1], r * 1.5, STAR, 4, 0.3);
    circle(ctx, p[0], p[1], r * 0.55, '#ffffff');
  }
}

/** Crescent: a disc with an offset disc cut away. */
function crescent(ctx: Ctx, x: number, y: number, r: number, dx: number, dy: number, fill: string | CanvasGradient): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(x - r - 1, y - r - 1, r * 2 + 2, r * 2 + 2);
  ctx.arc(x + dx, y + dy, r * 0.86, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill('evenodd');
  ctx.restore();
}

function lightBlade(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, col: string, w: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  line(ctx, x0, y0, x1, y1, rgba(col, 0.45), w * 2.6);
  line(ctx, x0, y0, x1, y1, '#eafff6', w);
  ctx.restore();
}

/** Front-facing carved bear face, for emblems on temples. */
function bearFace(ctx: Ctx, x: number, y: number, r: number, col: string, deep: string): void {
  for (const s of [-1, 1]) {
    circle(ctx, x + s * r * 0.72, y - r * 0.72, r * 0.4, dome(ctx, x + s * r * 0.72, y - r * 0.72, r * 0.4, col, 0.4), deep, 0.6);
    circle(ctx, x + s * r * 0.72, y - r * 0.72, r * 0.2, deep);
  }
  circle(ctx, x, y, r, dome(ctx, x, y, r, col, 0.4), deep, 0.8);
  ellipse(ctx, x, y + r * 0.38, r * 0.48, r * 0.36, 0, tone(col, 0.25), deep, 0.5);
  ellipse(ctx, x, y + r * 0.26, r * 0.18, r * 0.12, 0, deep);
  for (const s of [-1, 1]) circle(ctx, x + s * r * 0.38, y - r * 0.12, r * 0.11, deep);
}

function hexPlatform(ctx: Ctx, r: number, col: string): void {
  const pts: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  poly(ctx, pts, lit(ctx, -r, -r, r, r, col, 0.3), GOLD_D, 1.2);
}

function plinth(ctx: Ctx, w: number, h: number): void {
  footShadow(ctx, w - 8, h - 8, 4);
  rrect(ctx, -w / 2 + 4, -h / 2 + 6, w - 8, h - 10, 8, tone(IVORY, -0.55));
  rrect(ctx, -w / 2 + 4, -h / 2 + 4, w - 8, h - 12, 8, lit(ctx, -w / 2, -h / 2, w / 2, h / 2, IVORY, 0.25), GOLD_D, 1.2);
}

/** Night-blue inlay with scattered tiny stars. */
function nightInlay(ctx: Ctx, x: number, y: number, r: number, seed: number): void {
  circle(ctx, x, y, r, dome(ctx, x, y, r, NIGHT, 0.35), GOLD_D, 1.2);
  let s = seed;
  for (let i = 0; i < Math.round(r / 2); i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const a = (s / 4294967296) * TAU;
    s = (s * 1664525 + 1013904223) >>> 0;
    const d = Math.sqrt(s / 4294967296) * r * 0.85;
    circle(ctx, x + Math.cos(a) * d, y + Math.sin(a) * d, i % 4 ? 0.5 : 0.9, rgba(STAR, 0.85));
  }
}

function seerDisc(ctx: Ctx, c: TeamPal, lance: boolean): void {
  circle(ctx, 0, 0, 14, dome(ctx, 0, 0, 14, GOLD, 0.4), GOLD_D, 1);
  circle(ctx, 0, 0, 11, dome(ctx, 0, 0, 11, IVORY, 0.3), GOLD_D, 0.8);
  star(ctx, 0, 0, 10.5, rgba(GOLD, 0.6), 8, 0.55, 0);
  circle(ctx, 0, 0, 11, null, c.main, 1.2);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    gem(ctx, Math.cos(a) * 12.5, Math.sin(a) * 12.5, 1.8, c);
  }
  rrect(ctx, 11, -2.2, 6, 4.4, 1.5, lit(ctx, 11, -2, 17, 2, GOLD, 0.4), GOLD_D, 0.6);
  circle(ctx, 17, 0, 2, lance ? '#ffffff' : tone(CYAN, -0.4), GOLD_D, 0.5);
  bipedBear(ctx, 0, 0.9, FUR.spectacled);
  // glowing spectacles
  const hx = 1.6 * 0.9;
  const r = 4 * 0.9;
  for (const s of [-1, 1]) circle(ctx, hx + r * 0.32, s * r * 0.38, r * 0.3, rgba(CYAN, 0.55), GOLD, 0.6);
  line(ctx, hx + r * 0.32, -r * 0.1, hx + r * 0.32, r * 0.1, GOLD, 0.5);
}

export const STARBORN_ART: Record<string, ArtDef> = {
  // ================================================================ units
  snowcub: {
    size: 26,
    frames: 4,
    draw(ctx, _c, f) {
      quadBear(ctx, f, 0.55, FUR.polar);
      star(ctx, 5.3, 0, 1.7, STAR, 4, 0.35, -Math.PI / 2, GOLD_D);
    },
    overlay(ctx, c, s) {
      glow(ctx, 5.3, 0, 4, STAR, 0.5);
      const y = -8 + Math.sin(s.t * 3 + s.seed) * 0.8;
      glow(ctx, -3, y, 4, CYAN, 0.5);
      poly(ctx, [-3, y - 2.6, -1.4, y, -3, y + 2.6, -4.6, y], rgba('#d8fbff', 0.95), c.main, 0.6);
    },
  },
  spiritbear: {
    size: 40,
    frames: 4,
    draw(ctx, c, f) {
      const s = 1.15;
      for (const sy of [-1, 1]) {
        for (const k of [-1.2, 0, 1.2]) lightBlade(ctx, 6, sy * 4.1 + k, 16, sy * (5.5 + k * 1.6), AURORA, 0.8);
      }
      bipedBear(ctx, f, s, FUR.spirit);
      for (const sy of [-1, 1]) {
        ellipse(ctx, -2, sy * 6.4, 4.2, 3.2, 0, dome(ctx, -2, sy * 6.4, 4.2, GOLD, 0.5), GOLD_D, 0.7);
        ellipse(ctx, -3, sy * 8, 2.8, 1.1, 0, c.main);
        circle(ctx, -1, sy * 6.2, 0.9, c.light);
      }
    },
    overlay(ctx, _c, s) {
      const a = s.working ? 0.7 : 0.3;
      for (const sy of [-1, 1]) glow(ctx, 14, sy * 5.5, 6, AURORA, a);
    },
  },
  moonbear: {
    size: 50,
    frames: 4,
    draw(ctx, c, f) {
      quadBear(ctx, f, 1.25, FUR.moon);
      crescent(ctx, -7, 0, 5.5, 2.6, 0, '#f4f2ff');
      // gold yoke with twin moon-orb emitters
      ctx.strokeStyle = GOLD_D;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(-1, 0, 9, -1.1, 1.1);
      ctx.stroke();
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      for (const sy of [-1, 1]) {
        circle(ctx, 4, sy * 8, 3, dome(ctx, 4, sy * 8, 3, GOLD, 0.5), GOLD_D, 0.6);
        circle(ctx, 4.5, sy * 8, 1.8, dome(ctx, 4.5, sy * 8, 1.8, '#eef6ff', 0.4));
      }
      gem(ctx, 7.5, 0, 1.8, c);
    },
    overlay(ctx, _c, s) {
      glow(ctx, -7, 0, 8, '#d8e4ff', 0.25);
      for (const sy of [-1, 1]) glow(ctx, 4.5, sy * 8, 6, '#e8f0ff', s.working ? 0.9 : 0.4);
    },
  },
  glacierbear: {
    size: 40,
    frames: 4,
    draw(ctx, c, f) {
      bipedBear(ctx, f, 1, FUR.glacier);
      line(ctx, 8, -11, 8, 11, GOLD_D, 2);
      line(ctx, 8, -11, 8, 11, GOLD, 1);
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(7, sy * 10);
        ctx.quadraticCurveTo(9, sy * 18, 17, sy * 14);
        ctx.quadraticCurveTo(11, sy * 13.5, 9.5, sy * 9);
        ctx.closePath();
        ctx.fillStyle = lit(ctx, 7, sy * 9, 17, sy * 17, '#bff4ff', 0.35);
        ctx.fill();
        ctx.strokeStyle = '#2b6f86';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
      gem(ctx, 8, 0, 1.6, c);
      bipedArms(ctx, 1, FUR.glacier, 1.54);
    },
    overlay(ctx, _c, s) {
      for (const sy of [-1, 1]) glow(ctx, 12, sy * 13, 5, CYAN, s.working ? 0.7 : 0.25);
    },
  },
  pandasage: {
    size: 40,
    draw(ctx, c) {
      const f = FUR.panda;
      // robe and crossed legs
      circle(ctx, -1.5, 0, 8.5, dome(ctx, -1.5, 0, 8.5, c.main, 0.45), tone(c.dark, -0.3), 0.8);
      circle(ctx, -1.5, 0, 8.5, null, GOLD, 1);
      ellipse(ctx, 4.5, -2.5, 4.4, 2.1, 0.5, f.dark);
      ellipse(ctx, 4.5, 2.5, 4.4, 2.1, -0.5, f.dark);
      for (const sy of [-1, 1]) {
        line(ctx, -1, sy * 6.5, 5, sy * 1.5, f.dark, 3);
        circle(ctx, 5.5, sy * 1.2, 1.6, f.dark);
      }
      rrect(ctx, -7, -1, 7, 2, 1, GOLD_D);
      bearHead(ctx, 0, 4.4, f);
      for (const sy of [-1, 1]) {
        ellipse(ctx, 1.4, sy * 1.6, 1.3, 0.95, sy * 0.5, f.dark);
        circle(ctx, 1.6, sy * 1.6, 0.4, '#ffffff');
      }
    },
    overlay(ctx, c, s) {
      glow(ctx, 0, 0, 14, c.light, 0.15 + 0.08 * Math.sin(s.t * 3 + s.seed));
      for (let i = 0; i < 3; i++) {
        const a = s.t * 1.6 + s.seed + (i / 3) * TAU;
        const x = Math.cos(a) * 12;
        const y = Math.sin(a) * 12;
        glow(ctx, x, y, 4.5, i === 1 ? AURORA : CYAN, 0.8);
        circle(ctx, x, y, 1.6, '#f4ffff');
      }
    },
  },
  shadowpaw: {
    size: 40,
    frames: 4,
    draw(ctx, _c, f) {
      // smoky cloak trailing behind
      const w = [0, 1, 0, -1][f % 4];
      ctx.fillStyle = rgba('#140f1c', 0.85);
      ctx.beginPath();
      ctx.moveTo(2, -8);
      ctx.quadraticCurveTo(-8, -12, -14, -8 + w);
      ctx.quadraticCurveTo(-11, -4, -17, -1 - w);
      ctx.quadraticCurveTo(-11, 1, -16, 6 + w);
      ctx.quadraticCurveTo(-9, 7, -12, 11 - w);
      ctx.quadraticCurveTo(-4, 12, 2, 8);
      ctx.closePath();
      ctx.fill();
      bipedBear(ctx, f, 1, SHADOW);
      ellipse(ctx, -3, 0, 4.5, 6.5, 0, rgba('#2c2238', 0.8));
      for (const sy of [-1, 1]) {
        circle(ctx, 2.9, sy * 1.45, 0.6, VIOLET);
        for (const k of [-1, 0, 1]) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = rgba(VIOLET, 0.85);
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(5.5, sy * (3.6 + k * 0.9));
          ctx.quadraticCurveTo(12, sy * (4 + k * 1.2), 13 + k, sy * (10 + k * 1.4));
          ctx.stroke();
          ctx.restore();
        }
      }
    },
    overlay(ctx, _c, s) {
      if (s.working) for (const sy of [-1, 1]) glow(ctx, 11, sy * 7, 6, VIOLET, 0.6);
    },
  },
  littledipper: {
    size: 30,
    draw(ctx) {
      ellipse(ctx, -1, 0, 8, 5.5, 0, rgba(NIGHT, 0.45));
      circle(ctx, 6, 0, 3.6, rgba(NIGHT, 0.45));
      const pts = [[9, 0], [6, 0], [4.5, -3.5], [4.5, 3.5], [1, -4.5], [1, 4.5], [3.5, -8], [3.5, 8], [-6, -4], [-6, 4], [-5, -8], [-5, 8], [-9.5, 0]];
      const links = [[0, 1], [1, 2], [1, 3], [1, 4], [1, 5], [4, 6], [5, 7], [4, 8], [5, 9], [8, 10], [9, 11], [8, 12], [9, 12]];
      constellation(ctx, pts, links, '#bfe6ff', 0.75, 0.6, 0.5);
    },
    overlay(ctx, _c, s) {
      for (const [x, y, k] of [[6, 0, 0], [-6, -4, 1], [1, 4.5, 2], [-9.5, 0, 3]]) {
        glow(ctx, x, y, 3.5, '#cfeaff', 0.35 + 0.3 * Math.sin(s.t * 4 + k * 1.7 + s.seed));
      }
    },
  },
  floebear: {
    size: 60,
    draw(ctx, c) {
      poly(ctx, [-20, -6, -16, -13, -4, -15, 8, -13, 17, -9, 21, -1, 18, 8, 9, 14, -4, 15, -15, 12, -21, 5], rgba(tone(CYAN, -0.3), 0.9));
      poly(ctx, [-20, -7, -16, -14, -4, -16, 8, -14, 17, -10, 21, -2, 18, 7, 9, 13, -4, 14, -15, 11, -21, 4], lit(ctx, -20, -16, 20, 14, '#eaf8ff', 0.2), '#7bb4c8', 1);
      ctx.strokeStyle = rgba('#5aa6c4', 0.6);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-8, -15);
      ctx.lineTo(-3, -6);
      ctx.lineTo(4, -4);
      ctx.lineTo(9, 6);
      ctx.moveTo(-3, -6);
      ctx.lineTo(-10, 4);
      ctx.moveTo(4, -4);
      ctx.lineTo(16, -6);
      ctx.stroke();
      for (const [x, y, r] of [[6, 6, 3], [10, -5, 2.4], [-2, 9, 2]]) circle(ctx, x, y, r, dome(ctx, x, y, r, '#ffffff', 0.25));
      // rudder and tiller at the stern
      rrect(ctx, -25, -1.5, 6, 3, 1, GOLD_D);
      line(ctx, -21, 0, -11, 3, GOLD_D, 1.6);
      ctx.save();
      ctx.translate(-12, 0);
      bipedBear(ctx, 0, 0.8, FUR.polar);
      ctx.restore();
      // team banner at the bow
      circle(ctx, 12, -9, 1.6, GOLD, GOLD_D, 0.5);
      ctx.fillStyle = c.main;
      ctx.beginPath();
      ctx.moveTo(12, -9);
      ctx.quadraticCurveTo(6, -13, 0, -11);
      ctx.quadraticCurveTo(5, -9, 2, -6);
      ctx.quadraticCurveTo(7, -7, 12, -7.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = c.dark;
      ctx.lineWidth = 0.5;
      ctx.stroke();
      star(ctx, 6.5, -9.5, 1.4, STAR, 4, 0.35);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 22, CYAN, 0.16 + 0.06 * Math.sin(s.t * 2 + s.seed));
    },
  },
  snowballer: {
    size: 56,
    frames: 4,
    draw(ctx, c, f) {
      ctx.save();
      ctx.translate(-8, 0);
      quadBear(ctx, f, 1.05, FUR.polar);
      ctx.restore();
      const x = 15;
      const r = 10;
      circle(ctx, x, 0, r, dome(ctx, x, 0, r, '#f4fbff', 0.35), '#7bb4c8', 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, 0, r, 0, TAU);
      ctx.clip();
      ctx.translate(x, 0);
      ctx.rotate(f * 0.6);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        line(ctx, Math.cos(a) * 2, Math.sin(a) * 2, Math.cos(a + 0.6) * 9, Math.sin(a + 0.6) * 9, rgba(CYAN, 0.55), 1);
        star(ctx, Math.cos(a + 1.2) * 6, Math.sin(a + 1.2) * 6, 1.3, STAR, 4, 0.35);
      }
      ctx.restore();
      circle(ctx, x, 0, 3, dome(ctx, x, 0, 3, c.light, 0.5));
      star(ctx, x, 0, 4, rgba('#ffffff', 0.9), 4, 0.3);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 15, 0, 16, CYAN, 0.28 + 0.12 * Math.sin(s.t * 5 + s.seed));
      glow(ctx, 15, 0, 6, '#ffffff', 0.5);
    },
  },
  polarcolossus: {
    size: 104,
    frames: 4,
    draw(ctx, c, f) {
      const s = 2.4;
      quadBear(ctx, f, s, FUR.polar);
      // starmetal back plates
      ellipse(ctx, -8, 0, 17, 9.5, 0, lit(ctx, -25, -10, 9, 10, GOLD, 0.4), GOLD_D, 1.2);
      ellipse(ctx, -8, 0, 12, 6, 0, null, rgba('#fff0b0', 0.5), 0.8);
      for (const x of [-18, 2]) line(ctx, x, -8, x, 8, GOLD_D, 1);
      rrect(ctx, -24, -1.8, 32, 3.6, 1.8, c.main, tone(c.dark, -0.3), 0.7);
      for (const x of [-14, -2]) gem(ctx, x, 0, 2.8, c);
      star(ctx, -8, 0, 4.5, STAR, 4, 0.3, -Math.PI / 2, GOLD_D);
      // pauldrons
      for (const sy of [-1, 1]) {
        ellipse(ctx, 12, sy * 11.5, 6.5, 4.5, sy * 0.3, dome(ctx, 12, sy * 11.5, 6.5, GOLD, 0.5), GOLD_D, 1);
        ellipse(ctx, 10.5, sy * 14.5, 4, 1.3, sy * 0.3, c.main);
      }
      // helm over the brow with beam emitters
      const hx = 22 * s * 0.48;
      const hr = 5 * s;
      ctx.beginPath();
      ctx.arc(hx, 0, hr + 0.6, Math.PI * 0.55, Math.PI * 1.45);
      ctx.lineTo(hx + hr * 0.3, -hr * 0.55);
      ctx.lineTo(hx + hr * 0.3, hr * 0.55);
      ctx.closePath();
      ctx.fillStyle = lit(ctx, hx - hr, -hr, hx + hr, hr, GOLD, 0.45);
      ctx.fill();
      ctx.strokeStyle = GOLD_D;
      ctx.lineWidth = 1;
      ctx.stroke();
      for (const sy of [-1, 1]) {
        circle(ctx, hx - hr * 0.45, sy * hr * 0.78, hr * 0.3, dome(ctx, hx - hr * 0.45, sy * hr * 0.78, hr * 0.3, GOLD, 0.5), GOLD_D, 0.6);
        circle(ctx, hx + hr * 0.32, sy * hr * 0.36, 1.7, '#bff6ff', GOLD_D, 0.8);
      }
      circle(ctx, hx - hr * 0.1, 0, 2.6, '#e8fdff', GOLD_D, 1);
      gem(ctx, hx - hr * 0.6, 0, 2.2, c);
    },
    overlay(ctx, _c, s) {
      const hx = 22 * 2.4 * 0.48;
      const hr = 12;
      const a = s.working ? 1 : 0.35 + 0.1 * Math.sin(s.t * 3 + s.seed);
      for (const sy of [-1, 1]) glow(ctx, hx + hr * 0.32, sy * hr * 0.36, s.working ? 9 : 5, CYAN, a);
      glow(ctx, hx - hr * 0.1, 0, s.working ? 8 : 5, '#e8fdff', a * 0.8);
      glow(ctx, -8, 0, 8, STAR, 0.4);
    },
  },
  starwing: {
    size: 56,
    draw(ctx, c) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const sy of [-1, 1]) {
        const g = ctx.createLinearGradient(0, 0, 0, sy * 25);
        g.addColorStop(0, rgba('#ffffff', 0.9));
        g.addColorStop(0.5, rgba(CYAN, 0.7));
        g.addColorStop(1, rgba(AURORA, 0.45));
        ctx.fillStyle = g;
        ctx.strokeStyle = rgba('#e8fdff', 0.9);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(4, sy * 3);
        ctx.quadraticCurveTo(10, sy * 20, -9, sy * 26);
        ctx.quadraticCurveTo(-1, sy * 15, -7, sy * 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        for (const k of [0.35, 0.6, 0.85]) line(ctx, -2, sy * 5, 2 - k * 10, sy * (5 + k * 19), rgba('#ffffff', 0.5), 0.6);
      }
      ctx.restore();
      for (const sy of [-1, 1]) gem(ctx, -8.5, sy * 25, 1.8, c);
      bipedBear(ctx, 0, 0.9, FUR.spirit);
      for (const sy of [-1, 1]) ellipse(ctx, -1.5, sy * 5, 2.6, 2, 0, dome(ctx, -1.5, sy * 5, 2.6, GOLD, 0.5), GOLD_D, 0.5);
      gem(ctx, -4, 0, 1.8, c);
    },
    overlay(ctx, _c, s) {
      const a = 0.25 + 0.12 * Math.sin(s.t * 4 + s.seed);
      for (const sy of [-1, 1]) glow(ctx, -1, sy * 15, 12, CYAN, a);
    },
  },
  seer: {
    size: 44,
    draw(ctx, c) {
      seerDisc(ctx, c, false);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 16, CYAN, 0.12 + 0.06 * Math.sin(s.t * 2 + s.seed));
      for (const sy of [-1, 1]) glow(ctx, 2.6, sy * 1.4, 3, CYAN, 0.6);
    },
  },
  seer_b: {
    size: 44,
    draw(ctx, c) {
      seerDisc(ctx, c, true);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 16, '#ffe39a', 0.15);
      for (const sy of [-1, 1]) glow(ctx, 2.6, sy * 1.4, 3, CYAN, 0.7);
      glow(ctx, 17, 0, s.working ? 10 : 7, '#fff2c0', 0.9);
    },
  },
  greatbear: {
    size: 124,
    draw(ctx) {
      const body = () => {
        ctx.beginPath();
        ctx.ellipse(-6, 0, 28, 19, 0, 0, TAU);
        ctx.moveTo(26, 0);
        ctx.ellipse(20, 0, 6, 9, 0, 0, TAU);
        ctx.moveTo(42, 0);
        ctx.arc(30, 0, 12, 0, TAU);
        ctx.moveTo(48, 0);
        ctx.ellipse(41, 0, 7, 6, 0, 0, TAU);
        for (const sy of [-1, 1]) {
          ctx.moveTo(29, sy * 11);
          ctx.arc(24, sy * 11, 5, 0, TAU);
          ctx.moveTo(23, sy * 17);
          ctx.ellipse(15, sy * 17, 8, 7, 0, 0, TAU);
          ctx.moveTo(24, sy * 23);
          ctx.ellipse(18, sy * 23, 6, 4.5, 0, 0, TAU);
          ctx.moveTo(-11, sy * 16);
          ctx.ellipse(-19, sy * 16, 8, 7, 0, 0, TAU);
          ctx.moveTo(-14, sy * 23);
          ctx.ellipse(-20, sy * 23, 6, 4.5, 0, 0, TAU);
        }
        ctx.moveTo(-31, 0);
        ctx.arc(-35, 0, 4, 0, TAU);
      };
      body();
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      body();
      ctx.fill();
      ctx.restore();
      body();
      const g = ctx.createRadialGradient(-6, -6, 4, 0, 0, 48);
      g.addColorStop(0, rgba('#3a4fa8', 0.7));
      g.addColorStop(1, rgba(NIGHT, 0.55));
      ctx.fillStyle = g;
      ctx.fill();
      let r = 99;
      for (let i = 0; i < 40; i++) {
        r = (r * 1664525 + 1013904223) >>> 0;
        const x = -32 + (r / 4294967296) * 74;
        r = (r * 1664525 + 1013904223) >>> 0;
        const y = ((r / 4294967296) - 0.5) * 36;
        circle(ctx, x, y, i % 5 ? 0.45 : 0.8, rgba(STAR, 0.7));
      }
      // minor stars on head and paws
      const minor = [[44, 0], [30, 0], [24, -11], [24, 11], [18, -23], [18, 23], [-20, -23], [-20, 23]];
      constellation(ctx, minor, [[0, 1], [1, 2], [1, 3]], '#cfe0ff', 0.9, 0.6, 0.35);
      // the seven stars of the dipper along back and tail
      const dip = [[-52, 8], [-41, 4], [-29, 2], [-17, -2], [1, -5], [2, 11], [-15, 10]];
      constellation(ctx, dip, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]], '#ffe39a', 1.6, 1.1, 0.7);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 50, '#4a62d0', 0.12 + 0.05 * Math.sin(s.t * 1.5 + s.seed));
      const dip = [[-52, 8], [-41, 4], [-29, 2], [-17, -2], [1, -5], [2, 11], [-15, 10]];
      for (let i = 0; i < dip.length; i++) glow(ctx, dip[i][0], dip[i][1], 7, STAR, 0.45 + 0.3 * Math.sin(s.t * 3 + i * 1.3));
      if (s.working) glow(ctx, 44, 0, 12, '#ffe39a', 0.7);
    },
  },

  // ================================================================ structures
  startemple: {
    pad: 8,
    draw(ctx, c) {
      plinth(ctx, 164, 162);
      hexPlatform(ctx, 66, '#e5dcc0');
      hexPlatform(ctx, 50, '#d9c79a');
      // constellation ring etched in the floor
      const ring: number[][] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        ring.push([Math.cos(a) * 40, Math.sin(a) * 40]);
      }
      constellation(ctx, ring, ring.map((_, i) => [i, (i + 1) % 8]), GOLD_D, 0.9, 0.8, 0.6);
      // four pylons
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        const x = Math.cos(a) * 54;
        const y = Math.sin(a) * 54;
        circle(ctx, x, y, 10, dome(ctx, x, y, 10, GOLD, 0.5), GOLD_D, 1);
        star(ctx, x, y, 7, IVORY, 4, 0.4, -Math.PI / 2, GOLD_D);
        gem(ctx, x, y, 3.5, c);
      }
      nightInlay(ctx, 0, 0, 30, 3);
      circle(ctx, 0, 0, 30, null, c.main, 3);
      bearFace(ctx, 0, 3, 15, GOLD, GOLD_D);
      star(ctx, 0, -1, 5, '#bff6ff', 4, 0.4, -Math.PI / 2, '#2a7a8c');
      for (const [x, y] of [[0, -62], [0, 62], [-62, 0], [62, 0]]) pawPrint(ctx, x, y, 6, rgba(GOLD_D, 0.85));
    },
    overlay(ctx, c, s) {
      glow(ctx, 0, -1, 26, CYAN, 0.3 + 0.12 * Math.sin(s.t * 2));
      ctx.save();
      ctx.rotate(s.t * 0.5);
      ctx.strokeStyle = rgba(c.light, 0.7);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.arc(0, 0, 34, 0, TAU);
      ctx.stroke();
      ctx.restore();
    },
  },
  startotem: {
    pad: 6,
    draw(ctx, c) {
      plinth(ctx, 62, 60);
      circle(ctx, 0, 2, 20, dome(ctx, 0, 2, 20, GOLD, 0.4), GOLD_D, 1);
      bearFace(ctx, 0, 8, 12, IVORY, GOLD_D);
      star(ctx, 0, -6, 15, dome(ctx, -3, -10, 15, '#bff6ff', 0.4), 4, 0.36, -Math.PI / 2, '#2a7a8c');
      star(ctx, 0, -6, 15, 'rgba(255,255,255,0.22)', 2, 0.36, -Math.PI / 2);
      gem(ctx, 0, -6, 3.5, c);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, -6, 22, CYAN, s.built ? 0.35 + 0.15 * Math.sin(s.t * 2.2 + s.seed) : 0.15);
    },
  },
  dewshrine: {
    pad: 6,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      circle(ctx, 0, 0, 36, dome(ctx, 0, 0, 36, GOLD, 0.35), GOLD_D, 1.2);
      circle(ctx, 0, 0, 30, dome(ctx, 0, 0, 30, IVORY, 0.35), GOLD_D, 1);
      // dew pools in the shape of a great paw
      ellipse(ctx, 0, 7, 13, 10, 0, rgba('#1d5a3a', 0.9), GOLD_D, 1.2);
      ellipse(ctx, 0, 7, 10, 7.5, 0, rgba(AURORA, 0.75));
      for (const [dx, dy] of [[-0.62, -0.25], [-0.22, -0.62], [0.22, -0.62], [0.62, -0.25]]) {
        const x = dx * 26;
        const y = 3 + dy * 26;
        circle(ctx, x, y, 5.5, rgba('#1d5a3a', 0.9), GOLD_D, 1);
        circle(ctx, x, y, 4, rgba(AURORA, 0.75));
      }
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + Math.PI / 2;
        gem(ctx, Math.cos(a) * 33, Math.sin(a) * 33, 3.5, c);
      }
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 4, 18, AURORA, 0.3 + 0.15 * Math.sin(s.t * 3));
    },
  },
  moongate: {
    pad: 8,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      // the gate ring wears bear ears
      for (const sx of [-1, 1]) {
        circle(ctx, sx * 25, -24, 10, dome(ctx, sx * 25, -24, 10, GOLD, 0.45), GOLD_D, 1.2);
        circle(ctx, sx * 25, -24, 5.5, tone(GOLD_D, -0.2));
        gem(ctx, sx * 25, -24, 3, c);
      }
      circle(ctx, 0, 0, 34, dome(ctx, 0, 0, 34, GOLD, 0.4), GOLD_D, 1.5);
      circle(ctx, 0, 0, 25, '#141226', GOLD_D, 1.2);
      crescent(ctx, 0, 0, 22, 7, -4, rgba('#e8eeff', 0.85));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        star(ctx, Math.cos(a) * 29.5, Math.sin(a) * 29.5, 2.6, i % 2 ? STAR : c.light, 4, 0.4);
      }
    },
    overlay(ctx, c, s) {
      ctx.save();
      ctx.rotate(s.t * (s.working ? 2.5 : 0.8));
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = rgba(i === 1 ? c.light : CYAN, 0.55);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 8 + i * 5, i * 2, i * 2 + 3.5);
        ctx.stroke();
      }
      ctx.restore();
      glow(ctx, 0, 0, 22, CYAN, s.powered ? 0.3 : 0.05);
    },
  },
  starforge: {
    pad: 6,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      rrect(ctx, -32, -30, 64, 52, 10, lit(ctx, -32, -30, 32, 22, GOLD, 0.35), GOLD_D, 1.2);
      // anvil hearth with a captive star
      rrect(ctx, -22, -20, 44, 34, 8, '#0f1630', GOLD_D, 1.2);
      for (const sx of [-1, 1]) rrect(ctx, sx * 26 - 3, -14, 6, 22, 2, lit(ctx, sx * 26 - 3, -14, sx * 26 + 3, 8, IVORY, 0.3), GOLD_D, 0.7);
      star(ctx, 0, -3, 13, dome(ctx, 0, -3, 13, '#dffbff', 0.3), 4, 0.35);
      star(ctx, 0, -3, 8, '#ffffff', 4, 0.35, -Math.PI / 4);
      for (const [x, y] of [[-15, -14], [14, -13], [-14, 8], [15, 7]]) star(ctx, x, y, 2, STAR, 4, 0.35);
      for (const sx of [-1, 1]) bearFace(ctx, sx * 30, 26, 6, IVORY, GOLD_D);
      gem(ctx, 0, 30, 5, c);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, -3, 22, CYAN, s.powered ? 0.35 + 0.2 * Math.sin(s.t * 4) : 0.08);
    },
  },
  starlantern: {
    pad: 6,
    turretSize: 44,
    draw(ctx, c) {
      plinth(ctx, 62, 60);
      hexPlatform(ctx, 22, GOLD);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        circle(ctx, Math.cos(a) * 24, Math.sin(a) * 24, 2.4, STAR, GOLD_D, 0.6);
      }
      gem(ctx, 0, 21, 3.5, c);
    },
    turret(ctx, c) {
      // lantern carved as a bear head, star lens in its muzzle
      for (const sy of [-1, 1]) {
        circle(ctx, -5, sy * 9.5, 4.2, dome(ctx, -5, sy * 9.5, 4.2, IVORY, 0.4), GOLD_D, 0.9);
        circle(ctx, -5, sy * 9.5, 2.2, c.main);
      }
      circle(ctx, 0, 0, 11, dome(ctx, 0, 0, 11, IVORY, 0.4), GOLD_D, 1);
      ellipse(ctx, 8, 0, 5.5, 4.5, 0, dome(ctx, 8, 0, 5.5, GOLD, 0.4), GOLD_D, 0.8);
      circle(ctx, 0, 0, 5.5, dome(ctx, 0, 0, 5.5, '#9ff1ff', 0.5), '#1f6070', 0.8);
      star(ctx, 0, 0, 4.5, '#ffffff', 4, 0.35);
      circle(ctx, 11.5, 0, 2.2, '#dffbff', GOLD_D, 0.6);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 14, CYAN, s.powered ? 0.35 + 0.2 * Math.sin(s.t * 5) : 0.05);
    },
  },
  spiritlodge: {
    pad: 6,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      hexPlatform(ctx, 40, '#e2d6b2');
      circle(ctx, 0, -6, 28, dome(ctx, 0, -6, 28, IVORY, 0.4), GOLD_D, 1.2);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        line(ctx, Math.cos(a) * 6, -6 + Math.sin(a) * 6, Math.cos(a) * 27, -6 + Math.sin(a) * 27, GOLD, 2.2);
      }
      circle(ctx, 0, -6, 8, dome(ctx, 0, -6, 8, GOLD, 0.5), GOLD_D, 1);
      gem(ctx, 0, -6, 4.5, c);
      // carved spirit bear over the door
      bearFace(ctx, 0, 22, 9, IVORY, GOLD_D);
      for (const sx of [-1, 1]) {
        rrect(ctx, sx * 32 - 3, 12, 6, 18, 2, lit(ctx, sx * 32 - 3, 12, sx * 32 + 3, 30, GOLD, 0.4), GOLD_D, 0.8);
        circle(ctx, sx * 32, 11, 3.2, AURORA, '#1d5a3a', 0.6);
      }
    },
    overlay(ctx, _c, s) {
      const a = s.powered ? 0.4 + 0.15 * Math.sin(s.t * 2.5 + s.seed) : 0.06;
      for (const sx of [-1, 1]) glow(ctx, sx * 32, 11, 9, AURORA, a);
      glow(ctx, 0, -6, 18, AURORA, a * 0.5);
    },
  },
  skyaltar: {
    pad: 8,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        poly(ctx, [Math.cos(a - 0.25) * 30, Math.sin(a - 0.25) * 30, Math.cos(a) * 45, Math.sin(a) * 45, Math.cos(a + 0.25) * 30, Math.sin(a + 0.25) * 30], lit(ctx, -45, -45, 45, 45, GOLD, 0.4), GOLD_D, 1);
        circle(ctx, Math.cos(a) * 37, Math.sin(a) * 37, 2.6, c.light);
      }
      nightInlay(ctx, 0, 0, 34, 11);
      circle(ctx, 0, 0, 24, null, c.main, 3);
      const pts = [[-14, -8], [-4, -15], [8, -12], [14, 0], [6, 12], [-8, 13]];
      constellation(ctx, pts, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]], '#cfe0ff', 1, 0.7, 0.5);
      pawPrint(ctx, 0, 2, 9, rgba(IVORY, 0.9));
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 28, CYAN, s.working ? 0.4 : s.powered ? 0.18 : 0.04);
    },
  },
  frostworks: {
    pad: 6,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      rrect(ctx, -34, -32, 68, 60, 6, lit(ctx, -34, -32, 34, 28, '#e3d6b0', 0.3), GOLD_D, 1.2);
      rrect(ctx, -24, -22, 48, 40, 4, '#16324a', GOLD_D, 1);
      // ice crystals growing in the work pit
      for (const [x, y, h, a] of [[-14, 8, 14, -0.3], [-6, 10, 18, 0.1], [4, 9, 12, 0.4], [14, 6, 16, -0.2], [-16, -12, 9, 0.6], [15, -12, 10, -0.5]]) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        poly(ctx, [-2.4, 0, -2.4, -h * 0.75, 0, -h, 2.4, -h * 0.75, 2.4, 0], lit(ctx, -3, -h, 3, 0, '#c8f6ff', 0.4), '#2b6f86', 0.6);
        ctx.restore();
      }
      for (const [x, y] of [[-29, -27], [29, -27], [-29, 23], [29, 23]]) gem(ctx, x, y, 4, c);
      pawPrint(ctx, 0, 24, 3.5, GOLD_D);
    },
    overlay(ctx, _c, s) {
      ctx.save();
      ctx.translate(0, -2);
      ctx.rotate(s.working ? s.t * 2 : 0.4);
      for (let i = 0; i < 2; i++) {
        ctx.rotate(Math.PI);
        line(ctx, 0, 0, 17, 0, GOLD, 3);
        circle(ctx, 17, 0, 3, CYAN);
      }
      circle(ctx, 0, 0, 4, GOLD, GOLD_D, 1);
      ctx.restore();
      glow(ctx, 0, 0, 22, CYAN, s.powered ? 0.18 : 0.04);
    },
  },
  sagelibrary: {
    pad: 6,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      hexPlatform(ctx, 38, '#ddd0a8');
      // ring of scroll shelves
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        ctx.save();
        ctx.translate(Math.cos(a) * 29, Math.sin(a) * 29);
        ctx.rotate(a);
        rrect(ctx, -3, -4, 6, 8, 1.2, i % 3 === 0 ? c.main : i % 3 === 1 ? '#7a3a2a' : '#2e4a6a', GOLD_D, 0.6);
        line(ctx, -3, 0, 3, 0, rgba(IVORY, 0.6), 0.6);
        ctx.restore();
      }
      circle(ctx, 0, 0, 20, dome(ctx, 0, 0, 20, IVORY, 0.35), GOLD_D, 1);
      // black-and-white sage paw in the reading circle
      pawPrint(ctx, 0, 1, 15, '#1b1a1d');
      ellipse(ctx, 0, 4.8, 4, 3, 0, '#f2f0ea');
      star(ctx, 0, 4.8, 3, c.light, 4, 0.4);
    },
    overlay(ctx, c, s) {
      glow(ctx, 0, 0, 24, c.light, s.powered ? 0.22 + 0.12 * Math.sin(s.t * 2) : 0.05);
      if (s.powered) {
        const a = s.t * 0.9;
        glow(ctx, Math.cos(a) * 14, Math.sin(a) * 14, 5, CYAN, 0.7);
      }
    },
  },
  greatbeacon: {
    pad: 8,
    draw(ctx, c) {
      plinth(ctx, 94, 92);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU - Math.PI / 2;
        poly(ctx, [0, 0, Math.cos(a - 0.35) * 40, Math.sin(a - 0.35) * 40, Math.cos(a) * 46, Math.sin(a) * 46, Math.cos(a + 0.35) * 40, Math.sin(a + 0.35) * 40], lit(ctx, -46, -46, 46, 46, GOLD, 0.45), GOLD_D, 1);
        gem(ctx, Math.cos(a) * 36, Math.sin(a) * 36, 3.5, c);
      }
      nightInlay(ctx, 0, 0, 24, 5);
      const dip = [[-19, 9], [-13, 4], [-7, 3], [-1, 0], [10, -3], [11, 7], [1, 9]];
      constellation(ctx, dip, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]], '#ffe39a', 1.2, 0.9, 0.8);
      circle(ctx, 0, -14, 4, dome(ctx, 0, -14, 4, '#fff6d6', 0.4), GOLD_D, 0.8);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 32, '#ffe39a', s.powered ? 0.28 + 0.15 * Math.sin(s.t * 1.5) : 0.05);
    },
  },
};
