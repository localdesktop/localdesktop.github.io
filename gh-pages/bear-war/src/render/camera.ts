export class Camera {
  /** world coords of the view's top-left corner */
  x = 0;
  y = 0;
  zoom = 1;
  minZoom = 0.5;
  maxZoom = 3;
  /** view size in CSS px */
  w = 800;
  h = 600;
  /** HUD insets in CSS px: the usable viewport (for centering) */
  insetTop = 0;
  insetBottom = 0;
  worldW = 1000;
  worldH = 1000;

  toScreenX(wx: number): number {
    return (wx - this.x) * this.zoom;
  }
  toScreenY(wy: number): number {
    return (wy - this.y) * this.zoom;
  }
  toWorldX(sx: number): number {
    return sx / this.zoom + this.x;
  }
  toWorldY(sy: number): number {
    return sy / this.zoom + this.y;
  }
  get viewW(): number {
    return this.w / this.zoom;
  }
  get viewH(): number {
    return this.h / this.zoom;
  }

  centerOn(wx: number, wy: number): void {
    const usable = this.h - this.insetTop - this.insetBottom;
    this.x = wx - this.viewW / 2;
    this.y = wy - (this.insetTop + usable / 2) / this.zoom;
    this.clamp();
  }

  /** world point at the centre of the usable view */
  get centerX(): number {
    return this.x + this.viewW / 2;
  }
  get centerY(): number {
    const usable = this.h - this.insetTop - this.insetBottom;
    return this.y + (this.insetTop + usable / 2) / this.zoom;
  }

  setZoom(z: number, anchorSx = this.w / 2, anchorSy = this.h / 2): void {
    z = Math.max(this.minZoom, Math.min(this.maxZoom, z));
    const wx = this.toWorldX(anchorSx);
    const wy = this.toWorldY(anchorSy);
    this.zoom = z;
    this.x = wx - anchorSx / z;
    this.y = wy - anchorSy / z;
    this.clamp();
  }

  pan(dsx: number, dsy: number): void {
    this.x += dsx / this.zoom;
    this.y += dsy / this.zoom;
    this.clamp();
  }

  clamp(): void {
    if (!Number.isFinite(this.zoom) || this.zoom <= 0) this.zoom = Math.max(0.1, this.minZoom || 1);
    if (!Number.isFinite(this.x)) this.x = 0;
    if (!Number.isFinite(this.y)) this.y = 0;
    const margin = 64;
    const minX = -margin;
    const minY = -margin - this.insetTop / this.zoom;
    const maxX = this.worldW + margin - this.viewW;
    const maxY = this.worldH + margin + this.insetBottom / this.zoom - this.viewH;
    this.x = maxX < minX ? (minX + maxX) / 2 : Math.max(minX, Math.min(maxX, this.x));
    this.y = maxY < minY ? (minY + maxY) / 2 : Math.max(minY, Math.min(maxY, this.y));
  }
}
