// Print with marks (Phase 2, S17). The print copy (print.ts) is one picture a page. With marks, each page's marks are
// painted on its picture before it is saved, so the paper shows what the screen shows.
//
// Same geometry as the screen, not a second drawing of it:
// - Highlights, underlines, strikethroughs and area outlines are the mark layer's own paths (markPaths, the function
//   MarkLayer draws its SVG with), made for the picture's size: one path per style and colour, with the same line
//   widths and the same multiply blending, so overlapping marks never print darker.
// - Bold is the screen's synthetic bold (R90b): the glyphs BoldLayer reads (drawBoldRange), emboldened by their face's
//   own regular-to-bold gain and filled in their own colour on the picture's pixel grid (paintBold, blended with
//   darken), or the strong style where a glyph has no outline. Bold word starts never print.
//
// What is left out, on purpose (R78: notes never print): the dotted underline and the grey wash of the open comment's
// words (both are signs of a comment), the darker fill of the open comment, and the ring round a focused mark. Those are
// about notes and what is open on screen, not about the marks.
//
// Memory: nothing is kept per page. The marks are painted on the canvas print.ts already makes for the page, and the
// outlines of one bold range at a time are dropped as soon as they are painted. A page without marks costs one map lookup.
import type { DocHandle, PageSize, PdfBackend } from '@sop/viewer';
import { PT_TO_CSS } from '@sop/viewer';
import {
  type BoldRange,
  type BoldTextSource,
  displayMatrix,
  drawBoldRange,
  type MarkLayerItem,
  type MarkLayerPage,
  type MarkLayerSource,
  markPaths,
  pageToDevice,
  paintBold as paintBoldGlyphs,
  STRONG_UNDERLINE_EM,
} from '@sop/viewer/react';

/** What printing reads of the screen's marks: the same source the mark layer draws from, and the text bold reads. */
export interface PrintMarks {
  /** The marks of a page as the screen draws them (annotations/wire.ts). */
  layer: Pick<MarkLayerSource, 'page'>;
  /** Glyphs and line rects of a page, for bold (S7's page text provider). */
  text: BoldTextSource;
}

/** What one page prints. */
interface PagePrint {
  items: readonly MarkLayerItem[];
  bold: readonly BoldRange[];
}

/** The marks that print, page by page, as they were when the reader chose to print them. */
export interface MarksToPrint {
  readonly pages: ReadonlyMap<number, PagePrint>;
  readonly text: BoldTextSource;
}

const rangeKey = (r: BoldRange) => `${r.start}:${r.end}`;

/** The styles that are marks. A dotted underline and a 'passage' wash are signs of a note, and notes never print (R78). */
const MARK_STYLES: ReadonlySet<MarkLayerItem['style']> = new Set(['highlight', 'underline', 'strike', 'area']);

function printableOf(page: MarkLayerPage): PagePrint | null {
  const items = page.items.filter((i) => MARK_STYLES.has(i.style)).map((i) => (i.active === true ? { ...i, active: false } : i));
  // The same range twice (two bold marks over one passage) is painted once, as BoldLayer does.
  const bold = new Map<string, BoldRange>();
  for (const r of page.bold) if (r.end > r.start) bold.set(rangeKey(r), r);
  return items.length > 0 || bold.size > 0 ? { items, bold: [...bold.values()] } : null;
}

/**
 * The marks on the pages now, or null when no page has anything to print (then there is nothing to ask). It is a
 * snapshot: marks made or removed after the reader chose do not change this copy.
 */
export function marksToPrint(marks: PrintMarks, pageCount: number): MarksToPrint | null {
  const pages = new Map<number, PagePrint>();
  for (let index = 0; index < pageCount; index++) {
    const found = printableOf(marks.layer.page(index));
    if (found !== null) pages.set(index, found);
  }
  return pages.size > 0 ? { pages, text: marks.text } : null;
}

/** Paints the marks of one page on its picture. */
export interface MarkPainter {
  /**
   * Paints page `index`'s marks on `context`, which holds the page's picture (`width` × `height` px, the page upright).
   * Does nothing for a page with no marks. A bold range whose outlines the engine cannot give is painted in the strong
   * style instead (counted in simplerBold); the print goes on.
   */
  paint(index: number, context: OffscreenCanvasRenderingContext2D, size: { width: number; height: number }): Promise<void>;
  /**
   * How many bold ranges so far were printed in the simpler "strong" style (a heavier tint with a dark underline)
   * because the engine could not give their glyph outlines.
   */
  simplerBold(): number;
  /** Removes what the painter put in the page to read colours. Safe to call twice. */
  dispose(): void;
}

export interface MarkPainterDeps {
  backend: Pick<PdfBackend, 'getGlyphShapes'>;
  doc: DocHandle;
  /** OpenResult.pages: each page's unrotated size and /Rotate. */
  pages: readonly PageSize[];
  marks: MarksToPrint;
  signal: AbortSignal;
}

/**
 * Reads the colours and widths the screen styles use from the page's own tokens, as paper has them: a probe marked
 * data-theme="light" gives the light values, so the viewer's dark chrome does not turn a printed mark dark. (The five
 * mark colours are the same in both themes; the bold strong style uses chrome tokens, which are not.)
 */
function tokenReader(): { read(value: string): string; dispose(): void } {
  const probe = document.createElement('span');
  probe.setAttribute('data-theme', 'light');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;inset:0 auto auto 0';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  return {
    // "var(--sop-mark-1)" becomes the token's value ("#fde293"); anything else is already a value.
    read(value) {
      const token = /^var\((--[\w-]+)\)$/u.exec(value.trim());
      return token === null ? value.trim() : style.getPropertyValue(token[1]).trim();
    },
    dispose: () => probe.remove(),
  };
}

/** The painter for one print copy. */
export function createMarkPainter(d: MarkPainterDeps): MarkPainter {
  let tokens: ReturnType<typeof tokenReader> | null = null;
  let simpler = 0;
  const read = (value: string | number | undefined): string => (value === undefined ? '' : (tokens ??= tokenReader()).read(String(value)));

  /** Highlights, underlines, strikethroughs and areas: the mark layer's paths, on the picture. */
  function paintPaths(context: OffscreenCanvasRenderingContext2D, page: PageSize, items: readonly MarkLayerItem[], k: number): void {
    // Canvas px per CSS px of a page at 100%: the unit the stroke of an area outline is written in.
    const unit = k / PT_TO_CSS;
    for (const path of markPaths(items, { page, k, rotation: page.rotation, dpr: 1 })) {
      const fill = read(path.style.fill);
      const stroke = read(path.style.stroke);
      context.save();
      context.globalCompositeOperation = read(path.style.mixBlendMode) === 'multiply' ? 'multiply' : 'source-over';
      const shape = new Path2D(path.d);
      if (fill !== '' && fill !== 'none') {
        context.fillStyle = fill;
        context.fill(shape);
      }
      if (stroke !== '' && stroke !== 'none') {
        context.strokeStyle = stroke;
        context.lineWidth = (parseFloat(read(path.style.strokeWidth)) || 1) * unit;
        context.stroke(shape);
      }
      context.restore();
    }
  }

  /** The strong style: a heavier tint with a dark underline on each line rect (points, in the page's own space). */
  function paintStrong(context: OffscreenCanvasRenderingContext2D, rects: readonly { x: number; y: number; width: number; height: number }[]): void {
    for (const rect of rects) {
      context.globalCompositeOperation = 'multiply';
      context.fillStyle = read('var(--gm3-sys-color-surface-container-highest)');
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = read('var(--gm3-sys-color-on-surface)');
      context.fillRect(rect.x, rect.y + rect.height * (1 - STRONG_UNDERLINE_EM), rect.width, rect.height * STRONG_UNDERLINE_EM);
    }
  }

  /**
   * The outlines of one range, or null when the engine cannot give them. A failure here never stops the print: the range
   * is then painted in the strong style (below). If the line rects fail too, the engine itself is gone, and so would the
   * next page's picture be: that error goes up.
   */
  async function outlinesOf(index: number, range: BoldRange): Promise<Awaited<ReturnType<typeof drawBoldRange>> | null> {
    try {
      return await drawBoldRange({ backend: d.backend, doc: d.doc, pageIndex: index, text: d.marks.text }, range);
    } catch {
      return null;
    }
  }

  /**
   * Bold: each range's glyphs, one range at a time (dropped once painted), as the screen draws them (R90b, R90c):
   * synthetic bold on the picture's own pixel grid, blended with darken over the picture (lighten for light text), at
   * the print's resolution.
   */
  async function paintBold(context: OffscreenCanvasRenderingContext2D, index: number, page: PageSize, ranges: readonly BoldRange[], k: number, size: { width: number; height: number }): Promise<void> {
    const { matrix } = displayMatrix(page, 0);
    const device = pageToDevice(page, 0, size.width, size.height);
    for (const range of ranges) {
      if (d.signal.aborted) return;
      const drawn = await outlinesOf(index, range);
      const strong = drawn === null ? await d.marks.text.rects(index, range.start, range.end - range.start) : drawn.strong;
      if (drawn === null) simpler++;
      context.save();
      context.setTransform(k, 0, 0, k, 0, 0);
      if (matrix !== null) context.transform(...matrix);
      paintStrong(context, strong);
      context.restore();
      if (drawn !== null && drawn.glyphs.length > 0) {
        // Dark text's bold with darken; light text's (white on a band) with lighten, which darken cannot widen (R90c).
        for (const tone of ['dark', 'light'] as const) {
          context.save();
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.globalCompositeOperation = tone === 'dark' ? 'darken' : 'lighten';
          paintBoldGlyphs(context, drawn.glyphs, device, { tone });
          context.restore();
        }
      }
    }
  }

  return {
    async paint(index, context, size) {
      const found = d.marks.pages.get(index);
      const page = d.pages[index];
      if (found === undefined || page === undefined) return;
      // Pixels a point: the picture's width over the page as displayed (width and height swap for /Rotate 90 and 270).
      const k = size.width / displayMatrix(page, 0).width;
      paintPaths(context, page, found.items, k);
      await paintBold(context, index, page, found.bold, k, size);
    },
    simplerBold: () => simpler,
    dispose() {
      tokens?.dispose();
      tokens = null;
    },
  };
}
