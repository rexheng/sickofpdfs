// Draws synthetic bold (ruling R90b) on a canvas whose pixels are exactly those of a picture PDFium drew of the page:
// each glyph's outline, emboldened by its face's gain (bold-faces.ts) and filled in its own colour, at the very place
// PDFium put the glyph (pdfiumGlyphOrigin), so each edge is anti-aliased once, on the text's own grid. One path per
// colour, so glyphs that touch (kerning, ligatures) are filled once. Bold word starts, bold marks and print share it.
import type { GlyphPlacement, GlyphShapes, PdfColor } from '../backend/types';
import type { TurnMatrix } from '../view/page-transform';
import { counterLimits, emboldenOutline, type EmPath, holeShare, holeSizes, pdfiumGlyphOrigin } from './synthetic-bold';

/** A bold range on a page: PDFium char indices, `end` exclusive (a bold mark's, or a word start's). */
export interface BoldRange {
  start: number;
  end: number;
}

/** A distinct outline, with what is worked out from it once: its counter limits and its emboldened paths. */
export interface BoldShape {
  em: EmPath;
  caps?: { x: number; y: number };
  holes?: { w: number; h: number }[];
  /** Emboldened Path2Ds in ems (y up), by strengths. */
  paths: Map<string, Path2D>;
}

/** One glyph to draw bold (a GlyphPlacement with its shape). Points, unrotated page space. */
export interface BoldGlyph extends Omit<GlyphPlacement, 'shape'> {
  shape: BoldShape;
}

/**
 * The bottoms drop this many ems, so a glyph's own bottom edge never shows below the bold where PDFium draws text as
 * paths (0.13 px at 50 px an em; R90b's gate keeps the baseline within 0.3 px of the face's real bold).
 */
const BOTTOM_EM = 0.0025;
/** Distinct outlines kept, with their analysis and emboldened paths, across pages (a book uses a few hundred). */
const SHAPES_KEPT = 4000;
/** Strengths are rounded to this many ems for the path cache (0.005 device px at 400% on a DPR-2 screen). */
const QUANTUM = 1 / 4000;

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

/** The glyphs of a getGlyphShapes answer for which `keep(charIndex)` holds, with their shapes. */
export function boldGlyphs(set: GlyphShapes, keep: (charIndex: number) => boolean = () => true): BoldGlyph[] {
  const shapes = set.shapes.map(shapeOf);
  const out: BoldGlyph[] = [];
  for (const g of set.glyphs) {
    const shape = shapes[g.shape];
    if (shape && keep(g.charIndex)) out.push({ ...g, shape });
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

/** The glyph's emboldened outline as a Path2D in ems (made once per outline and face gain). */
export function pathFor(g: Pick<BoldGlyph, 'bold' | 'shape'>): Path2D {
  const s = strengthsFor(g);
  const key = `${s.x}|${s.y}|${s.shift}`;
  let path = g.shape.paths.get(key);
  if (!path) g.shape.paths.set(key, (path = pathOf(emboldenOutline(g.shape.em, s.x, s.y, s.shift))));
  return path;
}

/** Main-thread time prepareGlyphs takes at once before it lets other work run. */
const PREPARE_SLICE_MS = 16;

/**
 * Works out the glyphs' emboldened outlines now, as their glyphs arrive, so drawing a page is only placing them. A new
 * outline costs about 25 µs once the code is warm (up to 0.4 ms the first time a tab draws bold); the work yields
 * every PREPARE_SLICE_MS, so it never holds the main thread.
 */
export async function prepareGlyphs(glyphs: readonly BoldGlyph[]): Promise<void> {
  let sliceStart = performance.now();
  for (const g of glyphs) {
    pathFor(g);
    if (performance.now() - sliceStart > PREPARE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
}

const css = ([r, g, b, a]: PdfColor) => (a >= 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.round((a / 255) * 1000) / 1000})`);
const q = (v: number) => Math.round(v / QUANTUM) * QUANTUM;

/**
 * The strengths for one glyph, in ems, the same at every zoom: its face's gain across, so its stems match the face's
 * own bold; the bottoms stay on the baseline, but for BOTTOM_EM, and the tops rise as the face's bold
 * does (FreeType keeps the baseline the same way); capped so every counter keeps COUNTER_KEEP of its width and height
 * and HOLE_AREA_KEEP of its area. Ems, per emboldenOutline.
 *
 * R90b asks that the bold cover the glyph by at least 0.5 device px each side. Across, a face's own gain covers 0.37 px
 * a side at 100% on a DPR-1 screen and 0.5 or more from 150% up; rounding it up makes small stems heavier than the
 * face's real bold (measured: up to 29% at 100%), so the stems keep the face's own gain. Up and down, 0.5 px would move
 * the x-height and the baseline past the 0.3 px the gate allows.
 */
export function strengthsFor(g: Pick<BoldGlyph, 'bold' | 'shape'>): { x: number; y: number; shift: number } {
  const caps = (g.shape.caps ??= counterLimits(g.shape.em));
  const { x, top } = g.bold;
  const side = Math.min(x / 2, caps.x);
  const bottom = Math.max(g.bold.bottom, BOTTOM_EM);
  // Up and down: each side moves (top + bottom) / 2, then the glyph moves up by (top - bottom) / 2.
  const ySide = Math.min((top + bottom) / 2, caps.y);
  // And every hole keeps HOLE_AREA_KEEP of its area.
  const t = holeShare((g.shape.holes ??= holeSizes(g.shape.em)), 2 * Math.max(0, side), 2 * ySide);
  return { x: q(2 * Math.max(0, side) * t), y: q(2 * ySide * t), shift: q(((top - bottom) / 2) * t) };
}

/** The device-px box worth drawing in (glyphs wholly outside it are skipped), or none for the whole canvas. */
export interface PaintClip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Paints `glyphs` emboldened on `context`, whose pixels are a picture of the page made with `device` (unrotated page
 * points → its device px: pageToDevice). Filled, never stroked; text that is only stroked (outlined) is left alone.
 * Returns how many glyphs were drawn.
 */
export function paintBold(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, glyphs: readonly BoldGlyph[], device: TurnMatrix, clip?: PaintClip): number {
  const [A, B, C, D, E, F] = device;
  const byColour = new Map<string, Path2D>();
  // One matrix, set for each glyph (addPath copies it): no allocation a glyph.
  const place = new DOMMatrix();
  let drawn = 0;
  for (const g of glyphs) {
    if (g.fill === null) continue;
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
    const path = pathFor(g);
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
  }
  for (const [colour, path] of byColour) {
    context.fillStyle = colour;
    context.fill(path);
  }
  return drawn;
}
