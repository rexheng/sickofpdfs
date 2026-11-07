// A scanned page's recognised text, merged into the page text everything reads (Phase 7.1, contracts §9). `withOcr` wraps the
// PDFium provider (page-text.ts, unchanged): a page with a recognised result answers from it, every other page from PDFium.
// So the text layer, selection painting, marks, anchoring, Find and Claude treat a scan like a text page.
//
// - `source(i)` is 'ocr:<engine>@<version>' for a recognised page, so anchors made on it record their textSource.
// - `rawText(i)` is the page's chars (OcrPageResult.text: U+FFFE kept where a line-end hyphen is joined), and `text(i)` is the
//   same without U+FFFE, exactly as getPageChars and getPageText are for a text page. Offsets into rawText are char indices.
// - `glyphs`, `rects` and `search` run on the word boxes (packages/core/src/ocr).
//
// The lookup decides which pages have results. It must answer a text page at once and never block it on recognition:
// a page waits only while it is not yet known whether a stored result exists for it (a saved scan, just reopened).
import { ocrPlainText, ocrRects, ocrSource, ocrText, ocrToPageGlyphs, searchOcr, type OcrPageResult } from '@sop/core';
import type { Rotation } from '../backend/types';
import { textModelRange, trimPageText } from '../text-layer/items';
import type { PageTextProviderImpl } from './page-text';

export interface OcrLookup {
  /** The page's recognised result as it is known now, or null: what `source()` reads (it cannot wait). */
  known(pageIndex: number): OcrPageResult | null;
  /** The page's result, once it is known whether there is one; null for a page PDFium reads. */
  page(pageIndex: number): Promise<OcrPageResult | null>;
  /** The page's /Rotate (a turned scan's words run at ocrAngle(rotation) in unrotated space). */
  rotation(pageIndex: number): Rotation;
}

export function withOcr(base: PageTextProviderImpl, lookup: OcrLookup): PageTextProviderImpl {
  const on = async <T>(i: number, ocr: (r: OcrPageResult, rotation: Rotation) => T, pdfium: () => Promise<T>): Promise<T> => {
    const r = await lookup.page(i);
    return r === null ? pdfium() : ocr(r, lookup.rotation(i));
  };
  return {
    source: (i) => {
      const r = lookup.known(i);
      return r === null ? base.source(i) : ocrSource(r);
    },
    text: (i) => on(i, (r, rot) => ocrPlainText(ocrText(r.words, rot)), () => base.text(i)),
    rawText: (i) => on(i, (r, rot) => ocrText(r.words, rot), () => base.rawText(i)),
    glyphs: (i) => on(i, (r, rotation) => ocrToPageGlyphs(r, { rotation }), () => base.glyphs(i)),
    rects: (i, start, count) => on(i, (r, rot) => ocrRects(r, start, count, rot), () => base.rects(i, start, count)),
    rangeText: (i, start, count) => on(i, (r, rot) => ocrPlainText(ocrText(r.words, rot).slice(start, start + count)), () => base.rangeText(i, start, count)),
    search: (i, query, o) => on(i, (r, rot) => searchOcr(r, query, o, rot), () => base.search(i, query, o)),
    copyText: (i) =>
      on(
        i,
        (r, rotation) => {
          const g = ocrToPageGlyphs(r, { rotation });
          return { text: trimPageText(textModelRange(g, 0, g.glyphs.length)), charCount: g.glyphs.length };
        },
        () => base.copyText(i),
      ),
    clear: () => base.clear(),
  };
}
