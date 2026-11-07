// The pages of one open document as the OCR service reads them (PageImageSource, contracts §9), over a PdfBackend: the viewer
// tab's own engine for a PDF that is not saved, and the offscreen page's own engine over the saved copy for a saved one.
//
// `pageKind` reads what `needsOcr` decides by: the page's own text (PDFium's, visible or not), and how much of the page its
// pictures cover. It is cheap for a text page (one getPageText, already cached by the engine) and reads the page's objects only
// when the page has few words.
import { countWords, OCR_MAX_WORDS, type OcrPageKind, type PageImageSource } from '@sop/core';
import type { DocHandle, PageSize, PdfBackend } from '@sop/viewer';

/** The object walk is cut short here: a scanned page holds a handful of objects. */
const MAX_OBJECTS = 500;
const BUDGET_MS = 10;
/** The largest image the recogniser is given, in px a side (a huge page is drawn smaller; accuracy is flat from 100 dpi). */
const MAX_SIDE_PX = 4096;

export function createPageSource(backend: PdfBackend, doc: DocHandle, pages: readonly PageSize[]): PageImageSource {
  return {
    pageCount: pages.length,
    pageSize: (i) => pages[i] ?? { width: 612, height: 792, rotation: 0 },
    async renderForOcr(i, dpi, signal) {
      const page = pages[i];
      if (!page) throw new RangeError('no such page');
      const scale = Math.min(dpi / 72, MAX_SIDE_PX / Math.max(page.width, page.height));
      return backend.renderTile(doc, { pageIndex: i, scale, viewRotation: 0, withAnnotations: false }, signal);
    },
    async pageKind(i): Promise<OcrPageKind> {
      const page = pages[i];
      const text = await backend.getPageText(doc, i);
      const textChars = text.replace(/\s/g, '').length;
      const textWords = countWords(text);
      if (!page || textWords >= OCR_MAX_WORDS) return { textChars, textWords, imageCoverage: 0, hasInvisibleText: false };
      const { objects } = await backend.listPageObjects(doc, i, { maxObjects: MAX_OBJECTS, budgetMs: BUDGET_MS });
      const imageArea = objects.filter((o) => o.type === 'image').reduce((sum, o) => sum + o.bounds.width * o.bounds.height, 0);
      const imageCoverage = Math.min(1, imageArea / (page.width * page.height));
      // A page with a few letters of text: are they drawn, or an invisible layer (a scanner's own OCR)? Only asked then.
      let hasInvisibleText = false;
      if (/\p{L}/u.test(text)) {
        const chars = await backend.getPageChars(doc, i);
        const { glyphs } = await backend.getGlyphShapes(doc, i, 0, chars.length);
        hasInvisibleText = glyphs.length === 0;
      }
      return { textChars, textWords, imageCoverage, hasInvisibleText };
    },
  };
}
