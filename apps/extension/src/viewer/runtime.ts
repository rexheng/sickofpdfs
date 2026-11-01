/**
 * What the viewer publishes about itself for tests to read. Production code writes here with `publishRuntime`;
 * nothing in this file is global, and nothing in production reads it. Later tasks add fields.
 */
import type { PageBox, PagePoint, PdfBackend, ViewerSnapshot } from '@sop/viewer';
import type { OpenedDocument } from './open-document';

/** Where opening the PDF stands. A password prompt is still `loading`. */
export type ViewerState = 'loading' | 'ready' | 'error' | 'bounced';

/** The page list, as tests drive and read it. Coordinates: client px, and page points (unrotated, top-left origin). */
export interface ViewerHooks {
  scale(): number;
  setScale(s: number): void;
  currentPage(): number;
  /** Scrolls page `pageIndex` to the top; resolves once its full render is on screen. */
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
