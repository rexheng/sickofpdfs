// PdfBackend on EmbedPDF 2.15.1, in our own module worker(s) (the Phase 0 `v2-file` variant; ENGINE_WORKERS workers).
import { ENGINE_WORKERS, type EngineAssets } from '../engine-config';
import type { PdfEngineCrashedError } from '../errors';
import type { DocHandle, FormInfo, PdfBackend } from '../types';
import { EngineWorker, type EngineApi, type EngineMethod } from './rpc';

export interface EmbedPdfBackendOptions {
  /** How many engine workers to start (default ENGINE_WORKERS). With 2, each document opens in both, and pages are routed by pageIndex % 2. */
  workers?: 1 | 2;
  /** The watchdog: a call with no answer in this time means the worker hangs (default 20 s). */
  hangTimeoutMs?: number;
  /** Time allowed for a worker to start PDFium (default 20 s). */
  startTimeoutMs?: number;
  /**
   * Makes each engine worker (default: engine.worker.ts as a module worker). Tests pass a worker that wraps the real
   * one (test/support/fault-engine.worker.ts); the product never sets it.
   */
  createWorker?: () => Worker;
  /**
   * Start the worker(s) now instead of on the first `open`, so PDFium's start-up (fetching and compiling the wasm)
   * overlaps the PDF's download. The viewer page sets it; a failed start is retried by the next `open`.
   */
  startNow?: boolean;
}

const DEFAULT_HANG_TIMEOUT_MS = 20_000;
const DEFAULT_START_TIMEOUT_MS = 20_000;

const defaultWorker = () => new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'sop-engine' });

interface OpenDoc {
  id: DocHandle;
  /** The workers holding the document: workers[pageIndex % workers.length] serves a page. */
  workers: EngineWorker[];
  /** Set when one of those workers died: every call on the document rejects with it. */
  lost: PdfEngineCrashedError | null;
  /** getFormInfo's answer, asked for once per handle (R38). */
  formInfo?: Promise<FormInfo>;
}

/** The arguments of an EngineApi method after the document id. */
type Rest<M extends EngineMethod> = Parameters<EngineApi[M]> extends [string, ...infer R] ? R : never;

/**
 * The production PdfBackend. Workers start on the first `open`. When a worker dies (crash, hang, out of memory) its
 * waiting calls reject with PdfEngineCrashedError, the documents open in it are lost (their copies in another worker
 * are closed), and the next `open` starts a fresh worker in its place.
 */
export function createEmbedPdfBackend(assets: EngineAssets, opts: EmbedPdfBackendOptions = {}): PdfBackend {
  const workerOptions = { hangTimeoutMs: opts.hangTimeoutMs ?? DEFAULT_HANG_TIMEOUT_MS, startTimeoutMs: opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS };
  const createWorker = opts.createWorker ?? defaultWorker;
  const slots: (Promise<EngineWorker> | null)[] = Array.from({ length: opts.workers ?? ENGINE_WORKERS }, () => null);
  const docs = new Map<DocHandle, OpenDoc>();
  let opened = 0;

  const closeQuietly = (w: EngineWorker, doc: DocHandle) => {
    if (!w.failure) w.call('closeDoc', [doc]).catch(() => {});
  };

  /** The live worker in `slot`, started if there is none. */
  const workerIn = (slot: number): Promise<EngineWorker> => {
    const existing = slots[slot];
    if (existing) return existing;
    const started = EngineWorker.start(createWorker(), assets, workerOptions);
    slots[slot] = started;
    started.then(
      (w) =>
        w.onDeath((err) => {
          if (slots[slot] === started) slots[slot] = null;
          for (const d of docs.values()) {
            if (d.lost || !d.workers.includes(w)) continue;
            d.lost = err;
            for (const other of d.workers) if (other !== w) closeQuietly(other, d.id);
          }
        }),
      () => {
        if (slots[slot] === started) slots[slot] = null;
      },
    );
    return started;
  };

  if (opts.startNow) for (let i = 0; i < slots.length; i++) workerIn(i).catch(() => {});

  const entry = (doc: DocHandle): OpenDoc => {
    const d = docs.get(doc);
    if (!d) throw new Error(`document ${doc} is not open`);
    if (d.lost) throw d.lost;
    return d;
  };

  /** A call on the worker serving `pageIndex` of `doc` (the first worker for document-wide calls). */
  const call = async <M extends EngineMethod>(
    doc: DocHandle,
    pageIndex: number | null,
    method: M,
    rest: Rest<M>,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<EngineApi[M]>>> => {
    const d = entry(doc);
    const n = d.workers.length;
    const w = d.workers[pageIndex !== null && Number.isInteger(pageIndex) ? ((pageIndex % n) + n) % n : 0];
    return w.call(method, [doc, ...rest] as unknown as Parameters<EngineApi[M]>, { signal });
  };

  return {
    async open(bytes, o = {}) {
      const workers = await Promise.all(slots.map((_, i) => workerIn(i)));
      const doc = `doc-${++opened}` as DocHandle;
      // Each worker gets its own copy by transfer; the last one takes the caller's buffer itself.
      const results = await Promise.allSettled(
        workers.map((w, i) => {
          const buffer = i === workers.length - 1 ? bytes : bytes.slice(0);
          return w.call('openDocument', [doc, buffer, o.password], { transfer: [buffer] });
        }),
      );
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      const failure: unknown = rejected ? rejected.reason : workers.find((w) => w.failure)?.failure;
      if (failure) {
        workers.forEach((w, i) => results[i].status === 'fulfilled' && closeQuietly(w, doc));
        throw failure instanceof Error ? failure : new Error('the engine could not open the document');
      }
      docs.set(doc, { id: doc, workers, lost: null });
      const first = results[0] as PromiseFulfilledResult<ReturnType<EngineApi['openDocument']>>;
      return { doc, ...first.value };
    },

    async close(doc) {
      const d = docs.get(doc);
      if (!d) return;
      docs.delete(doc);
      if (d.lost) return;
      await Promise.all(d.workers.filter((w) => !w.failure).map((w) => w.call('closeDoc', [doc]).catch(() => {})));
    },

    renderTile: (doc, req, signal) => call(doc, req.pageIndex, 'renderBitmap', [req], signal),
    getPageGlyphs: (doc, pageIndex) => call(doc, pageIndex, 'getGlyphs', [pageIndex]),
    getPageText: (doc, pageIndex) => call(doc, pageIndex, 'getPageText', [pageIndex]),
    getPageChars: (doc, pageIndex) => call(doc, pageIndex, 'getPageChars', [pageIndex]),
    getPageCopyText: (doc, pageIndex) => call(doc, pageIndex, 'getPageCopyText', [pageIndex]),
    getTextRange: (doc, pageIndex, start, count) => call(doc, pageIndex, 'getTextRange', [pageIndex, start, count]),
    getTextRangeRects: (doc, pageIndex, start, count) => call(doc, pageIndex, 'getTextRangeRects', [pageIndex, start, count]),
    searchPage: (doc, pageIndex, query, o) => call(doc, pageIndex, 'searchPage', [pageIndex, query, { matchCase: o.matchCase, wholeWord: o.wholeWord }]),
    getLinks: (doc, pageIndex) => call(doc, pageIndex, 'getLinks', [pageIndex]),
    getOutline: (doc) => call(doc, null, 'getOutline', []),
    async getFormInfo(doc) {
      const d = entry(doc);
      const info = (d.formInfo ??= call(doc, null, 'getFormInfo', []));
      try {
        return await info;
      } catch (err) {
        if (d.formInfo === info) d.formInfo = undefined; // a failed walk may be asked again
        throw err;
      }
    },
    listPageObjects: (doc, pageIndex, o) => call(doc, pageIndex, 'listPageObjects', [pageIndex, o]),
    getStructTree: (doc, pageIndex) => call(doc, pageIndex, 'getStructTree', [pageIndex]),
    // One implementation for both forms of the overload: the worker answers TextRunList when a budget is given.
    getTextRuns: ((doc: DocHandle, pageIndex: number, o?: { budgetMs: number }) =>
      call(doc, pageIndex, 'getTextRuns', o ? [pageIndex, { budgetMs: o.budgetMs }] : [pageIndex])) as PdfBackend['getTextRuns'],
    getGlyphOutlines: (doc, pageIndex, charStart, charCount) => call(doc, pageIndex, 'getGlyphOutlines', [pageIndex, charStart, charCount]),
    getGlyphShapes: (doc, pageIndex, charStart, charCount) => call(doc, pageIndex, 'getGlyphShapes', [pageIndex, charStart, charCount]),
    hashImageObject: (doc, pageIndex, objectIndex) => call(doc, pageIndex, 'hashImageObject', [pageIndex, objectIndex]),
  };
}
