// The one way marks, find and Claude read a page's text (contracts §2). It wraps PdfBackend, caches per page, and joins
// several callers' requests for one page into one engine call.
//
// Two texts, one position system. A char offset is a PDFium char index. `text()` is getPageText: what Find, Claude and
// the library see. PDFium keeps some chars in its char list that are not text (U+FFFE where it joins a line-end
// hyphen, soft hyphens, zero-width spaces), and getPageText drops them, so after the first one its offsets are shifted
// from the char indices. `rawText()` keeps them, so that raw[i] is char i. Anchors are built and re-placed on
// `rawText()`; on the first page of ResNet, getPageText is 14 chars shorter than the 4,355 chars PDFium has.
// `rangeText()` is getTextRange: the cleaned text of a range of char indices, which needs no alignment and costs one
// engine call, where `rawText()` reads every glyph of the page (about 45 ms for a page of maths).
import type { DocHandle, PageGlyphs, PdfBackend, PdfRect, SearchHit } from '../backend/types';

export interface PageTextProvider {
  /** 'pdfium' | 'ocr:<engine>@<version>'. */
  source(pageIndex: number): string;
  /** getPageText: the page's text without the chars that are not text. Its offsets are not char indices (see above). */
  text(pageIndex: number): Promise<string>;
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  /** Merged line rects for chars [start, start + count) (FPDFText_CountRects / GetRect, R44), in points. */
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
  search(pageIndex: number, query: string, o: { matchCase: boolean; wholeWord: boolean }): Promise<SearchHit[]>;
  /**
   * Optional, S7's addition: the page's chars as PDFium has them, one UTF-16 unit each, so `raw[i]` is char `i`, and
   * the chars that are not text are still there. Anchoring uses it when it exists, and reads `text()` as if it were
   * aligned when it does not (a provider with no such chars, such as OCR text, has nothing to align).
   */
  rawText?(pageIndex: number): Promise<string>;
  /**
   * Optional, S7's addition: getTextRange. The text of chars [start, start + count) of the page, without the chars that
   * are not text. `count` may run past the end of the page. Anchoring uses it to check a stored position without
   * reading the whole page.
   */
  rangeText?(pageIndex: number, start: number, count: number): Promise<string>;
}

export interface PageTextProviderImpl extends PageTextProvider {
  rawText(pageIndex: number): Promise<string>;
  rangeText(pageIndex: number, start: number, count: number): Promise<string>;
  /** Forgets everything cached (after the document is closed or replaced). */
  clear(): void;
}

/** Glyph arrays are big (about 300 bytes a char), so only the last few pages are kept. */
const GLYPH_PAGES_KEPT = 8;
/** Distinct (start, count) rect requests kept per page. */
const RECT_REQUESTS_KEPT = 128;

export function createPageTextProvider(be: PdfBackend, doc: DocHandle): PageTextProviderImpl {
  const texts = new Map<number, Promise<string>>();
  const raws = new Map<number, Promise<string>>();
  const glyphPages = new Map<number, Promise<PageGlyphs>>();
  const rectPages = new Map<number, Map<string, Promise<PdfRect[]>>>();

  /** Caches the promise, and drops it again if it fails so that the next call can try again. */
  function remember<T>(cache: Map<number, Promise<T>>, key: number, make: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit) return hit;
    const p = make();
    cache.set(key, p);
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
    return p;
  }

  const glyphs = (pageIndex: number): Promise<PageGlyphs> => {
    const hit = glyphPages.get(pageIndex);
    if (hit) {
      // Most recently used goes last.
      glyphPages.delete(pageIndex);
      glyphPages.set(pageIndex, hit);
      return hit;
    }
    const p = remember(glyphPages, pageIndex, () => be.getPageGlyphs(doc, pageIndex));
    while (glyphPages.size > GLYPH_PAGES_KEPT) {
      const oldest = glyphPages.keys().next().value;
      if (oldest === undefined) break;
      glyphPages.delete(oldest);
    }
    return p;
  };

  return {
    source: () => 'pdfium',
    text: (pageIndex) => remember(texts, pageIndex, () => be.getPageText(doc, pageIndex)),
    glyphs,
    rawText: (pageIndex) => remember(raws, pageIndex, async () => (await glyphs(pageIndex)).glyphs.map((g) => g.text).join('')),
    rects(pageIndex, start, count) {
      let page = rectPages.get(pageIndex);
      if (!page) rectPages.set(pageIndex, (page = new Map<string, Promise<PdfRect[]>>()));
      const key = `${start}:${count}`;
      const hit = page.get(key);
      if (hit) return hit;
      const p = be.getTextRangeRects(doc, pageIndex, start, count);
      page.set(key, p);
      p.catch(() => {
        if (page.get(key) === p) page.delete(key);
      });
      if (page.size > RECT_REQUESTS_KEPT) {
        const oldest = page.keys().next().value;
        if (oldest !== undefined) page.delete(oldest);
      }
      return p;
    },
    rangeText: (pageIndex, start, count) => be.getTextRange(doc, pageIndex, start, count),
    search: (pageIndex, query, o) => be.searchPage(doc, pageIndex, query, o),
    clear() {
      texts.clear();
      raws.clear();
      glyphPages.clear();
      rectPages.clear();
    },
  };
}
