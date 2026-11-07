// Text recognition for scanned pages (Phase 7, contracts §9 and the Phase 7–8 plan §9). These shapes are shared by the
// engine (apps/extension/src/ocr/engine), the service that schedules it (apps/extension/src/ocr), the store (page_ocr, schema
// v7) and the viewer's page text (packages/viewer/src/text/ocr-source.ts), which makes a recognised page behave like a text page.
//
// Geometry is the engine's: points, unrotated page space, origin at the crop box's top-left, y down (PdfRect).
import type { PageSize, PdfRect } from '../../../viewer/src/backend/types';
import type { DocumentId } from '../ids';

/** One recognised word. `line` and `block` number the word's line and block in reading order on its page. */
export interface OcrWord {
  text: string;
  /** Points, unrotated page space (PdfRect). */
  box: PdfRect;
  /** 0–1. */
  confidence: number;
  line: number;
  block: number;
}

/**
 * A page's recognised text. `text` is the page's chars in reading order (ocrText): offsets into it are this page's char
 * indices, exactly as `ocrToPageGlyphs` numbers its glyphs. Like PDFium's own chars, it holds generated spaces between
 * words, '\r\n' between lines and U+FFFE for a line-end hyphen it joins; the page text Find, search and Claude read is it
 * without U+FFFE (ocrPlainText), as getPageText is PDFium's chars without it.
 */
export interface OcrPageResult {
  documentId: DocumentId;
  pageIndex: number;
  engine: string;
  engineVersion: string;
  langs: string[];
  words: OcrWord[];
  text: string;
  createdAt: number;
}

/** What `pageKind` says about a page, for `needsOcr`. */
export interface OcrPageKind {
  /** Non-space chars of the page's own text (PDFium's, visible or not). */
  textChars: number;
  /** Words of the page's own text (runs of letters or digits). Optional; estimated from `textChars` when missing. */
  textWords?: number;
  /** Share of the page (0–1) the page's images cover. */
  imageCoverage: number;
  /** The page carries text that is not drawn (render mode 3: a scanner's own OCR layer). That counts as text. */
  hasInvisibleText: boolean;
}

/** The text recogniser. One page at a time; `recognize` rejects with an AbortError when `signal` fires. */
export interface OcrEngine {
  readonly id: string;
  readonly version: string;
  recognize(img: ImageBitmap, o: { pageSize: PageSize; dpi: number; langs: string[]; signal?: AbortSignal }): Promise<OcrWord[]>;
  dispose(): void;
}

/** The pages of one open document, as the service reads them: the tab's PdfBackend, or the offscreen page's own over the saved copy. */
export interface PageImageSource {
  pageCount: number;
  pageSize(i: number): PageSize;
  /** The page as displayed (its /Rotate applied), at `dpi`. The caller owns the bitmap (and closes it, or hands it on). */
  renderForOcr(i: number, dpi: number, signal?: AbortSignal): Promise<ImageBitmap>;
  pageKind(i: number): Promise<OcrPageKind>;
}

export interface OcrProgress {
  documentId: DocumentId;
  state: 'idle' | 'running' | 'paused' | 'done' | 'error' | 'off';
  /** Pages that need recognition (scanned pages), and how many of them have text now. */
  total: number;
  done: number;
  error: string | null;
  upgrading: boolean;
  /** Pages that kept their older text because a note on them did not re-anchor on the new text (the upgrade rule). */
  keptOld: number;
}

export interface OcrService {
  /** persist: false keeps the results in memory only (a PDF that is not saved); nothing is written anywhere. */
  start(j: { documentId: DocumentId; source: PageImageSource; persist: boolean; langs: string[] }): Promise<void>;
  /** The pages on screen now and the way the reader is scrolling: they are read next. */
  hint(id: DocumentId, h: { visible: number[]; direction: 1 | -1 }): void;
  pause(id: DocumentId): void;
  resume(id: DocumentId): void;
  /** Stops and forgets the job (and, for a memory-only job, its results). */
  stop(id: DocumentId): void;
  /** The PDF was saved: write what a memory-only job holds, and keep writing from now on. */
  adopt(id: DocumentId): Promise<void>;
  result(id: DocumentId, pageIndex: number): Promise<OcrPageResult | null>;
  onProgress(cb: (p: OcrProgress) => void): () => void;
}

/** `page_text.source` and `Anchor.textSource` of a recognised page: 'ocr:<engine>@<version>'. */
export const ocrSource = (r: Pick<OcrPageResult, 'engine' | 'engineVersion'>): string => `ocr:${r.engine}@${r.engineVersion}`;
