// Small geometry helpers for the DB detector's post-processing: convex hull, minimum-area rectangle, and the XY-cut that puts
// detected lines into reading order. Pure functions, no DOM. Ported unchanged from the Phase 7.0 bake-off
// (spikes/phase7-ocr/src/ocr/geom.ts), where they were measured (docs/spikes/phase7-ocr-report.md).

/** A box in pixels of the image given to the recogniser. */
export interface PxBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** A rectangle that may be rotated: centre, unit axis `u` (the reading direction), unit axis `v` (down), and the sizes along them. */
export interface RotRect {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
}

/** Andrew's monotone chain on packed integer points; returns hull vertices counter-clockwise. */
export function convexHull(xs: number[], ys: number[]): Pt[] {
  const n = xs.length;
  const order = new Array<number>(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => xs[a]! - xs[b]! || ys[a]! - ys[b]!);
  const pts: Pt[] = [];
  for (const i of order) {
    const last = pts[pts.length - 1];
    if (!last || last.x !== xs[i] || last.y !== ys[i]) pts.push({ x: xs[i]!, y: ys[i]! });
  }
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Minimum-area bounding rectangle of a convex hull (rotating calipers, brute force over the edges). Pixel corners: +1 is added to the extents. */
export function minAreaRect(hull: Pt[]): RotRect | null {
  if (hull.length === 0) return null;
  if (hull.length < 3) {
    const xs = hull.map((p) => p.x);
    const ys = hull.map((p) => p.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0 + 1;
    const h = Math.max(...ys) - y0 + 1;
    return { cx: x0 + w / 2, cy: y0 + h / 2, ux: 1, uy: 0, vx: 0, vy: 1, w, h };
  }
  let best: RotRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    let ex = b.x - a.x;
    let ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    ex /= len;
    ey /= len;
    const nx = -ey;
    const ny = ex;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const du = (p.x - a.x) * ex + (p.y - a.y) * ey;
      const dv = (p.x - a.x) * nx + (p.y - a.y) * ny;
      if (du < minU) minU = du;
      if (du > maxU) maxU = du;
      if (dv < minV) minV = dv;
      if (dv > maxV) maxV = dv;
    }
    const w = maxU - minU + 1;
    const h = maxV - minV + 1;
    const area = w * h;
    if (area < bestArea) {
      bestArea = area;
      const mu = (minU + maxU) / 2;
      const mv = (minV + maxV) / 2;
      best = { cx: a.x + ex * mu + nx * mv + 0.5, cy: a.y + ey * mu + ny * mv + 0.5, ux: ex, uy: ey, vx: nx, vy: ny, w, h };
    }
  }
  if (!best) return null;
  // Name the axes so that u is the one closer to horizontal and points right, v points down.
  let { ux, uy, vx, vy, w, h } = best;
  if (Math.abs(ux) < Math.abs(uy)) {
    [ux, uy, vx, vy] = [vx, vy, ux, uy];
    [w, h] = [h, w];
  }
  if (ux < 0) {
    ux = -ux;
    uy = -uy;
  }
  if (vy < 0) {
    vx = -vx;
    vy = -vy;
  }
  return { ...best, ux, uy, vx, vy, w, h };
}

export function rectToBox(r: RotRect): PxBox {
  const hw = (Math.abs(r.ux) * r.w + Math.abs(r.vx) * r.h) / 2;
  const hh = (Math.abs(r.uy) * r.w + Math.abs(r.vy) * r.h) / 2;
  return { x: r.cx - hw, y: r.cy - hh, width: hw * 2, height: hh * 2 };
}

export interface LineItem {
  box: PxBox;
  /** The line's own (rotated-rectangle) height. A skewed line's axis-aligned box is taller than the line, so rows are told apart by this. */
  h?: number;
}

/** Top-to-bottom, then left-to-right; boxes whose vertical centres are within half a line height count as one row. */
function rowMajor<T extends LineItem>(a: T, b: T): number {
  const ca = a.box.y + a.box.height / 2;
  const cb = b.box.y + b.box.height / 2;
  const tol = Math.min(a.h ?? a.box.height, b.h ?? b.box.height) * 0.5;
  if (Math.abs(ca - cb) <= tol) return a.box.x - b.box.x;
  return ca - cb;
}

/**
 * XY-cut reading order for detected lines. Splits the set by the widest empty vertical band (a column gutter) if
 * there is one, else by the widest empty horizontal band (a paragraph or heading break), and recurses; leaves are
 * blocks, read top to bottom. Returns the lines in reading order with a block number each.
 */
export function readingOrder<T extends LineItem>(items: T[], pageW: number): { item: T; block: number }[] {
  const out: { item: T; block: number }[] = [];
  let block = 0;
  const minColGap = Math.max(12, pageW * 0.015);

  const gaps = (list: T[], axis: 'x' | 'y') => {
    const lo = (it: T) => (axis === 'x' ? it.box.x : it.box.y);
    const hi = (it: T) => (axis === 'x' ? it.box.x + it.box.width : it.box.y + it.box.height);
    const sorted = [...list].sort((a, b) => lo(a) - lo(b));
    let reach = hi(sorted[0]!);
    let best = { size: 0, at: -1 };
    for (let i = 1; i < sorted.length; i++) {
      const gap = lo(sorted[i]!) - reach;
      if (gap > best.size) best = { size: gap, at: i };
      reach = Math.max(reach, hi(sorted[i]!));
    }
    return { sorted, best };
  };

  const leaf = (list: T[]) => {
    for (const it of [...list].sort(rowMajor)) out.push({ item: it, block });
    block++;
  };

  const cut = (list: T[], depth: number): void => {
    if (list.length <= 1 || depth > 14) return leaf(list);
    const heights = list.map((l) => l.h ?? l.box.height).sort((a, b) => a - b);
    const medianH = heights[list.length >> 1]!;
    const cols = gaps(list, 'x');
    if (cols.best.size > minColGap && list.length >= 4 && cols.best.at >= 2 && list.length - cols.best.at >= 2) {
      cut(cols.sorted.slice(0, cols.best.at), depth + 1);
      cut(cols.sorted.slice(cols.best.at), depth + 1);
      return;
    }
    const rows = gaps(list, 'y');
    if (rows.best.size > medianH * 0.9) {
      cut(rows.sorted.slice(0, rows.best.at), depth + 1);
      cut(rows.sorted.slice(rows.best.at), depth + 1);
      return;
    }
    leaf(list);
  };
  cut(items, 0);
  return out;
}
