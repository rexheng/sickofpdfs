// Draws synthetic bold (rulings R90b and R90c) on a canvas whose pixels are exactly those of a picture PDFium drew of
// the page: each glyph's outline, emboldened by its face's gain (bold-faces.ts) and filled in its own colour, at the
// very place PDFium put the glyph (pdfiumGlyphOrigin), so each edge is anti-aliased once, on the text's own grid. One
// path per colour, so glyphs that touch (kerning, ligatures) are filled once. Bold word starts, bold marks and print
// share it.
//
// R90c, so the bold never closes a gap at small sizes: each side of a glyph grows only as far as leaves its neighbour
// at least KEEP_GAP_PX device px and KEEP_GAP_SHARE of the gap there was (the ink gap read line by line: inkProfile),
// and the gain shrinks so every counter and hole keeps MIN_COUNTER_PX device px. Both depend on the zoom, so they are
// worked out as a picture is painted, from strengths rounded down to SIDE_QUANTUM so the paths are still shared.
import type { GlyphPlacement, GlyphShapes, PdfColor } from '../backend/types';
import type { TurnMatrix } from '../view/page-transform';
import { capsOf, counterWidths, emboldenOutline, type EmPath, holeShare, holeSizes, inkProfile, pdfiumGlyphOrigin, PROFILE_LINES, PROFILE_STEP, PROFILE_Y0 } from './synthetic-bold';

/** A bold range on a page: PDFium char indices, `end` exclusive (a bold mark's, or a word start's). */
export interface BoldRange {
  start: number;
  end: number;
}

/** A distinct outline, with what is worked out from it once: its counters, holes, ink profile and emboldened paths. */
export interface BoldShape {
  em: EmPath;
  /** Its narrowest counters across and up and down (counterWidths), ems. */
  counters?: { x: number; y: number };
  caps?: { x: number; y: number };
  holes?: { w: number; h: number }[];
  profile?: { left: Float32Array; right: Float32Array };
  /** Emboldened Path2Ds in ems (y up), by strengths. */
  paths: Map<string, Path2D>;
}

/** One glyph to draw bold (a GlyphPlacement with its shape). Points, unrotated page space. */
export interface BoldGlyph extends Omit<GlyphPlacement, 'shape'> {
  shape: BoldShape;
  /**
   * The ink gap to its neighbour on the left and on the right on its line, in its own ems (neighbourGap); missing where
   * no glyph is near on that side.
   */
  gapL?: number;
  gapR?: number;
  /** Where its ink faces that neighbour, in its ems along its baseline (at the line where the gap is narrowest). */
  edgeL?: number;
  edgeR?: number;
  /** The neighbour on the left is drawn in the same list (so it keeps that gap's edges, paintBold). */
  drawnL?: boolean;
}

/**
 * The bottoms drop this many ems, so a glyph's own bottom edge never shows below the bold where PDFium draws text as
 * paths (0.13 px at 50 px an em; R90b's gate keeps the baseline within 0.3 px of the face's real bold).
 */
const BOTTOM_EM = 0.0025;
/** Distinct outlines kept, with their analysis and emboldened paths, across pages (a book uses a few hundred). */
const SHAPES_KEPT = 4000;
/** Strengths up and down are rounded to this many ems for the path cache (0.005 device px at 400% on a DPR-2 screen). */
const QUANTUM = 1 / 4000;
/** Each side's growth across is rounded down to this many ems, so the gap rules hold and similar sides share a path. */
const SIDE_QUANTUM = 1 / 2000;
/**
 * R90c: what a glyph's growth leaves of the gap to its neighbour, at least: this many device px … R90c asks for at
 * least 0.75; on a 1× screen 0.75 px still smooths into one grey column and "cl" read as one letter at Strong
 * (PLOS ONE's serif body, measured), so it is 1.
 */
export const KEEP_GAP_PX = 1;
/** … and this share of the gap there was. */
export const KEEP_GAP_SHARE = 0.45;
/** R90c: every counter and hole keeps at least this many device px. */
export const MIN_COUNTER_PX = 1;

/** Every outline met, by its content: an engine call sends each outline it uses, so the same "e" comes many times. */
const shapes = new Map<string, BoldShape>();

/** One BoldShape per distinct outline (FNV-1a over its numbers), so its analysis and paths are worked out once. */
export function shapeOf(em: Float32Array): BoldShape {
  const words = new Uint32Array(em.buffer, em.byteOffset, em.length);
  let h = 0x811c9dc5;
  for (const w of words) h = Math.imul(h ^ w, 0x01000193);
  const key = `${em.length}:${h >>> 0}`;
  const known = shapes.get(key);
  if (known) return known;
  const made: BoldShape = { em, paths: new Map() };
  shapes.set(key, made);
  if (shapes.size > SHAPES_KEPT) shapes.delete(shapes.keys().next().value!);
  return made;
}

/** A glyph's ink profile (inkProfile), worked out once per shape. */
const profileOf = (shape: BoldShape) => (shape.profile ??= inkProfile(shape.em));

/**
 * The ink gap between glyph `a` and its neighbour `b`, in `a`'s ems along its baseline: `side` 1 when `b` is on the
 * right, -1 on the left, and the narrowest horizontal gap where their ink faces each other, line by line (negative
 * where it overlaps). Null when `b` is not beside `a` on its line (another line, far off, or no ink facing).
 */
export function neighbourGap(a: Pick<GlyphPlacement, 'm' | 'x' | 'y'>, aShape: BoldShape, b: Pick<GlyphPlacement, 'm' | 'x' | 'y'>, bShape: BoldShape): { side: 1 | -1; gap: number; edge: number } | null {
  const [ma, mb, mc, md] = a.m;
  const det = ma * md - mb * mc;
  if (det === 0) return null;
  // Page points → a's ems.
  const i0 = md / det;
  const i1 = -mb / det;
  const i2 = -mc / det;
  const i3 = ma / det;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ox = i0 * dx + i2 * dy;
  const oy = i1 * dx + i3 * dy;
  if (Math.abs(oy) > 0.35 || Math.abs(ox) > 4 || Math.abs(ox) < 0.02) return null;
  // b's ems → a's ems.
  const [ba, bb, bc, bd] = b.m;
  const n00 = i0 * ba + i2 * bb;
  const n10 = i1 * ba + i3 * bb;
  const n01 = i0 * bc + i2 * bd;
  const n11 = i1 * bc + i3 * bd;
  const pa = profileOf(aShape);
  const pb = profileOf(bShape);
  const side = ox > 0 ? 1 : -1;
  let gap = Infinity;
  let edge = 0;
  for (let k = 0; k < PROFILE_LINES; k++) {
    const x = side > 0 ? pb.left[k] : pb.right[k];
    if (Number.isNaN(x)) continue;
    const y = PROFILE_Y0 + k * PROFILE_STEP;
    const u = ox + n00 * x + n01 * y;
    const v = oy + n10 * x + n11 * y;
    const j = Math.round((v - PROFILE_Y0) / PROFILE_STEP);
    if (j < 0 || j >= PROFILE_LINES) continue;
    const mine = side > 0 ? pa.right[j] : pa.left[j];
    if (Number.isNaN(mine)) continue;
    const here = side > 0 ? u - mine : mine - u;
    if (here < gap) {
      gap = here;
      edge = mine;
    }
  }
  return Number.isFinite(gap) ? { side, gap, edge } : null;
}

/**
 * The glyphs of a getGlyphShapes answer for which `keep` holds, with their shapes and the gaps to their neighbours
 * (the glyphs before and after them in the answer, kept or not: so ask for a char or two beyond what is drawn).
 */
export function boldGlyphs(set: GlyphShapes, keep: (g: GlyphPlacement, index: number, all: readonly GlyphPlacement[]) => boolean = () => true): BoldGlyph[] {
  const shapes = set.shapes.map(shapeOf);
  const all = set.glyphs;
  // Which glyphs are drawn (keep may hold state, so it is asked once a glyph, in order).
  const kept = all.map((g, i) => shapes[g.shape] !== undefined && keep(g, i, all));
  const out: BoldGlyph[] = [];
  for (let i = 0; i < all.length; i++) {
    const g = all[i];
    const shape = shapes[g.shape];
    if (!shape || !kept[i]) continue;
    const bold: BoldGlyph = { ...g, shape };
    for (const j of [i - 1, i + 1]) {
      const n = all[j];
      const nShape = n === undefined ? undefined : shapes[n.shape];
      if (n === undefined || nShape === undefined) continue;
      const near = neighbourGap(g, shape, n, nShape);
      if (near === null) continue;
      if (near.side < 0 && near.gap < (bold.gapL ?? Infinity)) {
        bold.gapL = near.gap;
        bold.edgeL = near.edge;
        bold.drawnL = kept[j];
      } else if (near.side > 0 && near.gap < (bold.gapR ?? Infinity)) {
        bold.gapR = near.gap;
        bold.edgeR = near.edge;
      }
    }
    out.push(bold);
  }
  return out;
}

/** The outline as a Path2D in ems. */
function pathOf(em: ArrayLike<number>): Path2D {
  const path = new Path2D();
  const n = em.length / 4;
  for (let s = 0; s < n; s++) {
    const type = em[4 * s];
    const x = em[4 * s + 1];
    const y = em[4 * s + 2];
    if (type === 2) path.moveTo(x, y);
    else if (type === 1 && s + 2 < n) {
      path.bezierCurveTo(x, y, em[4 * s + 5], em[4 * s + 6], em[4 * s + 9], em[4 * s + 10]);
      s += 2;
      if (em[4 * s + 3]) path.closePath();
      continue;
    } else path.lineTo(x, y);
    if (em[4 * s + 3]) path.closePath();
  }
  return path;
}

/**
 * The glyph's emboldened outline as a Path2D in ems (made once per outline and strengths). `gain`, `pxX` and `pxY`: see
 * strengthsFor.
 */
export function pathFor(g: Pick<BoldGlyph, 'bold' | 'shape' | 'gapL' | 'gapR'>, gain = 1, pxX = Infinity, pxY = Infinity): Path2D {
  return pathAt(g.shape, strengthsFor(g, gain, pxX, pxY));
}

/** A shape's emboldened outline at strengths `s`, made once. */
function pathAt(shape: BoldShape, s: Strengths): Path2D {
  const key = `${s.sideL}|${s.sideR}|${s.y}|${s.shift}`;
  let path = shape.paths.get(key);
  if (!path) shape.paths.set(key, (path = pathOf(emboldenOutline(shape.em, s.sideL + s.sideR, s.y, s.shift, (s.sideR - s.sideL) / 2))));
  return path;
}

/**
 * How far edge darkening moves an edge's half-ink line outward, in device px (over a one-pixel edge): 0.13 px at
 * boost 0.5, 0.22 px at 1.1. Where that and the side's growth would take more of a gap than R90c allows, the gap is
 * not darkened (paintBold).
 */
export const boostShiftPx = (boost: number): number => (boost <= 0 ? 0 : 0.5 - (1 - 0.5 ** (1 / (1 + boost))));

/** A strip across a glyph's line, ems x0 to x1 (y up), where edge darkening stays off. */
function stripPath(x0: number, x1: number): Path2D {
  const strip = new Path2D();
  strip.rect(x0, -0.35, x1 - x0, 1.4);
  return strip;
}

/** Main-thread time prepareGlyphs takes at once before it lets other work run. */
const PREPARE_SLICE_MS = 16;

/** Device px an em across and up and down for glyph matrix `m` at `pxPerPt` device px a point. */
const pxPerEm = (m: GlyphPlacement['m'], pxPerPt: number) => [pxPerPt * Math.hypot(m[0], m[1]), pxPerPt * Math.hypot(m[2], m[3])] as const;

/**
 * Works out the glyphs' emboldened outlines now, as their glyphs arrive, so drawing a page is only placing them: at
 * `pxPerPt` device px a point (the page's pictures now; without it, as at a large zoom). A new outline costs about
 * 25 µs once the code is warm (up to 0.4 ms the first time a tab draws bold); the work yields every PREPARE_SLICE_MS,
 * so it never holds the main thread.
 */
export async function prepareGlyphs(glyphs: readonly BoldGlyph[], gain = 1, pxPerPt = Infinity): Promise<void> {
  let sliceStart = performance.now();
  for (const g of glyphs) {
    const [pxX, pxY] = pxPerEm(g.m, pxPerPt);
    pathFor(g, gain, pxX, pxY);
    if (performance.now() - sliceStart > PREPARE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
}

const css = ([r, g, b, a]: PdfColor) => (a >= 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.round((a / 255) * 1000) / 1000})`);
const q = (v: number) => Math.round(v / QUANTUM) * QUANTUM;
const floorSide = (v: number) => Math.floor(v / SIDE_QUANTUM) * SIDE_QUANTUM;

/**
 * Light text (white on a slide's band): its bold is painted with `lighten`, as `darken` cannot make white text wider
 * (R90c). Light is a luminance over this.
 */
const LIGHT_LUMINANCE = 0.6;
/** Whether a glyph's fill is light: its bold goes to the `lighten` underlay. */
export const isLightFill = (fill: PdfColor | null): boolean => fill !== null && (0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2]) / 255 > LIGHT_LUMINANCE;

/** How far a glyph grows: each side across (`sideL`, `sideR`), up and down together (`y`), and how far it then moves up. Ems. */
export interface Strengths {
  sideL: number;
  sideR: number;
  y: number;
  shift: number;
}

/**
 * The strengths for one glyph, in ems: its face's gain across, so its stems match the face's own bold; the bottoms stay
 * on the baseline, but for BOTTOM_EM, and the tops rise as the face's bold does (FreeType keeps the baseline the same
 * way); capped so every counter keeps COUNTER_KEEP of its width and height and HOLE_AREA_KEEP of its area.
 *
 * At `pxX` and `pxY` device px an em (across and up and down; none: a large zoom), R90c's rules: the gain shrinks so
 * every counter and hole keeps MIN_COUNTER_PX, and each side grows only as far as leaves at least KEEP_GAP_PX and
 * KEEP_GAP_SHARE of the gap to its neighbour (gapL, gapR). The neighbour may grow too, so a side takes half of what is
 * left to give. At 150% and up, and on 2× screens, these rarely bind and the bold is R90b's.
 *
 * `gain` scales the face's gain (bold word starts' "How bold"); the caps hold at every gain.
 */
export function strengthsFor(g: Pick<BoldGlyph, 'bold' | 'shape' | 'gapL' | 'gapR'>, gain = 1, pxX = Infinity, pxY = Infinity): Strengths {
  const counters = (g.shape.counters ??= counterWidths(g.shape.em));
  const caps = (g.shape.caps ??= capsOf(counters));
  const holes = (g.shape.holes ??= holeSizes(g.shape.em));
  const top = g.bold.top * gain;
  const bottom = Math.max(g.bold.bottom * gain, BOTTOM_EM);
  const side = Math.max(0, Math.min((g.bold.x * gain) / 2, caps.x));
  // Up and down: each side moves (top + bottom) / 2, then the glyph moves up by (top - bottom) / 2.
  const ySide = Math.max(0, Math.min((top + bottom) / 2, caps.y));
  // Every hole keeps HOLE_AREA_KEEP of its area …
  let t = holeShare(holes, 2 * side, 2 * ySide);
  // … and every counter and hole MIN_COUNTER_PX device px (rounded down to sixteenths, so the paths are shared).
  const minX = MIN_COUNTER_PX / pxX;
  const minY = MIN_COUNTER_PX / pxY;
  const fit = (room: number, grow: number) => (grow <= 0 ? 1 : Math.max(0, room / grow));
  let px = Math.min(fit(counters.x - minX, 2 * side), fit(counters.y - minY, 2 * ySide));
  for (const h of holes) px = Math.min(px, fit(h.w - minX, 2 * side), fit(h.h - minY, 2 * ySide));
  if (px < 1) t = Math.min(t, Math.floor(px * 16) / 16);
  const across = side * t;
  // Each side, as far as its neighbour allows.
  const room = (gap: number | undefined) => (gap === undefined ? Infinity : Math.max(0, gap - Math.max(KEEP_GAP_PX / pxX, KEEP_GAP_SHARE * gap)) / 2);
  return {
    sideL: floorSide(Math.min(across, room(g.gapL))),
    sideR: floorSide(Math.min(across, room(g.gapR))),
    y: q(2 * ySide * t),
    shift: q(((top - bottom) / 2) * t),
  };
}

/** The device-px box worth drawing in (glyphs wholly outside it are skipped), or none for the whole canvas. */
export interface PaintClip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PaintOptions {
  clip?: PaintClip;
  /** Scales each face's gain (strengthsFor). Default 1. */
  gain?: number;
  /** Only the glyphs of dark fills (for a `darken` layer), or of light ones (`lighten`: isLightFill). Default: all. */
  tone?: 'dark' | 'light';
  /**
   * Edge darkening (0 to 3; default 0): the shapes are filled 1 + `boost` times (the part over a whole number at that
   * alpha), so a pixel the outline covers by c is covered by 1 − (1 − c)^(1 + boost): edges grow darker, the outline
   * stays where it is. It is how small text gets heavier without its letters moving closer (R90c), as FreeType darkens
   * stems at small sizes.
   */
  boost?: number;
}

/**
 * Paints `glyphs` emboldened on `context`, whose pixels are a picture of the page made with `device` (unrotated page
 * points → its device px: pageToDevice). Filled, never stroked; text that is only stroked (outlined) is left alone.
 * Returns how many glyphs were drawn.
 */
export function paintBold(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, glyphs: readonly BoldGlyph[], device: TurnMatrix, o: PaintOptions = {}): number {
  const [A, B, C, D, E, F] = device;
  const { clip, gain = 1, tone, boost = 0 } = o;
  const byColour = new Map<string, Path2D>();
  // The narrow gaps edge darkening must leave alone, as one even-odd clip (each gap once: from the glyph on its left).
  let strips: Path2D | null = null;
  // One matrix, set for each glyph (addPath copies it): no allocation a glyph.
  const place = new DOMMatrix();
  let drawn = 0;
  for (const g of glyphs) {
    if (g.fill === null) continue;
    if (tone !== undefined && isLightFill(g.fill) !== (tone === 'light')) continue;
    const [ma, mb, mc, md] = g.m;
    // Ems → device px: the device's linear part after the glyph's own matrix.
    const a = A * ma + C * mb;
    const b = B * ma + D * mb;
    const c = A * mc + C * md;
    const d = B * mc + D * md;
    const pxX = Math.hypot(a, b);
    const pxY = Math.hypot(c, d);
    const at = pdfiumGlyphOrigin(A * g.x + C * g.y + E, B * g.x + D * g.y + F, Math.abs(a) + Math.abs(b));
    if (clip) {
      const reach = 1.5 * Math.max(pxX, pxY);
      if (at.x + reach < clip.x0 || at.x - reach > clip.x1 || at.y + reach < clip.y0 || at.y - reach > clip.y1) continue;
    }
    const st = strengthsFor(g, gain, pxX, pxY);
    const path = pathAt(g.shape, st);
    const colour = css(g.fill);
    let combined = byColour.get(colour);
    if (!combined) byColour.set(colour, (combined = new Path2D()));
    place.a = a;
    place.b = b;
    place.c = c;
    place.d = d;
    place.e = at.x;
    place.f = at.y;
    combined.addPath(path, place);
    drawn++;
    if (boost > 0) {
      const shift = boostShiftPx(boost) / pxX;
      const half = 0.5 / pxX;
      const tight = (gap: number, side: number) => side + shift > Math.max(0, gap - Math.max(KEEP_GAP_PX / pxX, KEEP_GAP_SHARE * gap)) / 2;
      if (g.gapR !== undefined && g.edgeR !== undefined && tight(g.gapR, st.sideR)) (strips ??= new Path2D()).addPath(stripPath(g.edgeR - half, g.edgeR + g.gapR + half), place);
      if (g.gapL !== undefined && g.edgeL !== undefined && g.drawnL !== true && tight(g.gapL, st.sideL)) (strips ??= new Path2D()).addPath(stripPath(g.edgeL - g.gapL - half, g.edgeL + half), place);
    }
  }
  const whole = Math.floor(Math.max(0, Math.min(3, boost)));
  const part = Math.max(0, Math.min(3, boost)) - whole;
  for (const [colour, path] of byColour) {
    context.fillStyle = colour;
    context.fill(path);
  }
  if (whole + part > 0) {
    context.save();
    if (strips !== null) {
      const allowed = new Path2D();
      allowed.rect(-1e6, -1e6, 2e6, 2e6);
      allowed.addPath(strips);
      context.clip(allowed, 'evenodd');
    }
    for (const [colour, path] of byColour) {
      context.fillStyle = colour;
      for (let k = 0; k < whole; k++) context.fill(path);
      if (part > 0) {
        context.globalAlpha = part;
        context.fill(path);
        context.globalAlpha = 1;
      }
    }
    context.restore();
  }
  return drawn;
}
