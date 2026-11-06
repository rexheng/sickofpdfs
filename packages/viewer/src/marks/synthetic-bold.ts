// Synthetic bold (ruling R90b): a glyph's own outline pushed outward along its edges, as font engines embolden a face
// that has no bold, then filled in the glyph's colour on exactly the page bitmap's pixel grid. Bold word starts (R90),
// the owner's bold marks and print with marks all draw bold this way, so there is one bold look.
//
// Pure geometry, no DOM: the engine worker uses it to calibrate against the PDF's own bold face, the viewer and print
// to draw.
//
// Outlines are PDFium's glyph paths (FPDFFont_GetGlyphPath): one segment per point, [type, x, y, close] four numbers a
// segment, type 2 a move, 0 a line, 1 a cubic Bézier point (three in a row: two controls and the end), in ems, y up.
import type { PageSize, PdfRect, Rotation } from '../backend/types';
import { totalRotation, turnMatrix, type TurnMatrix } from '../view/page-transform';

/** A glyph outline in ems, y up: [type, x, y, close] per segment (see the file comment). */
export type EmPath = ArrayLike<number>;

const MOVETO = 2;
const BEZIERTO = 1;

/**
 * Where each contour starts, as segment indices, then the segment count: contour c is segments [starts[c],
 * starts[c + 1]). A contour starts at a move. (Plain indices, no array a contour: this runs for every new glyph shape.)
 */
function contourStarts(em: EmPath): number[] {
  const n = em.length / 4;
  const out: number[] = [];
  for (let s = 0; s < n; s++) if (s === 0 || em[4 * s] === MOVETO) out.push(s);
  out.push(n);
  return out;
}

/**
 * FreeType's FT_Outline_Get_Orientation: the sign of the outline's area, summed over its contours' points (control
 * points included). Positive: PostScript (outer contours counter-clockwise, y up); negative: TrueType; 0: none.
 */
export function outlineOrientation(em: EmPath): number {
  let area = 0;
  const starts = contourStarts(em);
  for (let c = 0; c + 1 < starts.length; c++) {
    const end = starts[c + 1];
    let px = em[4 * (end - 1) + 1];
    let py = em[4 * (end - 1) + 2];
    for (let s = starts[c]; s < end; s++) {
      const x = em[4 * s + 1];
      const y = em[4 * s + 2];
      area += (y - py) * (x + px);
      px = x;
      py = y;
    }
  }
  return Math.sign(area);
}

/**
 * A port of FreeType's FT_Outline_EmboldenXY to floats. Each point moves along the bisector of its two edges, so every
 * edge moves outward by half the strength: the glyph grows by `xStrength` across and `yStrength` up and down. Across,
 * it grows about its own place, both sides alike (FreeType shifts it right as well, to keep its left bearing for a new
 * advance; over text that is already set, growing in place keeps the bold on the glyph). Up and down, the whole glyph
 * then moves up by `yShift`, as FreeType moves it to keep the baseline: with `yShift` = `yStrength` / 2 the bottoms
 * stay and the tops rise by `yStrength`. Corners stay sharp: a corner point moves diagonally, so both its edges move
 * out in parallel. The shift is limited where a turn is sharp and its edges are short, as FreeType does, so thin
 * features do not fold over. Then the whole glyph moves right by `xShift`: growing by sL + sR and moving by
 * (sR − sL) / 2 grows every stem sL on its left and sR on its right (R90c: each side as far as its neighbour allows).
 * Ems in, ems out (a new array, same layout).
 */
export function emboldenOutline(em: EmPath, xStrength: number, yStrength: number, yShift = 0, xShift = 0): Float64Array {
  const out = Float64Array.from(em);
  embolden(out, em, xStrength / 2, yStrength / 2);
  if (yShift !== 0) for (let s = 0; s < out.length / 4; s++) out[4 * s + 2] = out[4 * s + 2] + yShift;
  if (xShift !== 0) for (let s = 0; s < out.length / 4; s++) out[4 * s + 1] = out[4 * s + 1] + xShift;
  return out;
}

/** emboldenOutline's work, in place on `out` (a copy of `em`); `xs` and `ys` are half the strengths. */
function embolden(out: Float64Array, em: EmPath, xs: number, ys: number): void {
  if (xs === 0 && ys === 0) return;
  const orientation = outlineOrientation(em);
  if (orientation === 0) return;
  const trueType = orientation < 0;
  const starts = contourStarts(em);
  for (let ci = 0; ci + 1 < starts.length; ci++) {
    const base = starts[ci];
    const m = starts[ci + 1] - base;
    if (m < 2) continue;
    const next = (p: number) => (p < m - 1 ? p + 1 : 0);
    const X = (p: number) => out[4 * (base + p) + 1];
    const Y = (p: number) => out[4 * (base + p) + 2];
    let inX = 0;
    let inY = 0;
    let lIn = 0;
    let anchorX = 0;
    let anchorY = 0;
    let lAnchor = 0;
    // j cycles through the points; i advances only when points are moved; k is the first moved point (FreeType's names).
    let i = m - 1;
    let k = -1;
    for (let j = 0; j !== i && i !== k; j = next(j)) {
      let outX: number;
      let outY: number;
      let lOut: number;
      if (j !== k) {
        outX = X(j) - X(i);
        outY = Y(j) - Y(i);
        lOut = Math.hypot(outX, outY);
        if (lOut === 0) continue;
        outX /= lOut;
        outY /= lOut;
      } else {
        outX = anchorX;
        outY = anchorY;
        lOut = lAnchor;
      }
      if (lIn !== 0) {
        if (k < 0) {
          k = i;
          anchorX = inX;
          anchorY = inY;
          lAnchor = lIn;
        }
        let d = inX * outX + inY * outY;
        let shiftX = 0;
        let shiftY = 0;
        // Shift only where the turn is less than about 160 degrees.
        if (d > -0.9375) {
          d += 1;
          shiftX = inY + outY;
          shiftY = inX + outX;
          if (trueType) shiftX = -shiftX;
          else shiftY = -shiftY;
          // Restrict the shift where segments are short, so collapsing segments do not overshoot.
          let q = outX * inY - outY * inX;
          if (trueType) q = -q;
          const l = Math.min(lIn, lOut);
          shiftX = xs * q <= l * d ? (shiftX * xs) / d : (shiftX * l) / q;
          shiftY = ys * q <= l * d ? (shiftY * ys) / d : (shiftY * l) / q;
        }
        for (; i !== j; i = next(i)) {
          out[4 * (base + i) + 1] = X(i) + shiftX;
          out[4 * (base + i) + 2] = Y(i) + shiftY;
        }
      } else {
        i = j;
      }
      inX = outX;
      inY = outY;
      lIn = lOut;
    }
  }
}

/**
 * Each contour as a closed polyline (Béziers cut into `steps` pieces), in typed arrays: the points (x, y in turn) and
 * where each polyline ends (point indices: polyline p is [ends[p - 1] ?? 0, ends[p])). A contour of fewer than two
 * points is left out.
 */
export function flatOutline(em: EmPath, steps: number): { pts: Float64Array; ends: number[] } {
  const n = em.length / 4;
  const pts = new Float64Array(2 * Math.max(1, n) * steps);
  const ends: number[] = [];
  let k = 0; // points written
  let start = 0; // the open polyline's first point
  let cx = 0;
  let cy = 0;
  for (let s = 0; s < n; s++) {
    const type = em[4 * s];
    if (s > 0 && type === MOVETO) {
      if (k - start > 1) ends.push(k);
      else k = start;
      start = k;
      cx = 0;
      cy = 0;
    }
    const x = em[4 * s + 1];
    const y = em[4 * s + 2];
    if (type === BEZIERTO && s + 2 < n && em[4 * (s + 1)] === BEZIERTO && em[4 * (s + 2)] === BEZIERTO) {
      const x2 = em[4 * (s + 1) + 1];
      const y2 = em[4 * (s + 1) + 2];
      const x3 = em[4 * (s + 2) + 1];
      const y3 = em[4 * (s + 2) + 2];
      for (let t = 1; t <= steps; t++) {
        const u = t / steps;
        const v = 1 - u;
        pts[2 * k] = v * v * v * cx + 3 * v * v * u * x + 3 * v * u * u * x2 + u * u * u * x3;
        pts[2 * k + 1] = v * v * v * cy + 3 * v * v * u * y + 3 * v * u * u * y2 + u * u * u * y3;
        k++;
      }
      cx = x3;
      cy = y3;
      s += 2;
      continue;
    }
    pts[2 * k] = x;
    pts[2 * k + 1] = y;
    k++;
    cx = x;
    cy = y;
  }
  if (k - start > 1) ends.push(k);
  return { pts, ends };
}

/** Each contour as a closed polyline (Béziers cut into `steps` pieces), for scanning. */
export function flatten(em: EmPath, steps = 8): [number, number][][] {
  const { pts, ends } = flatOutline(em, steps);
  const polys: [number, number][][] = [];
  let a = 0;
  for (const b of ends) {
    const poly: [number, number][] = [];
    for (let k = a; k < b; k++) poly.push([pts[2 * k], pts[2 * k + 1]]);
    polys.push(poly);
    a = b;
  }
  return polys;
}

/** Where the line y = `at` (or x = `at`, `vertical`) is inside the polylines (nonzero winding): [from, to] intervals, in order. */
export function scan(polys: readonly (readonly [number, number][])[], at: number, vertical = false): [number, number][] {
  const hits: [number, number][] = [];
  const u = vertical ? 1 : 0; // the coordinate the line runs along
  const v = vertical ? 0 : 1; // the coordinate it is fixed in
  for (const poly of polys) {
    for (let p = 0; p < poly.length; p++) {
      const a = poly[p];
      const b = poly[(p + 1) % poly.length];
      if ((a[v] <= at && b[v] > at) || (b[v] <= at && a[v] > at)) hits.push([a[u] + ((at - a[v]) * (b[u] - a[u])) / (b[v] - a[v]), b[v] > a[v] ? 1 : -1]);
    }
  }
  hits.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let wind = 0;
  let start = 0;
  for (const [pos, dir] of hits) {
    const was = wind;
    wind += dir;
    if (was === 0 && wind !== 0) start = pos;
    else if (was !== 0 && wind === 0 && pos > start) out.push([start, pos]);
  }
  return out;
}

/** The bounding box of an outline's points (control points included). */
export function outlineBox(em: EmPath): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let s = 0; s < em.length / 4; s++) {
    const x = em[4 * s + 1];
    const y = em[4 * s + 2];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/** How much of each counter's width and height emboldening must leave open (R90b: counters stay open). */
export const COUNTER_KEEP = 0.55;
/** How much of each hole's area (the eye of "e", the bowl of "a", "o") emboldening must leave open. */
export const HOLE_AREA_KEEP = 0.72;

/** The holes of an outline (contours wound against its outer ones): each one's width and height, ems. */
export function holeSizes(em: EmPath): { w: number; h: number }[] {
  const orientation = outlineOrientation(em);
  if (orientation === 0) return [];
  const out: { w: number; h: number }[] = [];
  const { pts, ends } = flatOutline(em, 4);
  let a = 0;
  for (const b of ends) {
    let area = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let p = a; p < b; p++) {
      const q = p + 1 < b ? p + 1 : a;
      const ax = pts[2 * p];
      const ay = pts[2 * p + 1];
      const bx = pts[2 * q];
      const by = pts[2 * q + 1];
      area += (by - ay) * (bx + ax);
      x0 = Math.min(x0, ax);
      x1 = Math.max(x1, ax);
      y0 = Math.min(y0, ay);
      y1 = Math.max(y1, ay);
    }
    if (area !== 0 && Math.sign(area) !== orientation) out.push({ w: x1 - x0, h: y1 - y0 });
    a = b;
  }
  return out;
}

/**
 * The share (0–1) of the strengths `x` and `y` (ems, both sides together) that keeps every hole at least
 * HOLE_AREA_KEEP of its area: a hole w × h becomes (w − t·x) × (h − t·y).
 */
export function holeShare(holes: readonly { w: number; h: number }[], x: number, y: number): number {
  let t = 1;
  for (const { w, h } of holes) {
    const keep = HOLE_AREA_KEEP * w * h;
    if ((w - x) * (h - y) >= keep) continue;
    // (w − t·x)(h − t·y) = keep: the smaller root.
    const A = x * y;
    const B = w * y + h * x;
    const C = w * h - keep;
    const root = A === 0 ? C / B : (B - Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
    t = Math.min(t, Math.max(0, root));
  }
  return t;
}

/** A gap narrower than this (ems) is a notch, not a counter: a real bold fills it (the crotch of an arch and a stem). */
const MIN_COUNTER_EM = 0.03;
/** Lines across the glyph that counterLimits reads, as shares of its size (neighbours a step apart). */
const COUNTER_LINES = [0.2, 0.275, 0.35, 0.425, 0.5, 0.575, 0.65, 0.725, 0.8];

/**
 * For each of `lines` (ascending positions across the glyph: y = at, or x = at when `vertical`), the gaps between the
 * inside stretches of that line through the edges (x0, y0, x1, y1 per edge), as [from, to] pairs in order. One pass
 * over the edges finds every line each crosses.
 */
function gapsOnLines(edges: Float64Array, lines: readonly number[], vertical: boolean): number[][] {
  const u = vertical ? 1 : 0;
  const v = vertical ? 0 : 1;
  const count = lines.length;
  const hits: number[][] = lines.map(() => []);
  const first = lines[0];
  const step = count > 1 ? (lines[count - 1] - first) / (count - 1) : 0;
  for (let e = 0; e < edges.length; e += 4) {
    const av = edges[e + v];
    const bv = edges[e + 2 + v];
    const lo = av < bv ? av : bv;
    // The first line it may cross (a line lower down cannot be crossed); a step early, for rounding.
    let j = step > 0 ? Math.max(0, Math.floor((lo - first) / step) - 1) : 0;
    for (; j < count; j++) {
      const at = lines[j];
      if (at >= (av < bv ? bv : av)) break;
      if ((av <= at && bv > at) || (bv <= at && av > at)) {
        const au = edges[e + u];
        hits[j].push(au + ((at - av) * (edges[e + 2 + u] - au)) / (bv - av), bv > av ? 1 : -1);
      }
    }
  }
  return hits.map((h) => {
    const order = Array.from({ length: h.length / 2 }, (_, k) => k).sort((a, b) => h[2 * a] - h[2 * b]);
    const gaps: number[] = [];
    let wind = 0;
    let lastEnd = NaN;
    for (const k of order) {
      const pos = h[2 * k];
      const was = wind;
      wind += h[2 * k + 1];
      if (was === 0 && wind !== 0 && !Number.isNaN(lastEnd) && pos > lastEnd) gaps.push(lastEnd, pos);
      if (was !== 0 && wind === 0) lastEnd = pos;
    }
    return gaps;
  });
}

/** The outline's edges as polylines (curves cut in `steps`): x0, y0, x1, y1 per edge. */
function outlineEdges(em: EmPath, steps: number): Float64Array {
  const { pts, ends } = flatOutline(em, steps);
  const edges = new Float64Array(4 * (ends.length === 0 ? 0 : ends[ends.length - 1]));
  let e = 0;
  let a = 0;
  for (const b of ends) {
    for (let p = a; p < b; p++) {
      const q = p + 1 < b ? p + 1 : a;
      edges[e++] = pts[2 * p];
      edges[e++] = pts[2 * p + 1];
      edges[e++] = pts[2 * q];
      edges[e++] = pts[2 * q + 1];
    }
    a = b;
  }
  return edges;
}

/**
 * The width of the glyph's narrowest counter across (`x`) and up and down (`y`), ems; Infinity where it has none. A
 * counter (the holes of "e", "a", "o", and the open spaces between the stems of "n", "m", "u") is a gap inside the
 * glyph, read on lines across it (COUNTER_LINES), that is still there on the lines either side over at least half its
 * width, and at least MIN_COUNTER_EM wide: the narrow notch where an arch meets a stem is not a counter, and a real
 * bold fills it too.
 */
export function counterWidths(em: EmPath): { x: number; y: number } {
  const edges = outlineEdges(em, 4);
  const box = outlineBox(em);
  const least = (vertical: boolean) => {
    const lo = vertical ? box.x0 : box.y0;
    const size = vertical ? box.x1 - box.x0 : box.y1 - box.y0;
    const lines = gapsOnLines(edges, COUNTER_LINES.map((f) => lo + f * size), vertical);
    const overlaps = (gaps: number[], g0: number, g1: number) => {
      for (let k = 0; k < gaps.length; k += 2) if (Math.min(g1, gaps[k + 1]) - Math.max(g0, gaps[k]) >= 0.5 * (g1 - g0)) return true;
      return false;
    };
    let smallest = Infinity;
    for (let l = 1; l < lines.length - 1; l++) {
      const gaps = lines[l];
      for (let k = 0; k < gaps.length; k += 2) {
        const [g0, g1] = [gaps[k], gaps[k + 1]];
        if (g1 - g0 >= MIN_COUNTER_EM && overlaps(lines[l - 1], g0, g1) && overlaps(lines[l + 1], g0, g1)) smallest = Math.min(smallest, g1 - g0);
      }
    }
    return smallest;
  };
  return { x: least(false), y: least(true) };
}

/**
 * The most each side of the glyph may move (ems, across and up and down) so that no counter closes: every counter
 * (counterWidths) keeps COUNTER_KEEP of its width and height.
 */
export function counterLimits(em: EmPath): { x: number; y: number } {
  return capsOf(counterWidths(em));
}

/** counterLimits from counterWidths. */
export function capsOf(widths: { x: number; y: number }): { x: number; y: number } {
  const share = (1 - COUNTER_KEEP) / 2;
  return { x: Number.isFinite(widths.x) ? widths.x * share : Infinity, y: Number.isFinite(widths.y) ? widths.y * share : Infinity };
}

/** The ink profile's lines: y = PROFILE_Y0 + k · PROFILE_STEP ems, k < PROFILE_LINES (from below the descenders to above the caps). */
export const PROFILE_Y0 = -0.4;
export const PROFILE_STEP = 0.025;
export const PROFILE_LINES = 60;

/**
 * Where a glyph's ink starts and ends on each profile line (ems; NaN where the line misses it): so the gap between two
 * neighbours can be read line by line, where they face each other, as the eye sees it ("c" and "l", or two italic
 * letters, whose boxes overlap though their ink does not).
 */
export function inkProfile(em: EmPath): { left: Float32Array; right: Float32Array } {
  const edges = outlineEdges(em, 4);
  const left = new Float32Array(PROFILE_LINES).fill(NaN);
  const right = new Float32Array(PROFILE_LINES).fill(NaN);
  const hits: number[][] = Array.from({ length: PROFILE_LINES }, () => []);
  for (let e = 0; e < edges.length; e += 4) {
    const ay = edges[e + 1];
    const by = edges[e + 3];
    if (ay === by) continue;
    const lo = Math.min(ay, by);
    const hi = Math.max(ay, by);
    for (let k = Math.max(0, Math.ceil((lo - PROFILE_Y0) / PROFILE_STEP)); k < PROFILE_LINES; k++) {
      const at = PROFILE_Y0 + k * PROFILE_STEP;
      if (at >= hi) break;
      if (at < lo) continue;
      const ax = edges[e];
      hits[k].push(ax + ((at - ay) * (edges[e + 2] - ax)) / (by - ay), by > ay ? 1 : -1);
    }
  }
  for (let k = 0; k < PROFILE_LINES; k++) {
    const h = hits[k];
    if (h.length === 0) continue;
    const order = Array.from({ length: h.length / 2 }, (_, i) => i).sort((p, q) => h[2 * p] - h[2 * q]);
    let wind = 0;
    for (const i of order) {
      const was = wind;
      wind += h[2 * i + 1];
      if (was === 0 && wind !== 0 && Number.isNaN(left[k])) left[k] = h[2 * i];
      if (was !== 0 && wind === 0) right[k] = h[2 * i];
    }
  }
  return { left, right };
}

/** What stemMeasures reads of a letter, in ems; null where the letter has nothing to measure. */
export interface StemMeasures {
  /** The width of its upright strokes across (l, i: the stem; n: both stems; o: the thickest part of each side). */
  stem: number | null;
  /** The thickness of its horizontal strokes (o: top and bottom). */
  thin: number | null;
  /** Its top and bottom (n, o): the x-height and the baseline, with the face's overshoot. */
  top: number | null;
  bottom: number | null;
}

/** Stem measures of a letter's outline, for matching a face's own bold (R90b). Ems. */
export function stemMeasures(em: EmPath, letter: string): StemMeasures {
  const polys = flatten(em, 12);
  if (polys.length === 0) return { stem: null, thin: null, top: null, bottom: null };
  // The curve's own box (control points stand off a curve, so the outline's box would read high on an arch).
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const poly of polys) {
    for (const [x, y] of poly) {
      box.x0 = Math.min(box.x0, x);
      box.x1 = Math.max(box.x1, x);
      box.y0 = Math.min(box.y0, y);
      box.y1 = Math.max(box.y1, y);
    }
  }
  const h = box.y1 - box.y0;
  const w = box.x1 - box.x0;
  const widths = (spans: [number, number][]) => spans.map(([a, b]) => b - a);
  const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length);
  switch (letter) {
    case 'l':
    case 'i': {
      // Below an i's dot and away from serifs: a third of the way up.
      const spans = scan(polys, box.y0 + (letter === 'i' ? 0.3 : 0.45) * h);
      return { stem: spans.length === 1 ? widths(spans)[0] : null, thin: null, top: null, bottom: null };
    }
    case 'n': {
      const spans = scan(polys, box.y0 + 0.35 * h);
      return { stem: spans.length === 2 ? mean(widths(spans)) : null, thin: null, top: box.y1, bottom: box.y0 };
    }
    case 'o': {
      const across = scan(polys, box.y0 + 0.5 * h);
      const down = scan(polys, box.x0 + 0.5 * w, true);
      return { stem: across.length === 2 ? Math.max(...widths(across)) : null, thin: down.length === 2 ? mean(widths(down)) : null, top: box.y1, bottom: box.y0 };
    }
    default:
      return { stem: null, thin: null, top: null, bottom: null };
  }
}

/** The letters a face's stems are measured on. */
export const STEM_LETTERS = ['l', 'i', 'n', 'o'] as const;

/**
 * Where PDFium puts a glyph it draws from its glyph cache (text smaller than GLYPH_PATH_ABOVE device px an em): its
 * origin's x is floored to a third of a device pixel and its y rounded to a whole one (measured against PDFium's own
 * pixels: on Attention's abstract at 100% to 400% this rule matches clearly better than the exact origin, rounding both,
 * or quarters). Larger text is drawn as a path, at its exact place. The bold goes exactly where the glyph went, so the
 * glyph never shows beside it.
 */
export function pdfiumGlyphOrigin(x: number, y: number, emPx: number): { x: number; y: number } {
  if (emPx > GLYPH_PATH_ABOVE) return { x, y };
  return { x: Math.floor(x * 3) / 3, y: Math.round(y) };
}

/** PDFium draws text whose em is larger than this many device px as paths (CFX_RenderDevice::DrawNormalText). */
export const GLYPH_PATH_ABOVE = 50;

/**
 * The matrix from unrotated page points (top-left origin, y down) to the device pixels of a picture PDFium drew of the
 * page (renderTile): `rect` is the part of the page drawn (unrotated points; the whole page when omitted), `width` ×
 * `height` the picture's pixels, `viewRotation` the view's turn. The same sums as the engine's (EmbedPDF's
 * buildUserToDeviceMatrix after the page's /Rotate): each axis scales by the picture's pixels over the part's points.
 */
export function pageToDevice(page: PageSize, viewRotation: Rotation, width: number, height: number, rect?: PdfRect): TurnMatrix {
  const r = totalRotation(page.rotation, viewRotation);
  const sideways = r === 90 || r === 270;
  const part = rect ?? { x: 0, y: 0, width: page.width, height: page.height };
  // The part, turned: its displayed size and where its top-left corner lands on the displayed page.
  const turn = turnMatrix(r, page.width, page.height) ?? [1, 0, 0, 1, 0, 0];
  const corners = [
    [part.x, part.y],
    [part.x + part.width, part.y],
    [part.x, part.y + part.height],
    [part.x + part.width, part.y + part.height],
  ].map(([x, y]) => [turn[0] * x + turn[2] * y + turn[4], turn[1] * x + turn[3] * y + turn[5]] as const);
  const left = Math.min(...corners.map((c) => c[0]));
  const top = Math.min(...corners.map((c) => c[1]));
  const sx = width / (sideways ? part.height : part.width);
  const sy = height / (sideways ? part.width : part.height);
  return [sx * turn[0], sy * turn[1], sx * turn[2], sy * turn[3], sx * (turn[4] - left), sy * (turn[5] - top)];
}
