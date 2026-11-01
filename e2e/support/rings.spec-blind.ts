// Spec-blind helpers for the figure walkthroughs (Phase 2 Round 3): find an OUTLINE in a screenshot, by pixels alone.
//
// The spec says what the owner sees, not which element draws it: "Hovering one gives it a faint outline (nothing pops up); a click selects
// it" (Marks, figures and areas); "A figure comment shows an outline, not a highlight"; an area is a rectangle. So a figure's outline is
// judged from two screenshots (before and after), or from the colour the design tokens give it, and never from a class name:
//   - an outline is a line along EACH of the four sides of a box (at least `minCover` of the middle of the side is changed or coloured);
//   - its box is where those four lines are, so it can be compared with the hand-drawn box of the figure (IoU);
//   - its weight is how many pixels thick the lines are, and what colour they have.
// A tint over the whole figure is not an outline: its "lines" come out as thick as the figure.
//
// Pure functions of images: no browser in here (see rings.spec-blind.test.ts for the table-driven check of the detector itself).
import type { Box, Img } from './tl-paint.spec-blind';

export type RGB = [number, number, number];

/** A screenshot (or a clip of one). `ox` and `oy` are where its top-left is in the window, in CSS px; `dpr` is device px per CSS px. */
export interface Frame {
  img: Img;
  dpr: number;
  ox: number;
  oy: number;
}

export const frameOf = (img: Img, dpr = 1, ox = 0, oy = 0): Frame => ({ img, dpr, ox, oy });

export const dist = (a: RGB, b: RGB): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** The colour at a device pixel of the frame (white outside it). */
export function pixelAt(f: Frame, dx: number, dy: number): RGB {
  if (dx < 0 || dy < 0 || dx >= f.img.width || dy >= f.img.height) return [255, 255, 255];
  const o = (dy * f.img.width + dx) * 4;
  return [f.img.data[o], f.img.data[o + 1], f.img.data[o + 2]];
}

/** A test of one device pixel. */
export type Probe = (dx: number, dy: number) => boolean;

/** Pixels that differ between two frames of the same clip by more than `tol` in some channel. */
export const changed =
  (before: Frame, after: Frame, tol = 18): Probe =>
  (dx, dy) =>
    dist(pixelAt(before, dx, dy), pixelAt(after, dx, dy)) > tol;

/** Pixels within `tol` of `colour`. */
export const near =
  (after: Frame, colour: RGB, tol = 40): Probe =>
  (dx, dy) =>
    dist(pixelAt(after, dx, dy), colour) <= tol;

export interface Side {
  /** Where the line is: its y for the top and bottom, its x for the left and right. CSS px in the window. */
  at: number;
  /** How thick it is, in CSS px. */
  thickness: number;
  /** The share of the side's middle it covers (0 to 1). */
  strength: number;
  /** Its colour: the row (or column) of the line whose colour is nearest `prefer`, or the strongest one. */
  colour: RGB;
}

export interface Ring {
  top: Side | null;
  bottom: Side | null;
  left: Side | null;
  right: Side | null;
  /** How many of the four sides have a line (0 to 4). */
  found: number;
  /** The box the four lines make, when all four are there. */
  box: Box | null;
  /** The overlap (intersection over union) of that box with the box that was looked for; 0 when there is no ring. */
  iou: number;
  /** The thickest of the lines, in CSS px (0 when there is none). */
  thickness: number;
}

export interface RingOptions {
  /** How far from each side of the looked-for box (CSS px, inside and outside) the line may be. */
  band: number;
  /** The share of a side's middle a row must cover to count as a line (default 0.6). */
  minCover?: number;
  /** The share of each end of a side that is left out, so a corner does not matter (default 0.15). */
  inset?: number;
  /** When there are several rows in a line, the colour reported is the one nearest this. */
  prefer?: RGB;
}

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - inter);
}

/** One side. `axis` 'row': a horizontal line, `centre` is its expected y; 'col': a vertical line, `centre` is its expected x. */
function scanSide(f: Frame, probe: Probe, axis: 'row' | 'col', centre: number, from: number, to: number, o: Required<Omit<RingOptions, 'prefer'>> & { prefer?: RGB }): Side | null {
  const origin = axis === 'row' ? f.oy : f.ox;
  const across = axis === 'row' ? f.img.height : f.img.width;
  const alongOrigin = axis === 'row' ? f.ox : f.oy;
  const along = axis === 'row' ? f.img.width : f.img.height;
  const lo = Math.max(0, Math.floor((centre - origin - o.band) * f.dpr));
  const hi = Math.min(across - 1, Math.ceil((centre - origin + o.band) * f.dpr));
  const s0 = Math.max(0, Math.floor((from - alongOrigin) * f.dpr));
  const s1 = Math.min(along - 1, Math.ceil((to - alongOrigin) * f.dpr));
  if (hi < lo || s1 <= s0) return null;
  const count = s1 - s0 + 1;
  const cover: number[] = [];
  const colours: RGB[] = [];
  for (let i = lo; i <= hi; i++) {
    let n = 0;
    const sum = [0, 0, 0];
    for (let j = s0; j <= s1; j++) {
      const x = axis === 'row' ? j : i;
      const y = axis === 'row' ? i : j;
      if (probe(x, y)) {
        n++;
        const p = pixelAt(f, x, y);
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
      }
    }
    cover.push(n / count);
    colours.push(n === 0 ? [255, 255, 255] : [sum[0] / n, sum[1] / n, sum[2] / n]);
  }
  // The strongest run of consecutive rows that each cover enough.
  let best: { from: number; to: number; weight: number } | null = null;
  let start = -1;
  let weight = 0;
  for (let k = 0; k <= cover.length; k++) {
    const on = k < cover.length && cover[k] >= o.minCover;
    if (on) {
      if (start < 0) {
        start = k;
        weight = 0;
      }
      weight += cover[k];
    } else if (start >= 0) {
      if (best === null || weight > best.weight) best = { from: start, to: k - 1, weight };
      start = -1;
    }
  }
  if (best === null) return null;
  const rows = Array.from({ length: best.to - best.from + 1 }, (_, i) => best.from + i);
  const pick = o.prefer === undefined ? rows.reduce((a, b) => (cover[b] > cover[a] ? b : a)) : rows.reduce((a, b) => (dist(colours[b], o.prefer!) < dist(colours[a], o.prefer!) ? b : a));
  return {
    at: (lo + (best.from + best.to + 1) / 2) / f.dpr + origin,
    thickness: rows.length / f.dpr,
    strength: best.weight / rows.length,
    colour: colours[pick].map(Math.round) as RGB,
  };
}

/** Looks for a line along each side of `box` (CSS px in the window), wherever the probe says a pixel counts. */
export function findRing(frame: Frame, probe: Probe, box: Box, opts: RingOptions): Ring {
  const o = { minCover: 0.6, inset: 0.15, ...opts };
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  const x0 = box.left + o.inset * w;
  const x1 = box.right - o.inset * w;
  const y0 = box.top + o.inset * h;
  const y1 = box.bottom - o.inset * h;
  const top = scanSide(frame, probe, 'row', box.top, x0, x1, o);
  const bottom = scanSide(frame, probe, 'row', box.bottom, x0, x1, o);
  const left = scanSide(frame, probe, 'col', box.left, y0, y1, o);
  const right = scanSide(frame, probe, 'col', box.right, y0, y1, o);
  const sides = [top, bottom, left, right];
  const found = sides.filter((s) => s !== null).length;
  const made = top && bottom && left && right ? { left: left.at, right: right.at, top: top.at, bottom: bottom.at } : null;
  return {
    top,
    bottom,
    left,
    right,
    found,
    box: made,
    iou: made ? iou(made, box) : 0,
    thickness: Math.max(0, ...sides.map((s) => s?.thickness ?? 0)),
  };
}

/** The mean change (largest channel, 0 to 255) over the inside of `box`, shrunk by `inset` CSS px: 0 when nothing in there changed. */
export function meanChange(before: Frame, after: Frame, box: Box, inset = 8): number {
  const x0 = Math.max(0, Math.ceil((box.left + inset - after.ox) * after.dpr));
  const x1 = Math.min(after.img.width - 1, Math.floor((box.right - inset - after.ox) * after.dpr));
  const y0 = Math.max(0, Math.ceil((box.top + inset - after.oy) * after.dpr));
  const y1 = Math.min(after.img.height - 1, Math.floor((box.bottom - inset - after.oy) * after.dpr));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      sum += dist(pixelAt(before, x, y), pixelAt(after, x, y));
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** The share of the pixels of `box` (CSS px) that the probe counts. */
export function shareOf(frame: Frame, probe: Probe, box: Box): number {
  const x0 = Math.max(0, Math.floor((box.left - frame.ox) * frame.dpr));
  const x1 = Math.min(frame.img.width - 1, Math.ceil((box.right - frame.ox) * frame.dpr));
  const y0 = Math.max(0, Math.floor((box.top - frame.oy) * frame.dpr));
  const y1 = Math.min(frame.img.height - 1, Math.ceil((box.bottom - frame.oy) * frame.dpr));
  let n = 0;
  let hit = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      n++;
      if (probe(x, y)) hit++;
    }
  }
  return n === 0 ? 0 : hit / n;
}

/** How much a picture has in it: the share of its pixels that are not the picture's most common colour (steps of 8). 0 for a flat rectangle. */
export function variety(img: Img): number {
  const counts = new Map<number, number>();
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const k = ((img.data[i * 4] >> 3) << 10) | ((img.data[i * 4 + 1] >> 3) << 5) | (img.data[i * 4 + 2] >> 3);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const most = Math.max(0, ...counts.values());
  return n === 0 ? 0 : 1 - most / n;
}

export const hexOf = (c: RGB): string => `#${c.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;

/** One line for a failure message. */
export function describeRing(r: Ring): string {
  const side = (name: string, s: Side | null): string => (s === null ? `${name}: none` : `${name}: ${s.thickness.toFixed(1)} px thick at ${s.at.toFixed(0)}, ${hexOf(s.colour)}`);
  return `${r.found} of 4 sides (${side('top', r.top)}; ${side('bottom', r.bottom)}; ${side('left', r.left)}; ${side('right', r.right)})${r.box ? `, IoU ${r.iou.toFixed(2)} with the figure's box` : ''}`;
}
