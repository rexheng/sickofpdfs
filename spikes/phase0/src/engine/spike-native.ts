import { PdfiumNative, type PdfiumEngineOptions } from '@embedpdf/engines/pdfium';
import type { ImageDataLike, PdfDocumentObject, PdfTask } from '@embedpdf/models';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

export interface SpikeDoc {
  docId: string;
  pageCount: number;
  /** width × height as displayed (EmbedPDF's page size, after /Rotate); rotation is the page's /Rotate in degrees. */
  pages: { width: number; height: number; rotation: 0 | 90 | 180 | 270 }[];
}
/** Page-space rectangle in points, origin top-left. */
export interface SpikeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Points, unrotated page space (the page's /Rotate is not applied), origin at the top-left of the crop box. */
export type Rect = SpikeRect;

/** One PDFium text-page char (field names fixed by ruling R5: Task 15 ports this unchanged). */
export interface Glyph {
  /** PDFium char index on the page. */
  index: number;
  /**
   * The char as FPDFText_GetText gives it: one UTF-16 code unit (an astral char is two Glyphs that share a box),
   * U+FFFE for a line-end hyphen PDFium joins across the line break, '\r' and '\n' for its generated line breaks.
   */
  text: string;
  /** FPDFText_GetLooseCharBox: the advance × the font's ascent–descent. Zero-size for generated chars. */
  box: Rect;
  /** FPDFText_GetCharBox: the glyph's ink. */
  tight: Rect;
  /** Effective size in points: FPDFText_GetFontSize × the char matrix's vertical scale (Chromium writes Tf 32 with a 0.75 matrix). */
  fontSize: number;
  /** Degrees in [0, 360), clockwise as displayed (y down): FPDFText_GetCharAngle, which is atan2(c, a) of the char matrix. */
  angle: number;
  /** FPDFText_IsGenerated: a space or line break PDFium inserted; it has no glyph. */
  generated: boolean;
}
export interface PageGlyphs {
  pageIndex: number;
  /** Every char of the page, in PDFium char-index order (glyphs[i].index === i). */
  glyphs: Glyph[];
  /** getPageGeometry's runs: consecutive chars of one PDFium text object; end is exclusive. */
  runs: { start: number; end: number }[];
}

/**
 * The spike's PdfiumNative. Methods added here are called by name through SpikeEngine.call and
 * take a docId (a string) instead of PdfDocumentObject. The patch on @embedpdf/engines makes
 * `pdfiumModule` and `cache` protected, so later checks can reach PDFium directly.
 */
export class SpikeNative extends PdfiumNative {
  private readonly requestedFonts: string[];
  private readonly docs = new Map<string, PdfDocumentObject>();

  constructor(module: WrappedPdfiumModule, options: PdfiumEngineOptions = {}) {
    const requested: string[] = [];
    const fallback = options.fontFallback;
    const load = fallback?.fontLoader;
    super(module, {
      ...options,
      fontFallback: fallback && {
        ...fallback,
        fontLoader: (url) => {
          requested.push(url);
          return load ? load(url) : null;
        },
      },
    });
    this.requestedFonts = requested;
  }

  /** Every fallback-font URL PDFium asked for, in order (the fallback manager caches, so once per file). */
  fontRequests(): string[] {
    return [...this.requestedFonts];
  }

  async openBuffer(docId: string, content: ArrayBuffer, password?: string): Promise<SpikeDoc> {
    const doc = await this.openDocumentBuffer({ id: docId, content }, { password }).toPromise();
    this.docs.set(docId, doc);
    return {
      docId,
      pageCount: doc.pageCount,
      pages: doc.pages.map((p) => ({ width: p.size.width, height: p.size.height, rotation: ((p.rotation * 90) % 360) as 0 | 90 | 180 | 270 })),
    };
  }

  /**
   * Every char on the page with its PDFium geometry. Runs come from getPageGeometry. Its boxes do not: it
   * rounds them to whole device pixels at 1 px per point (FPDF_PageToDevice), up to 0.5 pt off, which is
   * 0.67 CSS px at 100% and 1.33 px at 200%. So the boxes are read here, unrounded, from the same
   * FPDFText_GetLooseCharBox, with FPDFText_GetCharBox, GetCharAngle, IsGenerated, GetFontSize and GetMatrix.
   */
  getGlyphs(docId: string, pageIndex: number): PageGlyphs {
    const doc = this.doc(docId);
    const page = doc.pages[pageIndex];
    if (!page) throw new Error(`page ${pageIndex} out of range (0–${doc.pageCount - 1})`);
    const geometry = settled(this.getPageGeometry(doc, page));
    const runs = geometry.runs.map((r) => ({ start: r.charStart, end: r.charStart + r.glyphs.length }));

    const m = this.pdfiumModule;
    const heap = m.pdfium;
    const pageCtx = this.cache.getContext(doc.id)!.acquirePage(pageIndex);
    const mem = heap.wasmExports.malloc(64);
    try {
      const textPage = pageCtx.getTextPage();
      const count = m.FPDFText_CountChars(textPage);
      const f32 = (offset: number) => heap.getValue(mem + offset, 'float');
      const f64 = (offset: number) => heap.getValue(mem + offset, 'double');
      // The crop box's top-left is the origin of top-left page space.
      m.FPDF_GetPageBoundingBox(pageCtx.pagePtr, mem);
      const left = f32(0);
      const top = f32(4);
      const rect = (l: number, t: number, r: number, b: number): Rect => ({ x: l - left, y: top - t, width: r - l, height: t - b });
      const text = this.pageText(textPage, count);

      const glyphs: Glyph[] = [];
      for (let i = 0; i < count; i++) {
        m.FPDFText_GetLooseCharBox(textPage, i, mem); // FS_RECTF: left, top, right, bottom
        const box = rect(f32(0), f32(4), f32(8), f32(12));
        m.FPDFText_GetCharBox(textPage, i, mem, mem + 8, mem + 16, mem + 24); // doubles: left, right, bottom, top
        const tight = rect(f64(0), f64(24), f64(8), f64(16));
        m.FPDFText_GetMatrix(textPage, i, mem); // FS_MATRIX: a b c d e f (floats)
        const fontSize = m.FPDFText_GetFontSize(textPage, i) * Math.hypot(f32(8), f32(12));
        const angle = Math.round(((m.FPDFText_GetCharAngle(textPage, i) * 180) / Math.PI) * 1000) / 1000;
        glyphs.push({ index: i, text: text[i] ?? '', box, tight, fontSize, angle: angle % 360, generated: m.FPDFText_IsGenerated(textPage, i) === 1 });
      }
      return { pageIndex, glyphs, runs };
    } finally {
      heap.wasmExports.free(mem);
      pageCtx.release();
    }
  }

  /** PDFium's text for chars [start, start + count): FPDFText_GetText through getTextSlices (which strips U+FFFE and the like). */
  getTextRange(docId: string, pageIndex: number, start: number, count: number): string {
    return settled(this.getTextSlices(this.doc(docId), [{ pageIndex, charIndex: start, charCount: count }]))[0] ?? '';
  }

  /** RGBA pixels of a page (or of `rect` within it) at `scale` device pixels per point. */
  renderRaw(docId: string, pageIndex: number, scale: number, rect?: SpikeRect): Promise<ImageDataLike> {
    const doc = this.doc(docId);
    const page = doc.pages[pageIndex];
    if (!page) throw new Error(`page ${pageIndex} out of range (0–${doc.pageCount - 1})`);
    const task = rect
      ? this.renderPageRect(doc, page, { origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } }, { scaleFactor: scale })
      : this.renderPageRaw(doc, page, { scaleFactor: scale });
    return task.toPromise();
  }

  async closeDoc(docId: string): Promise<void> {
    await this.closeDocument(this.doc(docId)).toPromise();
    this.docs.delete(docId);
  }

  protected doc(docId: string): PdfDocumentObject {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`document ${docId} is not open`);
    return doc;
  }

  /** FPDFText_GetText for the whole page: one UTF-16 code unit per char index. */
  private pageText(textPage: number, count: number): string {
    const heap = this.pdfiumModule.pdfium;
    const buf = heap.wasmExports.malloc(2 * (count + 1));
    try {
      this.pdfiumModule.FPDFText_GetText(textPage, 0, count, buf);
      let out = '';
      for (let i = 0; i < count; i++) out += String.fromCharCode(heap.getValue(buf + 2 * i, 'i16') & 0xffff);
      return out;
    } finally {
      heap.wasmExports.free(buf);
    }
  }
}

/** The value of a PdfTask that has already settled (PDFium calls are synchronous; the task wraps the result). */
function settled<T>(task: PdfTask<T>): T {
  let out: { value: T } | undefined;
  let failure: unknown;
  task.wait(
    (value) => (out = { value }),
    (error) => (failure = error),
  );
  if (out) return out.value;
  throw new Error(`PDFium task did not settle synchronously: ${JSON.stringify(failure ?? 'pending')}`);
}
