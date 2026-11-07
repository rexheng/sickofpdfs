// Synthetic bold as vector shapes (R90b), for "Download with notes": the same bold the screen and print draw (each glyph's
// outline pushed outward by its face's own regular-to-bold gain, filled in its own colour), but kept as paths, so a bold
// mark written into a PDF looks the same in any reader and at any zoom. Pure geometry.
//
// At a reader's zoom there is no pixel grid to keep to, so R90c's pixel rules (a gap keeps at least 1 device px, a
// counter at least 1 px) drop out: strengthsFor is asked at an infinite resolution and only the share rules hold (each
// side keeps KEEP_GAP_SHARE of the gap to its neighbour, counters and holes keep their share).
import type { GlyphShapes, PdfColor } from '../backend/types';
import { boldGlyphs, type BoldRange, strengthsFor } from './bold-painter';
import { emboldenOutline } from './synthetic-bold';

/** One fill colour's emboldened glyphs: PDFium path segments ([type, x, y, close]) in unrotated page points, y down. */
export interface BoldVectorFill {
  fill: PdfColor;
  path: number[];
}

/**
 * The emboldened glyphs of chars [range.start, range.end) of a getGlyphShapes answer, one path per fill colour. Ask
 * getGlyphShapes for a char or two beyond the range, so the end glyphs know their neighbours (drawBoldRange does the
 * same). Text that is stroked but not filled is left alone, as paintBold leaves it.
 */
export function boldVectorFills(set: GlyphShapes, range: BoldRange): BoldVectorFill[] {
  const byColour = new Map<string, BoldVectorFill>();
  for (const g of boldGlyphs(set, (p) => p.charIndex >= range.start && p.charIndex < range.end)) {
    if (g.fill === null) continue;
    const s = strengthsFor(g);
    const em = emboldenOutline(g.shape.em, s.sideL + s.sideR, s.y, s.shift, (s.sideR - s.sideL) / 2);
    const key = g.fill.join(',');
    let out = byColour.get(key);
    if (!out) byColour.set(key, (out = { fill: g.fill, path: [] }));
    const [a, b, c, d] = g.m;
    for (let k = 0; k + 3 < em.length; k += 4) {
      const ex = em[k + 1];
      const ey = em[k + 2];
      out.path.push(em[k], a * ex + c * ey + g.x, b * ex + d * ey + g.y, em[k + 3]);
    }
  }
  return [...byColour.values()];
}
