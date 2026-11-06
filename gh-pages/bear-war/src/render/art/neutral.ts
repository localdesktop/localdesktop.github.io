import type { ArtDef } from './index.ts';
import { circle, dome, ellipse, glow, poly, rnd, tone, type Ctx } from './kit.ts';

function crystal(ctx: Ctx, x: number, y: number, h: number, w: number, lean: number): void {
  // a hexagonal prism seen from above-ish: bright face + dark face
  const tx = x + lean;
  const ty = y - h;
  poly(ctx, [x - w, y, x - w * 0.6, y - h * 0.8, tx, ty, x + w * 0.1, y - h * 0.2], '#bff3ff', '#1b5f86', 0.7);
  poly(ctx, [x + w * 0.1, y - h * 0.2, tx, ty, x + w * 0.6, y - h * 0.75, x + w, y], '#3aa6dd', '#1b5f86', 0.7);
  poly(ctx, [x - w, y, x + w * 0.1, y - h * 0.2, x + w, y, x, y + w * 0.4], '#1d78b3', '#123e5a', 0.7);
}

export const NEUTRAL_ART: Record<string, ArtDef> = {
  mineral: {
    pad: 8,
    frames: 3,
    draw(ctx, _c, f) {
      ellipse(ctx, 2, 8, 32, 9, 0, 'rgba(0,0,0,0.35)');
      const r = rnd(7 + f);
      const n = [7, 5, 3][f];
      const scale = [1, 0.8, 0.6][f];
      const pts: [number, number, number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const x = -24 + (48 * (i + 0.5)) / n + (r() - 0.5) * 6;
        const y = 8 + (r() - 0.5) * 6;
        pts.push([x, y, (14 + r() * 14) * scale, (4 + r() * 3) * scale, (r() - 0.5) * 8]);
      }
      pts.sort((a, b) => a[1] - b[1]);
      for (const p of pts) crystal(ctx, p[0], p[1], p[2], p[3], p[4]);
      glow(ctx, 0, -2, 22, '#7fdcff', 0.18);
    },
  },
  geyser: {
    pad: 8,
    draw(ctx) {
      ellipse(ctx, 3, 6, 46, 42, 0, 'rgba(0,0,0,0.35)');
      const r = rnd(3);
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const k = 1 + (r() - 0.5) * 0.18;
        const x = Math.cos(a) * 44 * k;
        const y = Math.sin(a) * 40 * k;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = dome(ctx, 0, 0, 44, '#6b6256', 0.35);
      ctx.fill();
      ctx.strokeStyle = '#2b251e';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      circle(ctx, 0, 0, 26, dome(ctx, 4, 4, 26, tone('#4b443b', -0.1), -0.5), '#2b251e', 1);
      ellipse(ctx, 0, 0, 14, 12, 0, '#183a20', '#0c1d10', 1);
      glow(ctx, 0, 0, 22, '#5fe07a', 0.55);
      for (let i = 0; i < 5; i++) {
        const a = r() * Math.PI * 2;
        circle(ctx, Math.cos(a) * 34, Math.sin(a) * 30, 3 + r() * 4, dome(ctx, Math.cos(a) * 34, Math.sin(a) * 30, 6, '#7b7264'), '#2b251e', 0.6);
      }
    },
  },
};
