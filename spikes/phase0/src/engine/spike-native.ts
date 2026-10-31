import { PdfiumNative, type PdfiumEngineOptions } from '@embedpdf/engines/pdfium';
import type { ImageDataLike, PdfDocumentObject } from '@embedpdf/models';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

export interface SpikeDoc {
  docId: string;
  pageCount: number;
  pages: { width: number; height: number }[];
}
/** Page-space rectangle in points, origin top-left. */
export interface SpikeRect {
  x: number;
  y: number;
  width: number;
  height: number;
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
    return { docId, pageCount: doc.pageCount, pages: doc.pages.map((p) => ({ width: p.size.width, height: p.size.height })) };
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
}
