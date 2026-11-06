// Dev-only page: renders every sprite at large scale (open /gallery.html with `npm run dev`).
import { DEFS } from '../game/data/index.ts';
import { SpriteCache } from '../render/sprites.ts';
import { ART } from '../render/art/index.ts';

const sprites = new SpriteCache(3, 2);
const q = new URLSearchParams(location.search);
const colors = (q.get('colors') ?? '1,0').split(',').map(Number);
const scale = Number(q.get('scale') ?? 2);

const only = q.get('race');
const kind = q.get('kind');
for (const race of ['ironpaw', 'horde', 'starborn', 'neutral'] as const) {
  if (only && only !== race) continue;
  const h = document.createElement('h2');
  h.textContent = race;
  document.body.appendChild(h);
  const grid = document.createElement('div');
  grid.className = 'grid';
  document.body.appendChild(grid);
  for (const def of Object.values(DEFS).filter((d) => d.race === race && (!kind || (kind === 'building') === (d.kind === 'building')))) {
    for (const color of race === 'neutral' ? [-1] : colors) {
      const art = sprites.art(def);
      const frames = art.frames ?? 1;
      for (let f = 0; f < Math.min(frames, q.has('frames') ? 4 : 1); f++) {
        const s = sprites.get(def, color, 'body', f)!;
        const c = document.createElement('canvas');
        c.width = s.w * scale;
        c.height = s.h * scale;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(s.canvas, 0, 0, c.width, c.height);
        const t = sprites.get(def, color, 'turret', f);
        if (t) ctx.drawImage(t.canvas, (c.width - t.w * scale) / 2, (c.height - t.h * scale) / 2, t.w * scale, t.h * scale);
        if (art.overlay) {
          ctx.save();
          ctx.translate(c.width / 2, c.height / 2);
          ctx.scale(scale, scale);
          art.overlay(ctx, { main: '#2f6fe8', light: '#78a6ff', dark: '#14306e', index: color }, { t: 1, built: true, powered: true, working: true, seed: 1 }, def);
          ctx.restore();
        }
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.appendChild(c);
        const label = document.createElement('span');
        label.textContent = def.id + (frames > 1 ? ` f${f}` : '') + (ART[def.art ?? def.id] ? '' : ' (placeholder)');
        cell.appendChild(label);
        grid.appendChild(cell);
      }
    }
  }
}
