import type { Entity } from './entity.ts';

/** Uniform bucket grid for fast proximity queries. Rebuilt every tick for units. */
export class SpatialHash {
  size: number;
  cols: number;
  rows: number;
  head: Int32Array;
  next: Int32Array;
  items: Entity[] = [];

  constructor(worldW: number, worldH: number, size = 64) {
    this.size = size;
    this.cols = Math.ceil(worldW / size) + 1;
    this.rows = Math.ceil(worldH / size) + 1;
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(1024);
  }

  clear(): void {
    this.head.fill(-1);
    this.items.length = 0;
  }

  insert(e: Entity): void {
    const idx = this.items.length;
    this.items.push(e);
    if (idx >= this.next.length) {
      const n = new Int32Array(this.next.length * 2);
      n.set(this.next);
      this.next = n;
    }
    let bx = Math.floor(e.x / this.size);
    let by = Math.floor(e.y / this.size);
    if (bx < 0) bx = 0;
    else if (bx >= this.cols) bx = this.cols - 1;
    if (by < 0) by = 0;
    else if (by >= this.rows) by = this.rows - 1;
    const b = by * this.cols + bx;
    this.next[idx] = this.head[b];
    this.head[b] = idx;
  }

  /** Push every entity whose centre lies in buckets overlapping the circle. Caller filters exactly. */
  query(x: number, y: number, r: number, out: Entity[]): Entity[] {
    const s = this.size;
    let x0 = Math.floor((x - r) / s);
    let x1 = Math.floor((x + r) / s);
    let y0 = Math.floor((y - r) / s);
    let y1 = Math.floor((y + r) / s);
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= this.cols) x1 = this.cols - 1;
    if (y1 >= this.rows) y1 = this.rows - 1;
    for (let by = y0; by <= y1; by++) {
      for (let bx = x0; bx <= x1; bx++) {
        for (let i = this.head[by * this.cols + bx]; i !== -1; i = this.next[i]) out.push(this.items[i]);
      }
    }
    return out;
  }
}
