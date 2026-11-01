/**
 * What the viewer publishes about itself for tests to read. Production code writes here with `publishRuntime`;
 * nothing in this file is global, and nothing in production reads it. Later tasks add fields.
 */
import type { DocumentId, SaveState } from '@sop/core';
import type { CharRange, PageBox, PagePoint, PdfBackend, ViewerSnapshot } from '@sop/viewer';
import type { BlobStore } from '../store/blob-store';
import type { StoreClient } from '../store/client';
import type { AnnotationSession } from './annotations/session';
import type { OpenedDocument } from './open-document';

/** Where opening the PDF stands. A password prompt is still `loading`. */
export type ViewerState = 'loading' | 'ready' | 'error' | 'bounced';

/** The page list, as tests drive and read it. Coordinates: client px, and page points (unrotated, top-left origin). */
export interface ViewerHooks {
  scale(): number;
  setScale(s: number): void;
  currentPage(): number;
  /** Scrolls page `pageIndex` to the top; resolves once its full render and its text layer are on screen. */
  scrollTo(pageIndex: number): Promise<void>;
  snapshot(): ViewerSnapshot;
  scrollTop(): number;
  maxScrollTop(): number;
  viewportHeight(): number;
  pageBoxes(): PageBox[];
  /** Client px → page point (the zoom anchor maths); null between pages. */
  pdfPointAt(x: number, y: number): PagePoint | null;
  clientPointOf(p: PagePoint): { x: number; y: number };
  /** Whether a page is a scan (no text layer, mostly image): the scan hint shows on such pages. */
  isScannedPage(pageIndex: number): Promise<boolean>;
}

export interface ViewerRuntime {
  /** The tab's one engine. */
  backend: PdfBackend;
  doc(): OpenedDocument | null;
  viewerState(): ViewerState;
  viewer: ViewerHooks;
  /** The library store, once connected after the PDF opened. Null in Incognito or when the library cannot be reached. */
  store: StoreClient | null;
  /** The chars the selection covers, by page (PDFium char indices; `end` exclusive). */
  selectionRanges(): CharRange[];
  /** The centre of char `charIndex`'s PDFium box on page `pageIndex`, in client px (NaN while its text layer is not built). */
  glyphCenter(pageIndex: number, charIndex: number): { x: number; y: number };
  /** The copies of saved PDFs (Task 30). Null in Incognito. */
  blobStore: BlobStore | null;
  /** The open PDF's library save (Task 30), once its controller exists. */
  save: SaveHooks;
  /**
   * Phase 2: the open document's notes (marks, threads, drafts), as the viewer draws them. Null in Incognito, where
   * there are no notes, and while no document is open.
   */
  annotations: AnnotationSession | null;
}

/** The save controller as tests (and Phase 2's first mark) drive it. */
export interface SaveHooks {
  state(): SaveState;
  /** The library document, while the PDF is saved; null otherwise. */
  documentId(): DocumentId | null;
  /** What the first mark or note does on a PDF that is not saved: resolves once it is saved, or the question shows. */
  firstMark(): Promise<void>;
}

let registry: Partial<ViewerRuntime> = {};

/** Merges `p` into the registry. */
export function publishRuntime(p: Partial<ViewerRuntime>): void {
  registry = { ...registry, ...p };
}

/** A copy of everything published so far. */
export function readRuntime(): Partial<ViewerRuntime> {
  return { ...registry };
}
