// The figures of one open document (Phase 2 S12): detection that never slows page drawing, a per-page cache, and the two
// calls re-anchoring needs. `figures(pageIndex)` and `dHash(pageIndex, rect)` are AnchorContext's (contracts §2), so the
// anchor context (S13) passes them on as they are.
//
// How it runs:
// - pageRendered(i), called after a page's full render, queues the page; queued pages are worked at idle priority, the
//   most recently rendered first, one at a time. Each engine call goes to the worker on its own, so a render asked for
//   meanwhile is served between them, and every call has a budget (objects 15 ms, text runs 15 ms, the detector 20 ms).
// - figures(i) answers from memory, then from the store's page_figures (saved documents only), then detects at once.
// - Results stay in memory for the document's life. They are written to page_figures only for a saved document, and
//   only when complete (no input cut short, no budget run out): an incomplete result depends on the machine's speed.
//   A result cut short by a time budget is detected again, up to twice (MAX_RETRIES): at once when a caller is waiting
//   for it (figures()), otherwise at idle after the other queued pages, the cut result being served meanwhile.
// - imageSha256: the largest image object among a figure's objects, hashed in the engine (hashImageObject).
import type { DetectedFigure, DocumentId, NormRect, PageFigure } from '@sop/core';
import type { DocHandle, PageSize, PdfBackend } from '../backend/types';
import { analysePage, DETECTOR_VERSION, FIND_FIGURES_BUDGET_MS } from './find-figures';
import { regionGrey9x8 } from './region-dhash';

/** The text runs' budget for detection (the object list's is listPageObjects' default, 15 ms). */
export const TEXT_RUNS_BUDGET_MS = 15;
/** Pages waiting for idle detection; older ones are dropped beyond this (they are detected again when drawn again). */
const MAX_QUEUED_PAGES = 32;
/** listPageObjects' default maxObjects: a list cut at this count is cut by size, the same every time. */
const MAX_OBJECTS = 20_000;
/** A result cut short by a time budget (a busy moment) is detected again at most this many more times. */
const MAX_RETRIES = 2;

/**
 * The outline rule (research 06 §3.2 step 4 and §3.7): only high-confidence figures get the hover outline; medium ones
 * appear while Alt is held (S16). Gate 2 decides between this and 'caption-linked' (only figures with a caption), the
 * fallback if precision on the reference set is below 95%.
 */
export const OUTLINE_RULE: 'high-confidence' | 'caption-linked' = 'high-confidence';

/** Whether a figure gets the hover outline (OUTLINE_RULE). */
export function isOutlined(f: PageFigure): boolean {
  return OUTLINE_RULE === 'caption-linked' ? f.captionRect !== null : f.confidence === 'high';
}

/** The store's page_figures cache (S2's StoreApi has both, contracts / plan §7). */
export interface PageFigureStore {
  getPageFigures(documentId: DocumentId, pageIndex: number, detectorVersion: string): Promise<PageFigure[] | null>;
  putPageFigures(documentId: DocumentId, pageIndex: number, detectorVersion: string, figures: PageFigure[]): Promise<void>;
}

export interface FigureServiceOptions {
  backend: Pick<PdfBackend, 'listPageObjects' | 'getTextRuns' | 'getStructTree' | 'renderTile' | 'hashImageObject'>;
  doc: DocHandle;
  /** OpenResult.pages. */
  pages: readonly PageSize[];
  /** S3's dHash64 (packages/core/src/anchoring/dhash.ts): the 9 × 8 grey grid (row-major) to its hash. */
  dHash64(grey9x8: Uint8Array): string;
  /** page_figures, or null (no store, Incognito). */
  store?: PageFigureStore | null;
  /** The document's id while it is saved in the library; null while it is not, and then nothing is written. */
  savedDocumentId?: () => DocumentId | null;
  /** Runs `task` when the main thread is idle; returns a cancel. Default requestIdleCallback (2 s timeout). */
  idle?: (task: () => void) => () => void;
  /**
   * Phase 7.4: the figures of a scanned page, found by a layout model (nothing in a scan's objects says where its figures are).
   * Returns null for a page that is not a scan, which is then found from its objects as always. A scan's figures are kept in
   * memory only: they are not written to page_figures (a model change must not leave old boxes behind).
   */
  scanFigures?: (pageIndex: number) => Promise<DetectedFigure[] | null>;
  /** Phase 7.4: `cb(pageIndex)` when a scan's figures can be named better (its recognised words arrived): they are found again. */
  onScanFiguresNamed?: (cb: (pageIndex: number) => void) => () => void;
}

export interface FigureService {
  /** The page's figures (every confidence), detecting them now if they are not known yet. */
  figures(pageIndex: number): Promise<PageFigure[]>;
  /** The region's dHash (research 06 §5): regionGrey9x8, then dHash64. */
  dHash(pageIndex: number, rect: NormRect): Promise<string>;
  /** The page has had its full render: find its figures at idle priority. */
  pageRendered(pageIndex: number): void;
  /** The page's figures if they are known now, without detecting (for hover). */
  peek(pageIndex: number): PageFigure[] | undefined;
  /** Called with a page index when that page's figures become known, or change after a retry. Returns the unsubscribe. */
  subscribe(listener: (pageIndex: number) => void): () => void;
  /** Stops idle work. Calls made afterwards still answer. */
  dispose(): void;
}

const defaultIdle = (task: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => task(), { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, 0);
  return () => clearTimeout(id);
};

export function createFigureService(o: FigureServiceOptions): FigureService {
  const { backend, doc, pages } = o;
  const idle = o.idle ?? defaultIdle;
  const known = new Map<number, PageFigure[]>();
  const pending = new Map<number, Promise<PageFigure[]>>();
  const listeners = new Set<(pageIndex: number) => void>();
  let queue = new Set<number>(); // insertion order; the last one is worked first
  const retries = new Map<number, number>();
  let working = false;
  let cancelIdle: (() => void) | null = null;
  let disposed = false;
  /** Detections waiting for an idle moment: dispose lets them go on at once. */
  const waiting = new Set<() => void>();

  const pageSize = (pageIndex: number): PageSize => {
    const page = Number.isInteger(pageIndex) ? pages[pageIndex] : undefined;
    if (!page) throw new RangeError(`page ${pageIndex} is out of range (0–${pages.length - 1})`);
    return page;
  };
  /** Waits for an idle moment (or not at all when someone is waiting for the answer). */
  const whenIdle = (urgent: boolean) =>
    urgent || disposed
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const done = () => {
            waiting.delete(done);
            resolve();
          };
          waiting.add(done);
          idle(done);
        });

  /** The page's figures, and whether a time budget cut the work short (worth another try when the machine is idle). */
  const detect = async (pageIndex: number, urgent: boolean): Promise<{ figures: PageFigure[]; retry: boolean }> => {
    const page = pageSize(pageIndex);
    const saved = o.store ? (o.savedDocumentId?.() ?? null) : null;
    if (saved && o.store) {
      const stored = await o.store.getPageFigures(saved, pageIndex, DETECTOR_VERSION).catch(() => null);
      // An empty cached result may be a scan from before scans were read by the layout model: look again.
      if (stored && !(stored.length === 0 && o.scanFigures)) return { figures: stored, retry: false };
    }
    if (o.scanFigures) {
      const found = await o.scanFigures(pageIndex).catch(() => null);
      if (found !== null) {
        await whenIdle(urgent);
        return { figures: found.map((f, index) => ({ ...f, index, objectIndices: [], caption: (f as Partial<PageFigure>).caption ?? null, imageSha256: null })), retry: false };
      }
    }
    // One engine call at a time, so renders asked for in between are not held up behind all three.
    const list = await backend.listPageObjects(doc, pageIndex, { recurseForms: true });
    const runs = await backend.getTextRuns(doc, pageIndex, { budgetMs: TEXT_RUNS_BUDGET_MS });
    const struct = await backend.getStructTree(doc, pageIndex);
    await whenIdle(urgent);
    const analysis = analysePage(
      { page, objects: list.objects, truncated: list.truncated, runs: runs.runs, runsTruncated: runs.truncated, struct },
      { budgetMs: FIND_FIGURES_BUDGET_MS },
    );
    const figures: PageFigure[] = [];
    for (const f of analysis.figures) {
      // The largest image object of the figure (research 06 §5).
      let best = -1;
      let bestArea = 0;
      for (const i of f.objectIndices) {
        const obj = list.objects[i];
        if (obj?.type !== 'image') continue;
        const a = obj.bounds.width * obj.bounds.height;
        if (a > bestArea) [best, bestArea] = [i, a];
      }
      const imageSha256 = best >= 0 ? await backend.hashImageObject(doc, pageIndex, best).catch(() => null) : null;
      figures.push({ ...f, imageSha256 });
    }
    const savedNow = o.store ? (o.savedDocumentId?.() ?? null) : null;
    if (analysis.complete && savedNow && o.store) void o.store.putPageFigures(savedNow, pageIndex, DETECTOR_VERSION, figures).catch(() => {});
    const retry = (list.truncated && list.objects.length < MAX_OBJECTS) || runs.truncated || analysis.timedOut;
    return { figures, retry };
  };

  /** Detects the page unless its figures are known (`again`: a retry, which replaces what is known). */
  const run = (pageIndex: number, urgent: boolean, again = false): Promise<PageFigure[]> => {
    const have = known.get(pageIndex);
    if (have && !again) return Promise.resolve(have);
    const inFlight = pending.get(pageIndex);
    if (inFlight) return inFlight;
    // Someone waiting for the answer (re-anchoring a figure note) gets the retries at once, not a result cut short.
    const attempt = async () => {
      let result = await detect(pageIndex, urgent);
      for (let tries = retries.get(pageIndex) ?? 0; urgent && result.retry && tries < MAX_RETRIES; tries++) {
        retries.set(pageIndex, tries + 1);
        result = await detect(pageIndex, true);
      }
      return result;
    };
    const job = attempt().then(
      ({ figures, retry }) => {
        pending.delete(pageIndex);
        known.set(pageIndex, figures);
        const tries = retries.get(pageIndex) ?? 0;
        if (retry && tries < MAX_RETRIES && !disposed) {
          retries.set(pageIndex, tries + 1);
          queue = new Set([pageIndex, ...queue]); // first in line is worked last
          pump();
        }
        for (const listener of [...listeners]) listener(pageIndex);
        return figures;
      },
      (err: unknown) => {
        pending.delete(pageIndex); // a failure is not remembered: the page may be asked again
        throw err;
      },
    );
    pending.set(pageIndex, job);
    return job;
  };

  const pump = () => {
    if (disposed || working || cancelIdle || queue.size === 0) return;
    cancelIdle = idle(() => {
      cancelIdle = null;
      const pageIndex = [...queue].at(-1);
      if (pageIndex === undefined || disposed) return;
      queue.delete(pageIndex);
      working = true;
      run(pageIndex, false, known.has(pageIndex))
        .catch(() => {}) // idle detection that fails (the document closed, the engine stopped) is dropped
        .finally(() => {
          working = false;
          pump();
        });
    });
  };

  const offNamed = o.onScanFiguresNamed?.((pageIndex) => {
    if (!disposed && known.has(pageIndex) && !pending.has(pageIndex)) void run(pageIndex, false, true).catch(() => {});
  });

  return {
    figures: (pageIndex) => run(pageIndex, true),
    async dHash(pageIndex, rect) {
      return o.dHash64(await regionGrey9x8(backend, doc, pageIndex, pageSize(pageIndex), rect));
    },
    pageRendered(pageIndex) {
      if (disposed || known.has(pageIndex) || pending.has(pageIndex) || !pages[pageIndex]) return; // a retry queues itself
      queue.delete(pageIndex);
      queue.add(pageIndex);
      while (queue.size > MAX_QUEUED_PAGES) queue.delete(queue.values().next().value!);
      pump();
    },
    peek: (pageIndex) => known.get(pageIndex),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      queue.clear();
      cancelIdle?.();
      cancelIdle = null;
      for (const done of [...waiting]) done();
      listeners.clear();
      offNamed?.();
    },
  };
}
