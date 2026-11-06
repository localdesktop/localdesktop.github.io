// Tiny DOM helpers for menu screens.

import { loadMap } from '../game/map/maps.ts';
import { TerrainRenderer } from '../render/terrain.ts';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') e.innerHTML = String(v);
    else if (k in e && typeof v !== 'string') (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = h('select', { onchange: () => onChange(s.value) });
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    s.appendChild(opt);
  }
  return s;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}


const previewCache = new Map<string, HTMLCanvasElement>();

/** Small top-down preview of a map with its start locations marked. */
export function mapPreview(mapId: string, size = 150): HTMLCanvasElement {
  const key = `${mapId}|${size}`;
  const hit = previewCache.get(key);
  if (hit) {
    const c = document.createElement('canvas');
    c.width = hit.width;
    c.height = hit.height;
    c.getContext('2d')!.drawImage(hit, 0, 0);
    c.className = 'map-preview';
    return c;
  }
  const map = loadMap(mapId);
  const terr = new TerrainRenderer(map);
  const img = terr.minimapImage(2);
  const k = size / Math.max(map.w, map.h);
  const c = document.createElement('canvas');
  c.width = Math.round(map.w * k);
  c.height = Math.round(map.h * k);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  for (const r of map.resources) {
    ctx.fillStyle = r.kind === 'mineral' ? '#7fdcff' : '#4fd06a';
    ctx.fillRect(r.tx * k, r.ty * k, Math.max(1, (r.kind === 'mineral' ? 2 : 3) * k), Math.max(1, (r.kind === 'mineral' ? 1 : 3) * k));
  }
  ctx.font = `bold ${Math.round(size / 11)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of map.starts) {
    const x = (b.tx + 2.5) * k;
    const y = (b.ty + 2.5) * k;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(x, y, size / 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd36b';
    ctx.fillText(String(b.start + 1), x, y + 1);
  }
  previewCache.set(key, c);
  return mapPreview(mapId, size);
}
