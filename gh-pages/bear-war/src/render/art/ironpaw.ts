// Ironpaw art: industrial timber-country bears. Steel and log buildings, riveted steam
// machinery, brass fittings and team-coloured gear.

import type { ArtDef, TeamPal } from './index.ts';
import { FUR, bearHead, bipedBear, pawPrint, quadBear, type Fur } from './bear.ts';
import { circle, dome, ellipse, glow, hazard, line, lit, poly, rivets, rrect, sym, tone, type Ctx, footShadow, rgba, TAU } from './kit.ts';

const STEEL = '#8a949e';
const STEEL_D = '#4e565f';
const GUN = '#2d3339';
const GLASS = '#7fdcff';
const HAZ = '#e2b33b';
const BRASS = '#c9a24a';
const COPPER = '#b5693a';
const WOOD = '#8a6239';
const WOOD_D = '#5a3d22';
const DIRT = '#6b5136';

// ---------------------------------------------------------------- bear gear

/** Ears of bearHead(x, r), redrawn so they poke out over a hat. */
function ears(ctx: Ctx, x: number, r: number, f: Fur): void {
  for (const sy of [-1, 1]) {
    const ex = x - r * 0.45;
    const ey = sy * r * 0.78;
    circle(ctx, ex, ey, r * 0.42, f.dark);
    circle(ctx, ex + r * 0.05, ey, r * 0.22, f.ear ?? tone(f.dark, 0.25));
  }
}

/** Round hat seen from above: brim, crown and a team band. */
function hat(ctx: Ctx, x: number, brim: number, crown: number, col: string, band: string): void {
  circle(ctx, x, 0, brim, dome(ctx, x, 0, brim, tone(col, -0.12), 0.3), 'rgba(0,0,0,0.5)', 0.5);
  circle(ctx, x, 0, crown + brim * 0.12, band);
  circle(ctx, x, 0, crown, dome(ctx, x, 0, crown, col, 0.45), 'rgba(0,0,0,0.35)', 0.4);
}

function shoulder(ctx: Ctx, x: number, y: number, rx: number, ry: number, c: TeamPal): void {
  ellipse(ctx, x, y, rx, ry, 0, dome(ctx, x, y, Math.max(rx, ry), c.main, 0.5), tone(c.dark, -0.2), 0.6);
}

/** Shaggy fur tufts around an ellipse (sloth bears). */
function shag(ctx: Ctx, x: number, rx: number, ry: number, f: Fur, n = 16): void {
  ctx.strokeStyle = tone(f.fur, 0.25);
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * rx * 0.8, Math.sin(a) * ry * 0.8);
    ctx.lineTo(x + Math.cos(a + 0.15) * rx * 1.12, Math.sin(a + 0.15) * ry * 1.12);
    ctx.stroke();
  }
}

/** Cream spectacle rings round the eyes of bearHead(x, r). */
function spectacles(ctx: Ctx, x: number, r: number): void {
  for (const sy of [-1, 1]) {
    circle(ctx, x + r * 0.32, sy * r * 0.36, r * 0.2, null, '#ecd9a8', r * 0.13);
    circle(ctx, x + r * 0.32, sy * r * 0.36, r * 0.11, '#0b0908');
  }
  line(ctx, x + r * 0.45, -r * 0.2, x + r * 0.8, -r * 0.08, '#ecd9a8', r * 0.09);
  line(ctx, x + r * 0.45, r * 0.2, x + r * 0.8, r * 0.08, '#ecd9a8', r * 0.09);
}

/** Pilot head with brass flying goggles. */
function pilot(ctx: Ctx, x: number, r: number, f: Fur, y = 0): void {
  bearHead(ctx, x, r, f, y);
  line(ctx, x - r * 0.3, y - r * 0.9, x - r * 0.3, y + r * 0.9, '#3a2a1c', r * 0.2);
  for (const sy of [-1, 1]) circle(ctx, x + r * 0.32, y + sy * r * 0.38, r * 0.26, rgba(GLASS, 0.85), BRASS, r * 0.14);
}

function paw(ctx: Ctx, x: number, y: number, s: number, f: Fur): void {
  circle(ctx, x, y, 1.9 * s, f.dark);
}

function keg(ctx: Ctx, x: number, y: number, w: number, h: number, c: TeamPal): void {
  rrect(ctx, x - w / 2, y - h / 2, w, h, w * 0.35, lit(ctx, x - w / 2, y - h / 2, x + w / 2, y + h / 2, '#9a6a3a', 0.3), '#2a1a0e', 0.6);
  for (const k of [-0.32, 0.32]) line(ctx, x - w / 2 + 0.4, y + k * h, x + w / 2 - 0.4, y + k * h, c.main, 1.1);
  line(ctx, x - w / 2 + 0.4, y, x + w / 2 - 0.4, y, 'rgba(0,0,0,0.3)', 0.5);
}

function wheel(ctx: Ctx, x: number, y: number, l: number, w: number, f: number): void {
  rrect(ctx, x - l / 2, y - w / 2, l, w, w * 0.45, '#1f2226', '#0b0c0e', 0.5);
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 0.7;
  const o = (f % 2) * 1.3;
  for (let k = -l / 2 + 1 + o; k < l / 2 - 0.5; k += 2.6) {
    ctx.beginPath();
    ctx.moveTo(x + k, y - w / 2 + 0.4);
    ctx.lineTo(x + k, y + w / 2 - 0.4);
    ctx.stroke();
  }
  circle(ctx, x, y, w * 0.18, STEEL);
}

function puff(ctx: Ctx, x: number, y: number, r: number, t: number): void {
  for (let i = 0; i < 3; i++) {
    const k = (t * 1.2 + i / 3) % 1;
    ctx.globalAlpha = 0.45 * (1 - k);
    circle(ctx, x - k * r * 2.2, y + Math.sin(k * 5 + i) * r * 0.4, r * (0.5 + k), '#e8e4dc');
  }
  ctx.globalAlpha = 1;
}

/** Spinning rotor: blurred disc plus two blades. */
function rotor(ctx: Ctx, x: number, y: number, r: number, a: number, blades = 2): void {
  circle(ctx, x, y, r, 'rgba(220,225,230,0.12)', 'rgba(220,225,230,0.25)', 0.6);
  for (let i = 0; i < blades; i++) {
    const b = a + (i / blades) * TAU;
    line(ctx, x, y, x + Math.cos(b) * r, y + Math.sin(b) * r, 'rgba(40,40,44,0.8)', 1.6);
  }
  circle(ctx, x, y, 1.6, BRASS, '#222', 0.4);
}

/** Propeller seen from above: an edge-on blade sweeping along y. */
function prop(ctx: Ctx, x: number, y: number, r: number, t: number): void {
  ellipse(ctx, x, y, 1.2, r, 0, 'rgba(220,225,230,0.18)');
  const k = Math.cos(t * 45);
  line(ctx, x, y - r * k, x, y + r * k, 'rgba(40,36,32,0.85)', 1.4);
  circle(ctx, x, y, 1.3, BRASS);
}

function flame(ctx: Ctx, x: number, y: number, t: number, r = 2.5): void {
  const k = 0.7 + 0.3 * Math.sin(t * 23 + x);
  glow(ctx, x, y, r * 2.2 * k, '#ff8a2a', 0.8);
  circle(ctx, x, y, r * 0.45 * k, '#fff0b0');
}

// ---------------------------------------------------------------- buildings

/** A building block with a visible south wall for depth. */
function block(ctx: Ctx, x: number, y: number, w: number, h: number, col: string, depth = 5, r = 3): void {
  rrect(ctx, x, y + depth, w, h - depth, r, tone(col, -0.45));
  rrect(ctx, x, y, w, h - depth, r, lit(ctx, x, y, x + w, y + h, col, 0.28), 'rgba(0,0,0,0.5)', 0.8);
  line(ctx, x + r, y + 0.8, x + w - r, y + 0.8, 'rgba(255,255,255,0.35)', 0.8);
}

/** Timber block: a block with plank seams running along x (or y). */
function timber(ctx: Ctx, x: number, y: number, w: number, h: number, depth = 6, r = 4, gap = 6, vertical = false, col = WOOD): void {
  block(ctx, x, y, w, h, col, depth, r);
  ctx.strokeStyle = 'rgba(40,24,10,0.45)';
  ctx.lineWidth = 0.8;
  if (vertical) {
    for (let k = x + gap; k < x + w - 2; k += gap) {
      ctx.beginPath();
      ctx.moveTo(k, y + 2);
      ctx.lineTo(k, y + h - depth - 1);
      ctx.stroke();
    }
  } else {
    for (let k = y + gap; k < y + h - depth - 1; k += gap) {
      ctx.beginPath();
      ctx.moveTo(x + 2, k);
      ctx.lineTo(x + w - 2, k);
      ctx.stroke();
    }
  }
}

/** Stack of log ends (round cuts with rings). */
function logs(ctx: Ctx, x: number, y: number, n: number, r = 3.5): void {
  for (let i = 0; i < n; i++) {
    const lx = x + (i % 3) * r * 2 + (Math.floor(i / 3) % 2) * r;
    const ly = y - Math.floor(i / 3) * r * 1.7;
    circle(ctx, lx, ly, r, '#b48a58', WOOD_D, 0.7);
    circle(ctx, lx, ly, r * 0.5, null, 'rgba(90,60,30,0.6)', 0.5);
  }
}

function pad(ctx: Ctx, w: number, h: number): void {
  footShadow(ctx, w - 6, h - 6, 4);
  rrect(ctx, -w / 2 + 2, -h / 2 + 2, w - 4, h - 4, 5, lit(ctx, -w / 2, -h / 2, w / 2, h / 2, '#5b6168', 0.15), 'rgba(0,0,0,0.6)', 1);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 0.6;
  for (let i = -w / 2 + 16; i < w / 2 - 4; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, -h / 2 + 3);
    ctx.lineTo(i, h / 2 - 3);
    ctx.stroke();
  }
}

function corners(ctx: Ctx, w: number, h: number): void {
  const s = 7;
  hazard(ctx, -w / 2 + 3, -h / 2 + 3, s, s);
  hazard(ctx, w / 2 - 3 - s, -h / 2 + 3, s, s);
  hazard(ctx, -w / 2 + 3, h / 2 - 3 - s, s, s);
  hazard(ctx, w / 2 - 3 - s, h / 2 - 3 - s, s, s);
}

function blink(ctx: Ctx, x: number, y: number, t: number, col: string, phase = 0): void {
  const on = Math.sin(t * 3 + phase) > 0.2;
  if (!on) return;
  glow(ctx, x, y, 5, col, 0.9);
  circle(ctx, x, y, 1, '#fff');
}

function engine(ctx: Ctx, x: number, y: number, r: number): void {
  glow(ctx, x, y, r * 2.4, '#ff9a3a', 0.8);
  circle(ctx, x, y, r * 0.6, '#ffe2b0');
}

/** Team paw badge on a dark roundel. */
function badge(ctx: Ctx, x: number, y: number, r: number, c: TeamPal): void {
  circle(ctx, x, y, r, dome(ctx, x, y, r, '#3a3f45', 0.3), '#15181b', 0.8);
  pawPrint(ctx, x, y + r * 0.05, r * 0.7, c.main);
}

function chimney(ctx: Ctx, x: number, y: number, r: number): void {
  circle(ctx, x, y, r, dome(ctx, x, y, r, '#5a4a40', 0.3), '#15181b', 0.8);
  circle(ctx, x, y, r * 0.55, '#121417');
}

// ---------------------------------------------------------------- units

export const IRONPAW_ART: Record<string, ArtDef> = {
  hardhat: {
    size: 26,
    frames: 4,
    draw(ctx, c, f) {
      const s = 0.72;
      const F = FUR.brown;
      bipedBear(ctx, f, s, F);
      // tool belt with pouches
      line(ctx, -4.4 * s, -6.6 * s, -4.4 * s, 6.6 * s, '#4a3018', 1.3);
      rrect(ctx, -6 * s, -7.8 * s, 3, 2.4, 0.6, c.main);
      rrect(ctx, -6 * s, 6.6 * s, 3, 2.4, 0.6, '#6a4a28');
      // wrench in the right paw
      line(ctx, 4.6 * s, 3.6 * s, 11 * s, 3.9 * s, '#aab3bb', 1.3);
      circle(ctx, 11.4 * s, 3.9 * s, 1.5, '#aab3bb');
      circle(ctx, 12.2 * s, 3.9 * s, 0.7, '#3a2a1a');
      paw(ctx, 5.2 * s, 3.6 * s, s, F);
      // hard hat with a team stripe
      hat(ctx, 0.2 * s, 3.2 * s, 2.6 * s, '#f0c419', '#c79a10');
      ears(ctx, 1.6 * s, 4 * s, F);
      circle(ctx, 0.2 * s, 0, 2.6 * s, dome(ctx, 0.2 * s, 0, 2.6 * s, '#f5cd2a', 0.45));
      line(ctx, -2.2 * s, 0, 2.6 * s, 0, c.main, 1.2 * s);
      circle(ctx, 3.1 * s, 0, 0.7, '#fff6c0');
    },
  },
  ranger: {
    size: 30,
    frames: 4,
    draw(ctx, c, f) {
      const s = 0.82;
      const F = FUR.black;
      bipedBear(ctx, f, s, F);
      // rifle held forward, stock at the right shoulder
      rrect(ctx, -1 * s, 3.4 * s, 6 * s, 2.4 * s, 0.8, '#6a4526');
      rrect(ctx, 3 * s, 3.5 * s, 12 * s, 1.5 * s, 0.5, GUN);
      rrect(ctx, 5 * s, 3.2 * s, 3.2 * s, 2.2 * s, 0.6, '#3d454d');
      paw(ctx, 5.2 * s, 3.6 * s, s, F);
      paw(ctx, 4 * s, -2.8 * s, s, F);
      // ranger campaign hat with a pinched crown
      hat(ctx, 0.2 * s, 3.6 * s, 2.2 * s, '#b98f52', c.main);
      ears(ctx, 1.6 * s, 4 * s, F);
      circle(ctx, 0.2 * s, 0, 2.2 * s, dome(ctx, 0.2 * s, 0, 2.2 * s, '#a47a40', 0.4));
      line(ctx, -1.6 * s, 0, 2 * s, 0, 'rgba(60,38,16,0.7)', 0.7);
    },
  },
  grizzly: {
    size: 40,
    frames: 4,
    draw(ctx, c, f) {
      const s = 1.2;
      const F = FUR.grizzly;
      bipedBear(ctx, f, s, F);
      // shoulder hump
      ellipse(ctx, -3 * s, 0, 2.6 * s, 4 * s, 0, rgba(tone(F.fur, 0.3), 0.85));
      // steel shoulder armor in team colour
      for (const sy of [-1, 1]) {
        shoulder(ctx, -1 * s, sy * 5.4 * s, 3.4 * s, 2.6 * s, c);
        rivets(ctx, -3 * s, sy * 5.4 * s, 1.4 * s, sy * 5.4 * s, 3, 0.6);
      }
      rrect(ctx, -6 * s, -3 * s, 2.4 * s, 6 * s, 1, lit(ctx, -6 * s, -3 * s, -3.6 * s, 3 * s, STEEL, 0.3), '#1b1f23', 0.5);
      // sap-shell launcher on the right arm
      rrect(ctx, -1 * s, 3 * s, 14 * s, 4 * s, 1.5, lit(ctx, -1 * s, 3 * s, 13 * s, 7 * s, '#5d666f', 0.35), '#15181b', 0.7);
      circle(ctx, 2.5 * s, 5 * s, 2.6 * s, dome(ctx, 2.5 * s, 5 * s, 2.6 * s, c.main, 0.5), tone(c.dark, -0.3), 0.6);
      rrect(ctx, 12 * s, 2.6 * s, 2 * s, 4.8 * s, 0.8, GUN);
      circle(ctx, 14 * s, 5 * s, 1.4 * s, '#e8a22a');
      paw(ctx, 5.2 * s, -3.6 * s, s, F);
      bearHead(ctx, 1.6 * s, 4 * s, F);
    },
  },
  medic: {
    size: 30,
    frames: 4,
    draw(ctx, c, f) {
      const s = 0.8;
      const F = FUR.sun;
      bipedBear(ctx, f, s, F);
      // honey-pot satchel slung on the back
      line(ctx, -5 * s, -5.5 * s, 0.5 * s, 5.5 * s, c.main, 1.4);
      circle(ctx, -7 * s, -1 * s, 3.6 * s, dome(ctx, -7 * s, -1 * s, 3.6 * s, '#e0a33a', 0.45), '#5a3510', 0.6);
      circle(ctx, -7 * s, -1 * s, 1.8 * s, '#7a4a18');
      circle(ctx, -7.4 * s, -1.4 * s, 0.9 * s, '#ffd76a');
      // honey jar in the left paw
      circle(ctx, 6 * s, -3.8 * s, 1.9 * s, '#f0b840', '#7a4a18', 0.5);
      paw(ctx, 5.2 * s, 3.6 * s, s, F);
      // white cap with a green cross
      hat(ctx, 0.2 * s, 3 * s, 2.5 * s, '#f4f5f2', '#d4d8d2');
      ears(ctx, 1.6 * s, 4 * s, F);
      circle(ctx, 0.2 * s, 0, 2.5 * s, dome(ctx, 0.2 * s, 0, 2.5 * s, '#ffffff', 0.25));
      line(ctx, -1.4 * s, 0, 1.8 * s, 0, '#2fbf5a', 1.2);
      line(ctx, 0.2 * s, -1.6 * s, 0.2 * s, 1.6 * s, '#2fbf5a', 1.2);
    },
  },
  blazerider: {
    size: 46,
    frames: 4,
    draw(ctx, c, f) {
      const F = FUR.sloth;
      wheel(ctx, -14, 0, 10, 4, f);
      wheel(ctx, 14, 0, 9, 3.4, f);
      // frame and front fork
      line(ctx, -14, 0, 9, 0, '#3a4047', 2.6);
      line(ctx, 8, -2, 14, -1, '#5d666f', 1.2);
      line(ctx, 8, 2, 14, 1, '#5d666f', 1.2);
      // boiler with a team stripe and a brass funnel
      rrect(ctx, -12, -4.5, 9, 9, 3.5, lit(ctx, -12, -4.5, -3, 4.5, COPPER, 0.4), '#3a1e0e', 0.7);
      rrect(ctx, -9.5, -4.5, 2, 9, 0, c.main);
      circle(ctx, -13, -3.8, 1.8, BRASS, '#3a2a10', 0.5);
      // flamer nozzle on the right of the fork
      rrect(ctx, 6, 3.4, 12, 2.4, 0.8, GUN);
      rrect(ctx, 16, 3, 3, 3.2, 0.8, '#3e464e');
      // handlebars
      line(ctx, 7, -6.5, 7, 6.5, '#2a2f34', 1.6);
      // shaggy rider
      ellipse(ctx, -1, 0, 5, 6, 0, dome(ctx, -1, 0, 6, F.fur, 0.35), rgba('#000000', 0.45), 0.6);
      shag(ctx, -1, 5, 6, F);
      for (const sy of [-1, 1]) {
        line(ctx, 0, sy * 4.5, 7, sy * 5.6, F.fur, 2.6);
        circle(ctx, 7, sy * 5.6, 1.5, F.dark);
      }
      bearHead(ctx, 2.8, 3.6, F);
      rrect(ctx, -3, -6.8, 3, 1.6, 0.6, c.main);
      rrect(ctx, -3, 5.2, 3, 1.6, 0.6, c.main);
    },
    overlay(ctx, _c, s) {
      puff(ctx, -14, -3.8, 1.6, s.t);
      flame(ctx, 19.5, 4.6, s.t, 1.4);
    },
  },
  blazebrute: {
    size: 40,
    frames: 4,
    draw(ctx, c, f) {
      const s = 1.1;
      const F = FUR.sloth;
      // fuel tank on the back
      for (const sy of [-1, 1]) rrect(ctx, -12 * s, sy * 3.2 * s - 2.6 * s, 6 * s, 5.2 * s, 2.4 * s, lit(ctx, -12 * s, -6 * s, -6 * s, 6 * s, COPPER, 0.4), '#3a1e0e', 0.6);
      bipedBear(ctx, f, s, F);
      shag(ctx, -1.5 * s, 5.6 * s, 7.6 * s, F, 18);
      // steam armor: chest boiler and big pauldrons
      rrect(ctx, -6 * s, -3.5 * s, 5 * s, 7 * s, 2, lit(ctx, -6 * s, -3.5 * s, -1 * s, 3.5 * s, STEEL, 0.35), '#15181b', 0.6);
      rrect(ctx, -12 * s, -1 * s, 6 * s, 2 * s, 0, c.main);
      for (const sy of [-1, 1]) {
        shoulder(ctx, -1 * s, sy * 6 * s, 3.8 * s, 2.8 * s, c);
        // forearm flamer with a hose back to the tank
        line(ctx, -8 * s, sy * 3 * s, -1 * s, sy * 6.4 * s, '#2a2f34', 1);
        rrect(ctx, 2 * s, sy * 3.6 * s - 1.6 * s, 9 * s, 3.2 * s, 1.2, lit(ctx, 2 * s, -2, 11 * s, 2, '#5d666f', 0.35), '#15181b', 0.6);
        circle(ctx, 11 * s, sy * 3.6 * s, 1.3 * s, '#ff7a2a');
      }
      bearHead(ctx, 1.6 * s, 4 * s, F);
    },
    overlay(ctx, _c, s) {
      flame(ctx, 12.4, -4, s.t, 1.6);
      flame(ctx, 12.4, 4, s.t + 1.3, 1.6);
    },
  },
  sapper: {
    size: 26,
    frames: 4,
    draw(ctx, c, f) {
      const s = 0.68;
      const F = FUR.sun;
      bipedBear(ctx, f, s, F);
      // powder keg strapped on the back
      keg(ctx, -6.5 * s, 0, 6 * s, 10 * s, c);
      line(ctx, -4 * s, -5 * s, -4 * s, 5 * s, '#4a3018', 1);
      ctx.strokeStyle = '#3a3026';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-8.5 * s, -3 * s);
      ctx.quadraticCurveTo(-12 * s, -4 * s, -12 * s, -7 * s);
      ctx.stroke();
    },
    overlay(ctx, _c, s) {
      flame(ctx, -12 * 0.68, -7 * 0.68, s.t, 1.1);
    },
  },
  sapper_b: {
    size: 26,
    draw(ctx, c) {
      const F = FUR.sun;
      // dirt mound
      ellipse(ctx, 0, 0, 10, 9, 0, dome(ctx, 0, 0, 10, DIRT, 0.35), '#2e2216', 0.7);
      for (const [x, y, r] of [[-6, -5, 2.4], [4, -6, 2], [-5, 6, 2.2], [6, 5, 1.8], [-8, 1, 1.6]] as [number, number, number][]) circle(ctx, x, y, r, dome(ctx, x, y, r, tone(DIRT, 0.1), 0.3));
      // keg top and ears/eyes peeking out
      circle(ctx, -4, 0, 3.4, dome(ctx, -4, 0, 3.4, '#9a6a3a', 0.35), '#2a1a0e', 0.6);
      circle(ctx, -4, 0, 2.6, null, c.main, 0.9);
      for (const sy of [-1, 1]) {
        circle(ctx, 2.5, sy * 3.6, 1.8, F.dark);
        circle(ctx, 2.6, sy * 3.6, 0.9, tone(F.dark, 0.25));
        circle(ctx, 5.4, sy * 1.6, 1.1, '#f4ecd0');
        circle(ctx, 5.7, sy * 1.6, 0.6, '#0b0908');
      }
      line(ctx, -4, 0, -6.5, -2.5, '#3a3026', 0.8);
    },
    overlay(ctx, _c, s) {
      const k = Math.sin(s.t * 17) * 0.5 + Math.sin(s.t * 7.3) * 0.5;
      glow(ctx, -6.8, -2.8, 3.4 + k, '#ff8a2a', 0.6 + 0.3 * k);
      circle(ctx, -6.8, -2.8, 0.6, '#fff0b0');
    },
  },
  kodiak: {
    size: 64,
    frames: 4,
    turretSize: 60,
    draw(ctx, c, f) {
      const s = 1.7;
      ctx.save();
      ctx.translate(-3, 0);
      quadBear(ctx, f, s, FUR.kodiak, { hump: true, wide: 1.1 });
      ctx.restore();
      // riveted flank plates
      for (const sy of [-1, 1]) {
        poly(ctx, [-18, sy * 4, 7, sy * 4, 5, sy * 10.5, -15, sy * 10.5], lit(ctx, -18, -10, 7, 10, c.main, 0.4), tone(c.dark, -0.35), 0.8);
        rivets(ctx, -15, sy * 9, 4, sy * 9, 6, 0.7);
        line(ctx, -6, sy * 4.5, -6, sy * 10, tone(c.dark, -0.3), 0.7);
      }
      // saddle ring under the turret
      circle(ctx, 0, 0, 10, '#30373e', '#15181b', 0.8);
      rivets(ctx, -16, 0, -12, 0, 2, 0.8);
    },
    turret(ctx, c) {
      circle(ctx, -2, 0, 8, dome(ctx, -2, 0, 8, STEEL, 0.5), '#1b1f23', 0.8);
      for (const y of [-3.4, 1.2]) {
        rrect(ctx, 3, y, 15, 2.2, 0.8, lit(ctx, 3, y, 18, y + 2.2, '#3e464e', 0.4), '#111', 0.4);
        rrect(ctx, 16, y - 0.4, 2.6, 3, 0.8, GUN);
      }
      circle(ctx, -3, 0, 4, c.main, tone(c.dark, -0.3), 0.6);
      pawPrint(ctx, -3, 0, 2.6, tone(c.light, 0.3));
    },
  },
  kodiak_b: {
    size: 70,
    turretSize: 76,
    draw(ctx, c) {
      const s = 1.7;
      const F = FUR.kodiak;
      // splayed legs with steel braces and claws dug in
      for (const [x0, y0, x1, y1] of [[10, 9, 22, 22], [10, -9, 22, -22], [-12, 9, -24, 21], [-12, -9, -24, -21]]) {
        line(ctx, x0, y0, x1, y1, F.dark, 6);
        line(ctx, x0, y0, x1, y1, STEEL_D, 2.2);
        rrect(ctx, x1 - 4, y1 - 3, 8, 6, 1.5, lit(ctx, x1 - 4, y1 - 3, x1 + 4, y1 + 3, STEEL, 0.35), '#15181b', 0.6);
        const d = Math.sign(y1);
        for (const k of [-2.5, 0, 2.5]) line(ctx, x1 + k, y1 + d * 2.5, x1 + k * 1.3, y1 + d * 5.5, '#d8d0c0', 1);
      }
      quadBear(ctx, 0, s, F, { hump: true, wide: 1.25, long: 1.05 });
      for (const sy of [-1, 1]) {
        poly(ctx, [-19, sy * 4, 7, sy * 4, 5, sy * 11.5, -16, sy * 11.5], lit(ctx, -19, -11, 7, 11, c.main, 0.4), tone(c.dark, -0.35), 0.8);
        rivets(ctx, -16, sy * 10, 4, sy * 10, 6, 0.7);
      }
      hazard(ctx, -20, -2, 6, 4);
      circle(ctx, 0, 0, 11, '#30373e', '#15181b', 0.8);
    },
    turret(ctx, c) {
      circle(ctx, -2, 0, 9.5, dome(ctx, -2, 0, 9.5, STEEL, 0.5), '#1b1f23', 0.8);
      rrect(ctx, 3, -2.6, 30, 5.2, 1, lit(ctx, 3, -2.6, 33, 2.6, '#3e464e', 0.4), '#111', 0.5);
      rrect(ctx, 30, -3.6, 6, 7.2, 1, GUN);
      for (const x of [12, 20]) line(ctx, x, -2.8, x, 2.8, BRASS, 1);
      circle(ctx, -2, 0, 4.5, c.main, tone(c.dark, -0.3), 0.6);
      hazard(ctx, -9, 5, 7, 2.5);
    },
  },
  tracker: {
    size: 44,
    frames: 4,
    turretSize: 36,
    draw(ctx, c, f) {
      for (const [x, y] of [[-9, -10], [-9, 10], [9, -10], [9, 10]]) wheel(ctx, x, y, 9, 4.5, f);
      line(ctx, -9, -8, -9, 8, '#2a2f34', 2);
      line(ctx, 9, -8, 9, 8, '#2a2f34', 2);
      rrect(ctx, -15, -8, 30, 16, 4, lit(ctx, -15, -8, 15, 8, STEEL, 0.3), '#15181b', 0.9);
      rrect(ctx, -13, -8, 24, 3, 1, c.main);
      rrect(ctx, -13, 5, 24, 3, 1, c.main);
      // rear boiler and funnel
      rrect(ctx, -16, -5, 7, 10, 3, lit(ctx, -16, -5, -9, 5, COPPER, 0.4), '#3a1e0e', 0.6);
      circle(ctx, -13, 0, 2, '#1a1a1a', BRASS, 0.8);
      // front bumper
      rrect(ctx, 14, -6, 3, 12, 1, GUN);
      // driver up front
      ellipse(ctx, 6, 0, 3.5, 4.5, 0, dome(ctx, 6, 0, 4.5, FUR.brown.fur, 0.3));
      for (const sy of [-1, 1]) {
        line(ctx, 6, sy * 3.5, 11, sy * 3, FUR.brown.fur, 2);
        circle(ctx, 11, sy * 3, 1.2, FUR.brown.dark);
      }
      pilot(ctx, 8.5, 3, FUR.brown);
    },
    overlay(ctx, _c, s) {
      puff(ctx, -13.5, 0, 1.8, s.t);
    },
    turret(ctx, c) {
      rrect(ctx, -9, -6, 11, 12, 2.5, lit(ctx, -9, -6, 2, 6, '#6d767f', 0.35), '#15181b', 0.8);
      for (const y of [-3.4, 0, 3.4]) {
        rrect(ctx, 0, y - 1.3, 5, 2.6, 1, GUN);
        circle(ctx, 5, y, 1, '#e2e4e6');
      }
      rrect(ctx, -9, -1.2, 9, 2.4, 0, c.main);
      circle(ctx, -6.5, -4, 1.3, '#ff3a3a');
    },
  },
  ironhide: {
    size: 54,
    frames: 4,
    draw(ctx, c, f) {
      const F = FUR.spectacled;
      const ph = [0, 1, 0, -1][f];
      for (const sy of [-1, 1]) {
        const fx = sy * ph * 5;
        line(ctx, -2, sy * 7, fx + 2, sy * 13, '#3a4148', 4);
        circle(ctx, -2, sy * 7, 3, '#2a2f34');
        rrect(ctx, fx - 3, sy * 13 - 3, 10, 6, 2, lit(ctx, fx - 3, sy * 13 - 3, fx + 7, sy * 13 + 3, STEEL_D, 0.35), '#15181b', 0.6);
        for (const k of [0, 2.5, 5]) line(ctx, fx + 6, sy * 13 - 2.2 + k * 0.9, fx + 8.5, sy * 13 - 2.2 + k * 0.9, '#c9c3b5', 0.9);
      }
      // hull with boiler at the back
      rrect(ctx, -16, -5, 6, 10, 2.5, lit(ctx, -16, -5, -10, 5, COPPER, 0.4), '#3a1e0e', 0.6);
      rrect(ctx, -11, -10, 21, 20, 6, lit(ctx, -11, -10, 10, 10, STEEL, 0.3), '#1b1f23', 0.9);
      poly(ctx, [-8, -9.5, 4, -9.5, 7, -6, -8, -6], c.main);
      poly(ctx, [-8, 9.5, 4, 9.5, 7, 6, -8, 6], c.main);
      rivets(ctx, -9, -7.5, 4, -7.5, 5, 0.6);
      rivets(ctx, -9, 7.5, 4, 7.5, 5, 0.6);
      // autocannons on the right, missile pod on the left
      rrect(ctx, 2, 8, 17, 2.4, 0.6, GUN);
      rrect(ctx, 2, 11.4, 17, 2.4, 0.6, GUN);
      rrect(ctx, -2, 7, 8, 8, 2, '#3c444c', '#15181b', 0.6);
      rrect(ctx, -4, -17, 11, 8, 2, lit(ctx, -4, -17, 7, -9, '#59626b', 0.35), '#15181b', 0.6);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) circle(ctx, -1.5 + i * 3, -15 + j * 3.5, 1, '#e2e4e6', '#333', 0.3);
      // open cockpit with the spectacled bear pilot
      circle(ctx, 1, 0, 7, '#1d2125', '#0d0f11', 0.6);
      ellipse(ctx, -0.5, 0, 3.6, 5, 0, dome(ctx, -0.5, 0, 5, F.fur, 0.3));
      bearHead(ctx, 2.6, 4, F);
      spectacles(ctx, 2.6, 4);
    },
  },
  barnstormer: {
    size: 50,
    draw(ctx, c) {
      const F = FUR.brown;
      // tailplane and lower wing tips
      poly(ctx, sym([-18, 0, -18, -8, -13, -8, -11, -2, -11, 0]), lit(ctx, -18, -8, -11, 8, '#c8b48a', 0.3), '#3a2c18', 0.7);
      poly(ctx, [-18, -8, -15, -8, -15, -5.5, -18, -5.5], c.main);
      poly(ctx, [-18, 8, -15, 8, -15, 5.5, -18, 5.5], c.main);
      rrect(ctx, -3, -18, 6, 36, 2, tone('#b8a47a', -0.25));
      // fuselage
      poly(ctx, sym([-19, 0, -16, -2, -2, -4.2, 9, -4, 13, -3, 13, 0]), lit(ctx, -19, -4, 13, 4, '#d1bd92', 0.3), '#3a2c18', 0.8);
      line(ctx, -16, 0, -10, 0, c.main, 2.2);
      // upper wing with struts and team tips
      rrect(ctx, 0, -21, 8, 42, 2.5, lit(ctx, 0, -21, 8, 21, '#d8c69c', 0.3), '#3a2c18', 0.8);
      rrect(ctx, 0, -21, 8, 5, 2, c.main);
      rrect(ctx, 0, 16, 8, 5, 2, c.main);
      ctx.strokeStyle = 'rgba(60,40,20,0.35)';
      ctx.lineWidth = 0.6;
      for (const y of [-13, -7, 7, 13]) {
        ctx.beginPath();
        ctx.moveTo(0.5, y);
        ctx.lineTo(7.5, y);
        ctx.stroke();
      }
      for (const y of [-14, 14]) circle(ctx, 4, y, 0.9, '#3a2c18');
      // engine cowl
      circle(ctx, 13, 0, 3.6, dome(ctx, 13, 0, 3.6, STEEL, 0.5), '#15181b', 0.6);
      // cockpit and pilot with a trailing team scarf
      ellipse(ctx, -6, 0, 4.6, 4, 0, '#2a1e14');
      ctx.strokeStyle = c.main;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-7, 1);
      ctx.quadraticCurveTo(-11, 3, -14, 1.5);
      ctx.stroke();
      pilot(ctx, -5.8, 3, F);
    },
    overlay(ctx, _c, s) {
      prop(ctx, 16, 0, 7, s.t);
    },
  },
  hoverbear: {
    size: 52,
    draw(ctx, c) {
      hoverHull(ctx, c, false);
    },
    overlay(ctx, _c, s) {
      rotor(ctx, -2, -13, 9, s.t * 14, 3);
      rotor(ctx, -2, 13, 9, -s.t * 14, 3);
    },
  },
  hoverbear_a: {
    size: 56,
    draw(ctx, c) {
      // anchor hanging beneath, chain running under the hull
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < 7; i++) ellipse(ctx, -4 - i * 2.4, 2 + i * 1.2, 1.4, 0.9, 0.4, null, '#5d666f', 0.8);
      poly(ctx, [-22, 9, -20, 6.5, -18, 9, -19, 14, -20, 14.5, -21, 14], '#3a4148', '#15181b', 0.6);
      line(ctx, -23.5, 12, -16.5, 12, '#3a4148', 1.4);
      ctx.globalAlpha = 1;
      hoverHull(ctx, c, true);
    },
    overlay(ctx, _c, s) {
      rotor(ctx, -2, -14, 10, s.t * 10, 3);
      rotor(ctx, -2, 14, 10, -s.t * 10, 3);
      if (s.working) glow(ctx, 15, 0, 6, '#ffcf6a', 0.6);
    },
  },
  bearloon: {
    size: 64,
    frames: 4,
    draw(ctx, c, f) {
      const F = FUR.brown;
      // wicker basket trailing beneath, with ropes
      const bx = -17;
      for (const sy of [-1, 1]) {
        line(ctx, bx + 3, sy * 4, -6, sy * 12, '#6a5030', 0.7);
        line(ctx, bx + 3, sy * 4, 0, sy * 6, '#6a5030', 0.7);
      }
      rrect(ctx, bx - 5, -5, 10, 10, 2, lit(ctx, bx - 5, -5, bx + 5, 5, '#b89058', 0.3), '#4a3018', 0.8);
      ctx.strokeStyle = 'rgba(70,45,20,0.5)';
      ctx.lineWidth = 0.5;
      for (let k = -3; k <= 3; k += 2) {
        ctx.beginPath();
        ctx.moveTo(bx + k, -4.5);
        ctx.lineTo(bx + k, 4.5);
        ctx.moveTo(bx - 4.5, k);
        ctx.lineTo(bx + 4.5, k);
        ctx.stroke();
      }
      rrect(ctx, bx - 5, -1, 10, 2, 0, c.main);
      // bear-head envelope: ears, team gores, snout
      const R = 17;
      const x = 3;
      for (const sy of [-1, 1]) {
        circle(ctx, x - R * 0.5, sy * R * 0.8, R * 0.38, dome(ctx, x - R * 0.5, sy * R * 0.8, R * 0.38, F.fur, 0.35), rgba('#000000', 0.5), 0.7);
        circle(ctx, x - R * 0.47, sy * R * 0.82, R * 0.2, c.main);
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, 0, R, 0, TAU);
      ctx.clip();
      ctx.fillStyle = F.fur;
      ctx.fillRect(x - R, -R, R * 2, R * 2);
      const n = 12;
      const rot = f * (TAU / n / 4);
      for (let i = 0; i < n; i += 2) {
        const a0 = rot + (i / n) * TAU;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.arc(x, 0, R, a0, a0 + TAU / n);
        ctx.closePath();
        ctx.fillStyle = c.main;
        ctx.fill();
      }
      ctx.fillStyle = dome(ctx, x, 0, R, '#808080', 0.9);
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillRect(x - R, -R, R * 2, R * 2);
      ctx.restore();
      circle(ctx, x, 0, R, null, rgba('#000000', 0.5), 0.8);
      circle(ctx, x, 0, 3, tone(c.dark, -0.2), '#15181b', 0.5);
      ellipse(ctx, x + R * 0.72, 0, R * 0.42, R * 0.33, 0, dome(ctx, x + R * 0.72, 0, R * 0.42, F.muzzle, 0.3), rgba('#000000', 0.35), 0.5);
      ellipse(ctx, x + R * 1.04, 0, R * 0.13, R * 0.18, 0, '#141010');
      for (const sy of [-1, 1]) {
        circle(ctx, x + R * 0.36, sy * R * 0.36, R * 0.11, '#0b0908');
        circle(ctx, x + R * 0.33, sy * R * 0.36 - 0.6, R * 0.04, '#ffffff');
      }
    },
  },
  lookout: {
    size: 52,
    draw(ctx, c) {
      const F = FUR.grizzly;
      // keel, tail boom and fin
      line(ctx, -18, 0, 8, 0, '#3a4047', 2);
      poly(ctx, [-20, -6, -15, -6, -14, 6, -20, 6], c.main, tone(c.dark, -0.3), 0.6);
      line(ctx, -14.5, -6, -14.5, 6, '#2a2f34', 1);
      // pusher prop hub and engine
      rrect(ctx, -11, -3, 6, 6, 2, lit(ctx, -11, -3, -5, 3, COPPER, 0.4), '#3a1e0e', 0.6);
      // pod
      poly(ctx, sym([-6, 0, -5, -5, 4, -5.5, 10, -3, 12, 0]), lit(ctx, -6, -5, 12, 5, STEEL, 0.35), '#15181b', 0.8);
      poly(ctx, sym([4, -5.5, 10, -3, 12, 0]), c.main);
      // pilot with a brass spyglass
      ellipse(ctx, -0.5, 0, 3.4, 4.4, 0, dome(ctx, -0.5, 0, 4.4, F.fur, 0.3));
      rrect(ctx, 3, -5.8, 14, 2.6, 1.2, lit(ctx, 3, -5.8, 17, -3.2, BRASS, 0.45), '#4a3510', 0.5);
      rrect(ctx, 15, -6.4, 3.4, 3.8, 1, tone(BRASS, -0.2));
      circle(ctx, 18.4, -4.5, 1.2, GLASS);
      line(ctx, 0.5, -3.5, 6, -4.5, F.fur, 2);
      line(ctx, 0.5, 3.5, 6.5, -2.8, F.fur, 2);
      circle(ctx, 6, -4.5, 1.2, F.dark);
      circle(ctx, 6.5, -2.8, 1.2, F.dark);
      bearHead(ctx, 2.4, 3, F);
      // rotor mast
      circle(ctx, -1, 0, 1.6, '#2a2f34');
    },
    overlay(ctx, _c, s) {
      prop(ctx, -12.5, 0, 5, s.t * 1.1);
      ctx.save();
      ctx.translate(-1, 0);
      const a = s.t * 9;
      ctx.globalAlpha = 0.9;
      circle(ctx, 0, 0, 21, 'rgba(220,225,230,0.05)');
      for (const k of [0, Math.PI]) line(ctx, 0, 0, Math.cos(a + k) * 21, Math.sin(a + k) * 21, 'rgba(40,40,44,0.75)', 1.8);
      ctx.globalAlpha = 1;
      circle(ctx, 0, 0, 1.8, BRASS, '#222', 0.4);
      ctx.restore();
    },
  },
  ironmama: {
    size: 118,
    draw(ctx, c) {
      const F = FUR.kodiak;
      // rear propellers on outriggers
      for (const y of [-14, 14]) {
        line(ctx, -40, y * 0.6, -50, y, '#3a4047', 3);
        circle(ctx, -50, y, 3.4, dome(ctx, -50, y, 3.4, STEEL_D, 0.4), '#15181b', 0.6);
      }
      // tail fins
      poly(ctx, [-38, -10, -52, -22, -46, -22, -30, -12], lit(ctx, -52, -22, -30, -10, STEEL_D, 0.3), '#15181b', 0.8);
      poly(ctx, [-38, 10, -52, 22, -46, 22, -30, 12], lit(ctx, -52, 10, -30, 22, STEEL_D, 0.3), '#15181b', 0.8);
      // armored envelope
      ellipse(ctx, -4, 0, 42, 21, 0, dome(ctx, -4, 0, 42, '#7c868f', 0.35), '#15181b', 1.2);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(-4, 0, 42, 21, 0, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.8;
      for (let x = -40; x < 36; x += 9) {
        ctx.beginPath();
        ctx.moveTo(x, -22);
        ctx.lineTo(x, 22);
        ctx.stroke();
      }
      for (const y of [-12, 12]) {
        ctx.beginPath();
        ctx.moveTo(-46, y);
        ctx.lineTo(40, y);
        ctx.stroke();
      }
      for (const x of [-26, 8]) {
        ctx.fillStyle = c.main;
        ctx.fillRect(x, -22, 5, 44);
        ctx.fillStyle = tone(c.main, -0.3);
        ctx.fillRect(x + 5, -22, 1.5, 44);
      }
      ctx.restore();
      rivets(ctx, -36, -16, 26, -16, 14);
      rivets(ctx, -36, 16, 26, 16, 14);
      // bridge with paw emblem
      rrect(ctx, -14, -6, 16, 12, 4, lit(ctx, -14, -6, 2, 6, '#9aa3ac', 0.4), '#15181b', 0.8);
      pawPrint(ctx, -6, 0, 4.2, c.main);
      rrect(ctx, -1, -3, 2, 6, 1, GLASS);
      // broadside batteries
      for (const x of [-32, -16, 2, 18]) {
        for (const sy of [-1, 1]) {
          circle(ctx, x, sy * 17, 3, dome(ctx, x, sy * 17, 3, '#4a525a', 0.4), '#0d0f11', 0.5);
          line(ctx, x, sy * 17, x + 1, sy * 22, GUN, 1.4);
        }
      }
      // mama-bear figurehead with a steel ram snout
      const hx = 40;
      const R = 13;
      ears(ctx, hx, R, F);
      for (const sy of [-1, 1]) circle(ctx, hx - R * 0.45, sy * R * 0.78, R * 0.42, null, c.main, 1.2);
      circle(ctx, hx, 0, R, dome(ctx, hx, 0, R, F.fur, 0.35), '#15181b', 0.9);
      ctx.save();
      ctx.beginPath();
      ctx.arc(hx, 0, R, 0, TAU);
      ctx.clip();
      ctx.fillStyle = rgba(c.main, 0.85);
      ctx.fillRect(hx - R, -R, 4, R * 2);
      ctx.restore();
      poly(ctx, sym([hx + 5, 0, hx + 6, -5.5, hx + 13, -4, hx + 22, 0]), lit(ctx, hx + 5, -5.5, hx + 22, 5.5, STEEL, 0.45), '#15181b', 0.8);
      ellipse(ctx, hx + 15, 0, 2, 2.6, 0, '#141010');
      rivets(ctx, hx + 8, -3.5, hx + 8, 3.5, 3, 0.7);
      for (const sy of [-1, 1]) {
        circle(ctx, hx + R * 0.32, sy * R * 0.38, R * 0.13, '#0b0908');
        circle(ctx, hx + R * 0.3, sy * R * 0.38 - 0.6, R * 0.05, '#ffcf6a');
      }
    },
    overlay(ctx, _c, s) {
      prop(ctx, -54, -14, 7, s.t);
      prop(ctx, -54, 14, 7, s.t + 0.37);
    },
  },

  // ================================================================ structures
  lodge: {
    pad: 8,
    draw(ctx, c) {
      const W = 160;
      pad(ctx, W, W);
      corners(ctx, W, W);
      // octagonal log hall
      const o = 64;
      const k = 22;
      poly(ctx, [-o + k, -o, o - k, -o, o, -o + k, o, o - k - 6, o - k, o - 6, -o + k, o - 6, -o, o - k - 6, -o, -o + k], tone(WOOD_D, -0.35));
      poly(ctx, [-o + k, -o, o - k, -o, o, -o + k, o, o - k - 12, o - k, o - 12, -o + k, o - 12, -o, o - k - 12, -o, -o + k], lit(ctx, -o, -o, o, o, WOOD, 0.25), '#2a1a0c', 1.2);
      // log courses
      ctx.save();
      poly(ctx, [-o + k, -o, o - k, -o, o, -o + k, o, o - k - 12, o - k, o - 12, -o + k, o - 12, -o, o - k - 12, -o, -o + k], null);
      ctx.clip();
      ctx.strokeStyle = 'rgba(40,22,8,0.4)';
      ctx.lineWidth = 1;
      for (let r = 40; r < 92; r += 7) {
        ctx.beginPath();
        ctx.arc(0, -4, r, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
      // team colour band
      ctx.lineWidth = 5;
      ctx.strokeStyle = c.main;
      ctx.beginPath();
      ctx.arc(0, -4, 44, 0, TAU);
      ctx.stroke();
      // corner log piles and boiler silos
      for (const [x, y] of [[-46, -46], [46, 38]]) {
        circle(ctx, x, y, 11, dome(ctx, x, y, 11, '#a3acb5', 0.45), '#15181b', 0.8);
        circle(ctx, x, y, 4, '#30373e');
        rivets(ctx, x - 8, y, x + 8, y, 5, 0.8);
      }
      logs(ctx, 36, -44, 6, 4);
      logs(ctx, -54, 40, 6, 4);
      // central steel dome with the paw crest
      circle(ctx, 0, -4, 30, dome(ctx, 0, -4, 30, '#b9c2ca', 0.45), '#15181b', 1);
      rivets(ctx, -26, -4, 26, -4, 9, 0.8);
      circle(ctx, 0, -4, 20, dome(ctx, 0, -4, 20, '#5b6570', 0.4), '#15181b', 0.8);
      pawPrint(ctx, 0, -4, 13, c.main);
      circle(ctx, 0, -4, 15, null, 'rgba(226,179,59,0.6)', 1.2);
      // south gate
      rrect(ctx, -22, 50, 44, 10, 2, '#2a1a0c');
      for (let x = -18; x < 22; x += 6) line(ctx, x, 51, x, 59, 'rgba(120,80,40,0.6)', 1);
      hazard(ctx, -22, 50, 44, 3);
      // chimney and antenna
      chimney(ctx, -30, -40, 6);
      line(ctx, 20, -30, 34, -48, '#2c3238', 2);
      circle(ctx, 34, -48, 2.5, '#d84a3a');
    },
    overlay(ctx, c, s) {
      puff(ctx, -30, -40, 4, s.t * 0.6);
      blink(ctx, 34, -48, s.t, '#ff4a3a');
      blink(ctx, -46, -46, s.t, '#5cff7a', 1);
      blink(ctx, 46, 38, s.t, '#5cff7a', 2.5);
      if (s.working) glow(ctx, 0, -4, 16, c.light, 0.35 + 0.15 * Math.sin(s.t * 4));
    },
  },
  larder: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 60, 58, 3);
      timber(ctx, -29, -29, 58, 58, 6, 4, 6, true);
      // roof ridge in team colour
      rrect(ctx, -29, -6, 58, 6, 0, c.main);
      line(ctx, -29, -6, 29, -6, 'rgba(255,255,255,0.3)', 0.8);
      // crates
      for (const [x, y] of [[-24, -25], [-13, -25]]) {
        rrect(ctx, x, y, 10, 10, 1, lit(ctx, x, y, x + 10, y + 10, '#b48a58', 0.3), '#3a2410', 0.7);
        line(ctx, x + 1, y + 1, x + 9, y + 9, '#6a4a28', 0.9);
        line(ctx, x + 9, y + 1, x + 1, y + 9, '#6a4a28', 0.9);
      }
      // honey pots
      for (const [x, y] of [[9, -19], [20, -20]]) {
        circle(ctx, x, y, 5.2, dome(ctx, x, y, 5.2, '#e0a33a', 0.45), '#5a3510', 0.7);
        circle(ctx, x, y, 3, '#f4c04a', '#7a4a18', 0.6);
        circle(ctx, x - 0.8, y - 0.8, 1.2, '#fff0b0');
        ellipse(ctx, x + 2, y + 4.2, 1, 1.6, 0, '#e8a22a');
      }
      // salmon on a drying rack
      line(ctx, -24, 6, 24, 6, '#3a2410', 1.2);
      for (const x of [-18, -6, 6, 18]) {
        line(ctx, x, 6, x, 8, '#3a2410', 0.8);
        ellipse(ctx, x, 12, 2.6, 4.6, 0, lit(ctx, x - 3, 7, x + 3, 17, '#e07a5a', 0.35), '#6a2e1e', 0.6);
        poly(ctx, [x, 15.5, x - 3, 19.5, x + 3, 19.5], '#c0604a', '#6a2e1e', 0.5);
        circle(ctx, x, 9, 0.7, '#1a1010');
      }
    },
  },
  refinery: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      rrect(ctx, -46, -46, 92, 92, 8, lit(ctx, -46, -46, 46, 46, '#5c636a', 0.2), '#15181b', 1);
      // timber walkway deck
      timber(ctx, -40, -6, 80, 12, 2, 2, 5, true);
      // pipes
      line(ctx, -26, -24, 26, 24, '#3a4047', 6);
      line(ctx, -26, 24, 26, -24, '#3a4047', 6);
      for (const [x, y, r] of [[-24, -22, 16], [24, 22, 16], [24, -24, 11]] as [number, number, number][]) {
        circle(ctx, x, y, r + 2, 'rgba(0,0,0,0.35)');
        circle(ctx, x, y, r, dome(ctx, x, y, r, '#b3bcc4', 0.45), '#15181b', 1);
        circle(ctx, x, y, r * 0.55, null, c.main, 3);
        rivets(ctx, x - r * 0.8, y, x + r * 0.8, y, 5, 0.7);
      }
      for (const [x, y] of [[-24, -22], [24, 22]]) circle(ctx, x, y, 3, BRASS, '#3a2a10', 0.6);
      rrect(ctx, -34, 14, 22, 22, 3, '#3f464d', '#15181b', 0.8);
      pawPrint(ctx, -23, 25, 7, c.main);
      hazard(ctx, -34, 33, 22, 3);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, 0, 12, '#62ff7a', 0.4 + 0.2 * Math.sin(s.t * 3));
      puff(ctx, 24, -24, 3, s.t * 0.5);
    },
  },
  bunkhouse: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      block(ctx, -46, -44, 92, 88, WOOD_D, 7, 5);
      // gabled shingle roof: two panels
      poly(ctx, [-42, -40, 42, -40, 42, -2, -42, -2], lit(ctx, -42, -40, 42, -2, '#9a7046', 0.3));
      poly(ctx, [-42, -2, 42, -2, 42, 32, -42, 32], lit(ctx, -42, -2, 42, 32, '#6e4c2c', 0.25));
      ctx.strokeStyle = 'rgba(40,22,8,0.4)';
      ctx.lineWidth = 0.8;
      for (const y of [-34, -28, -22, -16, -10, 4, 10, 16, 22, 28]) {
        ctx.beginPath();
        ctx.moveTo(-42, y);
        ctx.lineTo(42, y);
        ctx.stroke();
      }
      line(ctx, -42, -2, 42, -2, 'rgba(255,255,255,0.4)', 1);
      rrect(ctx, -42, -4, 84, 4, 0, c.main);
      // log-end corners
      for (const [x, y] of [[-42, -40], [42, -40], [-42, 32], [42, 32]]) circle(ctx, x, y, 3.5, '#b48a58', WOOD_D, 0.7);
      // door
      rrect(ctx, -14, 30, 28, 9, 2, '#1d2125');
      hazard(ctx, -14, 30, 28, 3);
      // stovepipes and paw crest
      for (const x of [-28, 28]) chimney(ctx, x, -22, 4.5);
      badge(ctx, 0, 14, 8, c);
    },
    overlay(ctx, _c, s) {
      puff(ctx, -28, -22, 2.6, s.t * 0.6);
      blink(ctx, -40, 34, s.t, '#ffcf4a');
      blink(ctx, 40, 34, s.t, '#ffcf4a', 3);
    },
  },
  workshop: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      timber(ctx, -46, -44, 92, 88, 6, 6, 7);
      circle(ctx, -6, -6, 30, dome(ctx, -6, -6, 30, '#b8c1c9', 0.45), '#15181b', 1);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      for (let a = 0; a < 6; a++) {
        ctx.beginPath();
        ctx.moveTo(-6, -6);
        ctx.lineTo(-6 + Math.cos(a) * 30, -6 + Math.sin(a) * 30);
        ctx.stroke();
      }
      rivets(ctx, -34, -6, 22, -6, 12, 0.7);
      badge(ctx, -6, -6, 10, c);
      // tool racks
      for (const y of [-30, -16, -2, 12]) rrect(ctx, 28, y, 12, 9, 1.5, '#353c43', '#15181b', 0.6);
      line(ctx, 30, -26, 38, -26, '#aab3bb', 1.4);
      circle(ctx, 34, -12, 3, null, '#aab3bb', 1);
      rrect(ctx, -40, 26, 50, 8, 2, c.main);
      logs(ctx, -40, 22, 3, 3);
    },
  },
  guntower: {
    pad: 6,
    turretSize: 48,
    draw(ctx, c) {
      footShadow(ctx, 58, 58, 3);
      poly(ctx, [-20, -28, 20, -28, 28, -20, 28, 20, 20, 28, -20, 28, -28, 20, -28, -20], lit(ctx, -28, -28, 28, 28, WOOD, 0.25), '#2a1a0c', 1);
      ctx.strokeStyle = 'rgba(40,22,8,0.4)';
      ctx.lineWidth = 0.8;
      for (let y = -22; y <= 22; y += 6) {
        ctx.beginPath();
        ctx.moveTo(-26, y);
        ctx.lineTo(26, y);
        ctx.stroke();
      }
      circle(ctx, 0, 0, 17, lit(ctx, -17, -17, 17, 17, STEEL_D, 0.3), '#15181b', 0.8);
      rivets(ctx, -14, 0, 14, 0, 2, 1);
      for (const [x, y] of [[-22, -22], [22, -22], [-22, 22], [22, 22]]) circle(ctx, x, y, 2, c.main);
      hazard(ctx, -24, 22, 48, 3);
    },
    turret(ctx, c) {
      circle(ctx, 0, 0, 11, dome(ctx, 0, 0, 11, STEEL, 0.5), '#15181b', 1);
      rrect(ctx, 6, -4.5, 16, 3, 1, GUN);
      rrect(ctx, 6, 1.5, 16, 3, 1, GUN);
      rivets(ctx, -8, -6, -8, 6, 4, 0.7);
      circle(ctx, -2, 0, 4.5, c.main, tone(c.dark, -0.3), 0.8);
    },
  },
  bunker: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 94, 62, 3);
      // sandbag berm
      rrect(ctx, -47, -31, 94, 62, 16, lit(ctx, -47, -31, 47, 31, '#77705d', 0.2), '#2a2620', 1);
      for (let x = -40; x <= 40; x += 8) {
        ellipse(ctx, x, -27, 4.2, 2.6, 0, '#8c846d', 'rgba(0,0,0,0.35)', 0.5);
        ellipse(ctx, x + 4, 27, 4.2, 2.6, 0, '#7f7863', 'rgba(0,0,0,0.35)', 0.5);
      }
      // log casemate
      timber(ctx, -38, -23, 76, 46, 7, 9, 6);
      for (const [x, y] of [[-38, -18], [-38, -6], [-38, 6], [38, -18], [38, -6], [38, 6]]) circle(ctx, x, y, 3, '#b48a58', WOOD_D, 0.6);
      // firing slits
      for (const x of [-24, -8, 8, 24]) {
        rrect(ctx, x - 5, -20, 10, 3, 1, '#14171a');
        rrect(ctx, x - 5, 10, 10, 3, 1, '#14171a');
      }
      // steel roof hatch
      circle(ctx, 0, -4, 8, dome(ctx, 0, -4, 8, STEEL_D, 0.4), '#15181b', 0.8);
      pawPrint(ctx, 0, -4, 5, c.main);
      rrect(ctx, -30, 0, 14, 4, 1, c.main);
      rrect(ctx, 16, 0, 14, 4, 1, c.main);
    },
    overlay(ctx, _c, s) {
      if (!s.working) return;
      // muzzle flashes in the slits while the garrison is shooting
      const k = Math.floor(s.t * 14) % 4;
      const x = [-24, -8, 8, 24][k];
      glow(ctx, x, k % 2 ? 11.5 : -18.5, 6, '#ffcf6a', 0.9);
    },
  },
  flakturret: {
    pad: 6,
    turretSize: 48,
    draw(ctx, c) {
      footShadow(ctx, 58, 58, 3);
      circle(ctx, 0, 0, 28, lit(ctx, -28, -28, 28, 28, WOOD, 0.25), '#2a1a0c', 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 27, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = 'rgba(40,22,8,0.4)';
      ctx.lineWidth = 0.8;
      for (let x = -24; x <= 24; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, -28);
        ctx.lineTo(x, 28);
        ctx.stroke();
      }
      ctx.restore();
      circle(ctx, 0, 0, 18, '#30373e', '#15181b', 0.8);
      circle(ctx, 0, 0, 22, null, c.main, 2);
      hazard(ctx, -18, 20, 36, 3);
    },
    turret(ctx, c) {
      rrect(ctx, -9, -12, 18, 24, 4, lit(ctx, -9, -12, 9, 12, STEEL, 0.35), '#15181b', 1);
      for (const [x, y] of [[-3, -7], [4, -7], [-3, 7], [4, 7]]) circle(ctx, x, y, 2.6, '#1b1f23', '#000', 0.4);
      rrect(ctx, -9, -2, 18, 4, 0, c.main);
      circle(ctx, -6, 0, 1.3, '#ff3a3a');
    },
  },
  academy: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      timber(ctx, -46, -44, 92, 88, 6, 6, 8, true);
      rrect(ctx, -36, -34, 72, 54, 4, lit(ctx, -36, -34, 36, 20, '#9aa3ab', 0.25), '#15181b', 0.8);
      rivets(ctx, -32, -31, 32, -31, 12, 0.7);
      rivets(ctx, -32, 17, 32, 17, 12, 0.7);
      // paw crest
      circle(ctx, 0, -8, 19, null, c.main, 2.5);
      pawPrint(ctx, 0, -8, 14, c.main);
      for (const x of [-30, 30]) circle(ctx, x, 30, 6, dome(ctx, x, 30, 6, '#c9d0d6'), '#15181b', 0.6);
      rrect(ctx, -10, 31, 20, 8, 2, '#1d2125');
    },
  },
  steamworks: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      block(ctx, -46, -44, 92, 88, '#6f7881', 8, 4);
      // hangar roof arcs
      for (let i = 0; i < 4; i++) {
        const y = -36 + i * 16;
        rrect(ctx, -40, y, 64, 13, 6, lit(ctx, -40, y, 24, y + 13, '#8c96a0', 0.35), '#15181b', 0.7);
        rivets(ctx, -36, y + 6.5, 20, y + 6.5, 10, 0.6);
      }
      // smokestacks
      for (const y of [-30, -12]) chimney(ctx, 34, y, 6);
      rrect(ctx, 28, 2, 12, 26, 2, c.main);
      pawPrint(ctx, 34, 15, 5, tone(c.light, 0.4));
      // big timber door
      rrect(ctx, -30, 28, 48, 10, 2, WOOD_D);
      for (let x = -26; x < 18; x += 6) line(ctx, x, 29, x, 37, 'rgba(0,0,0,0.35)', 1);
      hazard(ctx, -30, 28, 48, 3);
    },
    overlay(ctx, _c, s) {
      puff(ctx, 34, -30, 3.5, s.t * 0.7);
      puff(ctx, 34, -12, 3.5, s.t * 0.7 + 0.5);
      if (s.working && Math.sin(s.t * 6) > 0.6) glow(ctx, -6, 34, 10, '#ff9a3a', 0.4);
      blink(ctx, 40, 36, s.t, '#ffcf4a', 1);
    },
  },
  armory: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      block(ctx, -46, -44, 92, 88, '#727b84', 6, 4);
      timber(ctx, 18, -40, 26, 76, 2, 2, 6, false);
      // gear emblem with a paw at the hub
      const g = 18;
      ctx.save();
      ctx.translate(-12, -4);
      ctx.fillStyle = c.main;
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        const r = i % 2 ? g : g + 5;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      circle(ctx, 0, 0, 10, '#3a4148');
      pawPrint(ctx, 0, 0, 7, tone(c.light, 0.3));
      ctx.restore();
      for (const y of [-34, -20, -6, 8, 22]) rrect(ctx, 22, y, 18, 10, 1.5, lit(ctx, 22, y, 40, y + 10, '#9aa3ab'), '#15181b', 0.6);
      rivets(ctx, -40, 34, 14, 34, 10, 0.8);
    },
  },
  airfield: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      block(ctx, -46, -44, 92, 88, '#5f676f', 5, 6);
      // timber landing deck with a paw marking
      circle(ctx, -6, 0, 30, lit(ctx, -36, -30, 24, 30, WOOD, 0.2), '#15181b', 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(-6, 0, 29, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = 'rgba(40,22,8,0.45)';
      ctx.lineWidth = 0.8;
      for (let x = -34; x < 24; x += 5) {
        ctx.beginPath();
        ctx.moveTo(x, -30);
        ctx.lineTo(x, 30);
        ctx.stroke();
      }
      ctx.restore();
      circle(ctx, -6, 0, 25, null, HAZ, 1.5);
      pawPrint(ctx, -6, 1, 15, HAZ);
      // control tower with a windsock
      rrect(ctx, 24, -38, 18, 28, 3, lit(ctx, 24, -38, 42, -10, '#a0a9b1', 0.35), '#15181b', 0.8);
      rrect(ctx, 27, -34, 12, 6, 1.5, GLASS);
      rrect(ctx, 24, -10, 18, 6, 0, c.main);
      line(ctx, 33, 6, 33, 30, '#2c3238', 1.5);
      poly(ctx, [33, 8, 42, 10, 42, 13, 33, 14], c.main, tone(c.dark, -0.3), 0.5);
    },
    overlay(ctx, _c, s) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const on = Math.floor(s.t * 6) % 8 === i;
        if (on) glow(ctx, -6 + Math.cos(a) * 30, Math.sin(a) * 30, 5, '#ffcf6a', 0.9);
      }
    },
  },
  sciencelab: {
    pad: 6,
    draw(ctx, c) {
      footShadow(ctx, 92, 90, 4);
      timber(ctx, -46, -44, 92, 88, 6, 8, 7, true);
      circle(ctx, 0, -4, 28, dome(ctx, 0, -4, 28, '#d9e0e6', 0.35), '#15181b', 1);
      rivets(ctx, -24, -4, 24, -4, 2, 1);
      circle(ctx, 0, -4, 18, rgba('#7fdcff', 0.6), BRASS, 1.5);
      circle(ctx, 0, -4, 7, '#e8fbff');
      // brass telescope poking from the dome
      rrect(ctx, 6, -24, 22, 5, 2, lit(ctx, 6, -24, 28, -19, BRASS, 0.45), '#4a3510', 0.6);
      for (const [x, y] of [[-34, -34], [34, -34], [-34, 30], [34, 30]]) {
        line(ctx, x, y, x * 0.6, y * 0.6, '#3a4148', 2);
        circle(ctx, x, y, 4, c.main, '#15181b', 0.6);
      }
      pawPrint(ctx, 0, 30, 6, c.main);
    },
    overlay(ctx, _c, s) {
      glow(ctx, 0, -4, 18, '#7fdcff', 0.35 + 0.2 * Math.sin(s.t * 2.5));
    },
  },
};

function hoverHull(ctx: Ctx, c: TeamPal, anchored: boolean): void {
  const F = FUR.brown;
  const ry = anchored ? 14 : 13;
  // rotor booms and housings
  line(ctx, -2, -ry, -2, ry, '#2d3339', 3.5);
  for (const sy of [-1, 1]) {
    circle(ctx, -2, sy * ry, 9.5, null, STEEL_D, 2.4);
    circle(ctx, -2, sy * ry, 10.6, null, c.main, 0.9);
  }
  // rocket pods
  if (!anchored) {
    for (const sy of [-1, 1]) {
      rrect(ctx, 2, sy * 7 - 2.2, 10, 4.4, 1.8, '#3c444c', '#15181b', 0.6);
      for (const k of [-1, 1]) circle(ctx, 12, sy * 7 + k * 1.1, 0.8, '#e2e4e6');
    }
  }
  // hull
  poly(ctx, sym([-15, 0, -14, -4, -6, -6.5, 6, -6, 13, -3, 14, 0]), lit(ctx, -15, -6, 14, 6, STEEL, 0.35), '#15181b', 0.9);
  poly(ctx, sym([-12, 0, -12, -4.5, -8, -5.5, -8, 0]), c.main);
  rivets(ctx, -6, -5, 8, -4.5, 6, 0.6);
  rivets(ctx, -6, 5, 8, 4.5, 6, 0.6);
  engine(ctx, -15, 0, 1.8);
  if (anchored) {
    // heavy downward cannon slung under the nose
    circle(ctx, 12, 0, 6.5, dome(ctx, 12, 0, 6.5, '#59626b', 0.45), '#0d0f11', 0.8);
    circle(ctx, 14, 0, 3.4, '#121417', '#3e464e', 1.2);
    hazard(ctx, 6, -7.5, 8, 2);
  }
  // pilot
  circle(ctx, 2, 0, 5, rgba(GLASS, 0.35), '#15181b', 0.5);
  pilot(ctx, 2, 3.2, F);
}
