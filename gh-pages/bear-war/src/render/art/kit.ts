// Procedural drawing helpers shared by all sprite art. Coordinates are world px in
// sprite-local space: (0,0) is the centre, units face +x.

export type Ctx = CanvasRenderingContext2D;

export function hexToRgb(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(c: string, a: number): string {
  const [r, g, b] = hexToRgb(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
export function tone(c: string, amt: number): string {
  const [r, g, b] = hexToRgb(c);
  const f = (v: number) => Math.round(Math.max(0, Math.min(255, amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}

/** Linear gradient from light (top-left) to dark (bottom-right) across a box. */
export function lit(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, base: string, spread = 0.35): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, tone(base, spread));
  g.addColorStop(0.5, base);
  g.addColorStop(1, tone(base, -spread));
  return g;
}

/** Radial "dome" shading for round shapes: highlight near the top-left. */
export function dome(ctx: Ctx, x: number, y: number, r: number, base: string, spread = 0.45): CanvasGradient {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.05, x, y, r);
  g.addColorStop(0, tone(base, spread));
  g.addColorStop(0.55, base);
  g.addColorStop(1, tone(base, -spread));
  return g;
}

export function path(ctx: Ctx, pts: number[], close = true): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  if (close) ctx.closePath();
}

export function poly(ctx: Ctx, pts: number[], fill: string | CanvasGradient | null, stroke?: string | null, lw = 1): void {
  path(ctx, pts);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** Mirror a half-polygon (given for y <= 0) across the x axis into a full outline. */
export function sym(half: number[]): number[] {
  const out = [...half];
  for (let i = half.length - 2; i >= 0; i -= 2) {
    if (half[i + 1] === 0) continue;
    out.push(half[i], -half[i + 1]);
  }
  return out;
}

export function circle(ctx: Ctx, x: number, y: number, r: number, fill: string | CanvasGradient | null, stroke?: string | null, lw = 1): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

export function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot: number, fill: string | CanvasGradient | null, stroke?: string | null, lw = 1): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

export function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient | null, stroke?: string | null, lw = 1): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

export function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, lw = 1): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Soft additive glow. */
export function glow(ctx: Ctx, x: number, y: number, r: number, color: string, a = 1): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, a));
  g.addColorStop(0.4, rgba(color, a * 0.45));
  g.addColorStop(1, rgba(color, 0));
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalCompositeOperation = prev;
}

/** Diagonal warning stripes inside a rect. */
export function hazard(ctx: Ctx, x: number, y: number, w: number, h: number, a = '#e2b33b', b = '#2a2620'): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = b;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = a;
  const s = 4;
  for (let i = -h; i < w + h; i += s * 2) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + s, y);
    ctx.lineTo(x + i + s - h, y + h);
    ctx.lineTo(x + i - h, y + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Small round rivets/bolts along a line. */
export function rivets(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, n: number, r = 0.7, color = 'rgba(0,0,0,0.45)'): void {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    ctx.beginPath();
    ctx.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Soft drop shadow under a structure footprint (drawn into the sprite). */
export function footShadow(ctx: Ctx, w: number, h: number, off = 5): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.filter = 'blur(3px)';
  ctx.beginPath();
  ctx.roundRect(-w / 2 + off * 0.6, -h / 2 + off, w, h, 6);
  ctx.fill();
  ctx.restore();
}

/** Deterministic pseudo-random for art. */
export function rnd(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const TAU = Math.PI * 2;
