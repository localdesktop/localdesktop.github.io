// Deterministic math helpers.
//
// IEEE-754 +, -, *, / and sqrt are exactly specified and give identical results in
// every JS engine, but Math.sin/cos/atan2/pow/exp/log are "implementation-approximated"
// and can differ in the last bits between Chrome, Safari and Firefox. That would desync a
// lockstep game, so the simulation uses these polynomial versions instead.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > PI) a -= TAU;
  while (a <= -PI) a += TAU;
  return a;
}

/** Deterministic sine (max error ~1e-9 on the wrapped range). */
export function dsin(a: number): number {
  a = wrapAngle(a);
  // use symmetry to reduce to [-PI/2, PI/2]
  if (a > HALF_PI) a = PI - a;
  else if (a < -HALF_PI) a = -PI - a;
  const a2 = a * a;
  // Taylor series up to x^15, plenty for |x| <= PI/2
  return (
    a *
    (1 -
      (a2 / 6) *
        (1 -
          (a2 / 20) *
            (1 - (a2 / 42) * (1 - (a2 / 72) * (1 - (a2 / 110) * (1 - (a2 / 156) * (1 - a2 / 210)))))))
  );
}

export function dcos(a: number): number {
  return dsin(a + HALF_PI);
}

/** Deterministic atan2 (max error ~1e-5 rad), good enough for facing and steering. */
export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const swap = ay > ax;
  const t = swap ? ax / ay : ay / ax; // 0..1
  // minimax-ish polynomial for atan on [0,1]
  const t2 = t * t;
  let r =
    t *
    (0.99997726 +
      t2 * (-0.33262347 + t2 * (0.19354346 + t2 * (-0.11643287 + t2 * (0.05265332 + t2 * -0.0117212)))));
  if (swap) r = HALF_PI - r;
  if (x < 0) r = PI - r;
  if (y < 0) r = -r;
  return r;
}

/** Rotate `from` toward `to` by at most `step` radians. */
export function turnToward(from: number, to: number, step: number): number {
  const d = wrapAngle(to - from);
  if (d > step) return wrapAngle(from + step);
  if (d < -step) return wrapAngle(from - step);
  return to;
}

/** Distance from point to an axis-aligned rectangle (0 if inside). */
export function distToRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Integer hash (deterministic), useful for per-entity jitter. */
export function hash32(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}
