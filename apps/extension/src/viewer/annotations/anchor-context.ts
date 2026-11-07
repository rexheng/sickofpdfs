// Where notes meet the open PDF's bytes (Phase 2, S13): the AnchorContext re-anchoring reads (contracts §2), the text
// anchor a selection becomes, and the 0–1 rects a mark is drawn with.
//
// One rule holds it together: a mark's rects are made exactly as the selection's are painted (TextLayer): PDFium's line
// rects for the chars (getTextRangeRects), one even band a line (markLineRects), then 0–1 of the page's crop box
// (pdfRectToNorm with the page's size). Both read the same PageTextProvider, so the rect requests are cached and shared,
// and a highlight lands exactly where its selection was.
//
// Positions are PDFium char indices. Anchors are built on `rawText` (one UTF-16 unit per char, chars that are not text
// kept), never on getPageText, whose offsets drift after the first joined hyphen (S3 report, contract defect 1).
import { buildTextAnchor, dHash64, type Anchor, type AnchorContext, type DetectedFigure, type NormRect } from '@sop/core';
import {
  type CharRange,
  createFigureService,
  type DocHandle,
  type FigureService,
  markLineRects,
  type PageSize,
  type PageTextProvider,
  type PageTextProviderImpl,
  type PdfBackend,
  pdfRectToNorm,
} from '@sop/viewer';

type TextAnchor = Extract<Anchor, { kind: 'text' }>;

/** The open document's text and page sizes: all that rects and anchors need. */
export interface DocumentText {
  pageText: PageTextProviderImpl;
  /** OpenResult.pages: each page's unrotated crop box in points. */
  pages: readonly PageSize[];
}

/** The 0–1 rects of chars [start, start + count) of a page: the rects the selection of those chars is painted with. */
export async function markNormRects(t: DocumentText, pageIndex: number, start: number, count: number): Promise<NormRect[]> {
  const size = t.pages[pageIndex];
  if (size === undefined || count <= 0) return [];
  const rects = await markLineRects(t.pageText, pageIndex, start, count);
  return rects.map((r) => pdfRectToNorm(r, size));
}

/**
 * Turns char ranges (one per page, in reading order, as a selection gives them) into a text anchor: the quote with
 * its 32 chars of context, the start and end positions, and the rects of every page it covers. Rejects when the ranges
 * hold no char.
 */
export function createTextAnchorMaker(t: DocumentText): (ranges: CharRange[]) => Promise<TextAnchor> {
  return async (input) => {
    const ranges = input.filter((r) => r.end > r.start).sort((a, b) => a.pageIndex - b.pageIndex || a.start - b.start);
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    if (first === undefined || last === undefined) throw new Error('bad-input: no text to anchor');
    const pagesIn = [...new Set(ranges.map((r) => r.pageIndex))];
    const [texts, rects] = await Promise.all([
      Promise.all(pagesIn.map(async (p) => [p, await t.pageText.rawText(p)] as const)),
      Promise.all(ranges.map(async (r) => ({ page: r.pageIndex, rects: await markNormRects(t, r.pageIndex, r.start, r.end - r.start) }))),
    ]);
    const raw = new Map(texts);
    // Phase 7: a passage on a scanned page records whose text its positions are in ('ocr:<engine>@<version>', contracts §2).
    const source = t.pageText.source(first.pageIndex);
    return buildTextAnchor({
      text: (p) => raw.get(p) ?? '',
      start: { page: first.pageIndex, index: first.start },
      end: { page: last.pageIndex, index: last.end },
      rects: rects.filter((r) => r.rects.length > 0),
      ...(source !== 'pdfium' ? { textSource: source } : {}),
    });
  };
}

/**
 * The page text as the annotation session reads it. Its `text()` is the aligned text (rawText): the session measures a
 * page's char count with `text(p).length` when a mark runs on over a page break, and getPageText is shorter than the
 * char count. Re-anchoring is unaffected: it reads rawText for positions anyway, and the two texts are the same once
 * folded for searching.
 */
function alignedText(p: PageTextProviderImpl): PageTextProvider {
  return {
    source: (i) => p.source(i),
    text: (i) => p.rawText(i),
    glyphs: (i) => p.glyphs(i),
    rects: (i, s, c) => p.rects(i, s, c),
    search: (i, q, o) => p.search(i, q, o),
    rawText: (i) => p.rawText(i),
    rangeText: (i, s, c) => p.rangeText(i, s, c),
  };
}

/** Figure detection for this document (S12). Nothing is written to the store while the PDF is not saved. */
export function createDocumentFigures(o: {
  backend: PdfBackend;
  doc: DocHandle;
  pages: readonly PageSize[];
  /** Phase 7.4: the layout model's figures for a scanned page (null for any other page). */
  scanFigures?: (pageIndex: number) => Promise<DetectedFigure[] | null>;
  onScanFiguresNamed?: (cb: (pageIndex: number) => void) => () => void;
}): FigureService {
  return createFigureService({ backend: o.backend, doc: o.doc, pages: o.pages, dHash64, store: null, savedDocumentId: () => null, scanFigures: o.scanFigures, onScanFiguresNamed: o.onScanFiguresNamed });
}

/**
 * The AnchorContext for this document: the page text, figures and dHash from S7 and S12, plus S3's two optional
 * members (the page size, so a figure that moved gets its new rect, and the mark rects, so a text anchor placed
 * anywhere but its stored position is drawn with rects made for these bytes).
 */
export function createAnchorContext(t: DocumentText, figures: Pick<FigureService, 'figures' | 'dHash'>): AnchorContext {
  return {
    pageCount: t.pages.length,
    text: alignedText(t.pageText),
    figures: (i) => figures.figures(i),
    dHash: (i, r) => figures.dHash(i, r),
    pageSize: (i) => {
      const s = t.pages[i];
      return s === undefined ? null : { width: s.width, height: s.height };
    },
    normRects: (i, s, c) => markNormRects(t, i, s, c),
  };
}
