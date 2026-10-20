import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export interface ScaledImage {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** Device pixels per image pixel (multiply image coordinates by this to tap). */
  scale: number;
}

/**
 * Downscales a PNG so its longest side is ≤ maxSize (box filter) and encodes it as JPEG or PNG.
 * Agents get a small image; taps map back to device pixels via `scale`.
 */
export function downscalePng(png: Buffer, maxSize: number, format: "jpeg" | "png" = "jpeg", quality = 80): ScaledImage {
  const src = PNG.sync.read(png);
  const longest = Math.max(src.width, src.height);
  const factor = longest > maxSize ? longest / maxSize : 1;
  const width = Math.max(1, Math.round(src.width / factor));
  const height = Math.max(1, Math.round(src.height / factor));
  const out = factor === 1 ? src.data : boxResize(src.data, src.width, src.height, width, height);
  const data =
    format === "png"
      ? PNG.sync.write(Object.assign(new PNG({ width, height }), { data: Buffer.from(out) }))
      : Buffer.from(jpeg.encode({ data: out, width, height }, quality).data);
  return { data, mimeType: format === "png" ? "image/png" : "image/jpeg", width, height, scale: src.width / width };
}

function boxResize(src: Buffer | Uint8Array, sw: number, sh: number, dw: number, dh: number): Buffer {
  const dst = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * xRatio)));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          a += src[i + 3]!;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      dst[o] = r / n;
      dst[o + 1] = g / n;
      dst[o + 2] = b / n;
      dst[o + 3] = a / n;
    }
  }
  return dst;
}
