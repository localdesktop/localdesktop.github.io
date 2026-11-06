// Generates the app icons (PNG) procedurally, with no dependencies:  npm run icons
// Writes public/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

type RGBA = [number, number, number, number];

const OUT = path.resolve(import.meta.dirname, '..', 'public');

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w: number, h: number, px: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

function lerp(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

function over(dst: RGBA, src: RGBA): RGBA {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a <= 0) return [0, 0, 0, 0];
  return [
    (src[0] * src[3] + dst[0] * dst[3] * (1 - src[3])) / a,
    (src[1] * src[3] + dst[1] * dst[3] * (1 - src[3])) / a,
    (src[2] * src[3] + dst[2] * dst[3] * (1 - src[3])) / a,
    a,
  ];
}

/** Sample the icon at normalised coords (0..1). */
function sample(u: number, v: number, maskable: boolean): RGBA {
  const x = u * 512;
  const y = v * 512;
  // background
  let col: RGBA = [0, 0, 0, 0];
  const r = maskable ? 0 : 104;
  const inRound = (() => {
    if (maskable) return true;
    const dx = Math.max(r - x, 0, x - (512 - r));
    const dy = Math.max(r - y, 0, y - (512 - r));
    return dx * dx + dy * dy <= r * r;
  })();
  if (inRound) {
    col = lerp([70, 42, 20, 1], [18, 10, 4, 1], v);
    const d = Math.hypot(x - 256, y - 250) / 260;
    col = over(col, [230, 150, 40, Math.max(0, 0.5 - d * 0.6)]);
  }
  // paw-print emblem (scaled down for maskable safe zone)
  const s = maskable ? 0.72 : 0.9;
  const ex = (x - 256) / s + 256;
  const ey = (y - 256) / s + 256;
  const pad = ((ex - 256) / 122) ** 2 + ((ey - 330) / 100) ** 2 < 1;
  const toe = PAW_TOES.some(([cx, cy, r]) => (ex - cx) ** 2 + (ey - cy) ** 2 < r * r);
  if (pad || toe) {
    col = over(col, lerp([255, 226, 130, 1], [196, 120, 30, 1], Math.max(0, Math.min(1, (ey - 70) / 360))));
    if (ex > 256) col = over(col, [0, 0, 0, 0.12]);
  }
  return col;
}

const PAW_TOES: [number, number, number][] = [[128, 206, 50], [204, 128, 54], [308, 128, 54], [384, 206, 50]];

function render(size: number, maskable: boolean): Buffer {
  const px = new Uint8Array(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc: [number, number, number, number] = [0, 0, 0, 0];
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const c = sample((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size, maskable);
          acc = [acc[0] + c[0] * c[3], acc[1] + c[1] * c[3], acc[2] + c[2] * c[3], acc[3] + c[3]];
        }
      }
      const n = ss * ss;
      const a = acc[3] / n;
      const o = (y * size + x) * 4;
      px[o] = a > 0 ? Math.round(acc[0] / acc[3]) : 0;
      px[o + 1] = a > 0 ? Math.round(acc[1] / acc[3]) : 0;
      px[o + 2] = a > 0 ? Math.round(acc[2] / acc[3]) : 0;
      px[o + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, px);
}

writeFileSync(path.join(OUT, 'icon-192.png'), render(192, false));
writeFileSync(path.join(OUT, 'icon-512.png'), render(512, false));
writeFileSync(path.join(OUT, 'icon-maskable-512.png'), render(512, true));
writeFileSync(path.join(OUT, 'apple-touch-icon.png'), render(180, true));
console.log('icons written to', OUT);
