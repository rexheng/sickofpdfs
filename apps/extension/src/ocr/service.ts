// The OCR service (contracts §9, Phase 7–8 plan 7.3): which page is read next, the one engine that reads it, and where the
// result goes. Two hosts run it:
// - a viewer tab, for a PDF that is not saved (D7.1): `persist: false`, results in memory only, gone with the tab;
// - the offscreen page's OCR worker (bg-worker.ts), for saved readings: `persist: true`, each page written to the library as
//   soon as it is read, so the work goes on after the tab closes and a crash resumes from what is stored.
//
// Rules this file keeps:
// - One page in flight across every job (an engine reads one page at a time). The pages on screen go first (scheduler.ts); a
//   page the reader scrolled away from is stopped between two recognition batches when a page on screen is waiting.
// - Only pages that need it are read (needsOcr): a page with its own text is never touched.
// - Nothing is written for a memory-only job. `adopt()` writes what it holds once the PDF is saved, and later pages are written.
// - A saved page read by an older engine version is read again last, and replaces the old text only where no note sits (upgrade.ts).
// - The engine is closed after a while with nothing to do, which gives its memory back; the next page starts a new one.
import { type DocumentId, type MarkRow, needsOcr, type OcrEngine, type OcrPageResult, type OcrProgress, type OcrService, ocrText, type PageImageSource, type ThreadRow } from '@sop/core';
import type { Rotation } from '@sop/viewer';
import { writeHeldPages } from './adopt';
import { OCR_RENDER_DPI } from './engine/models';
import { nextPage } from './scheduler';
import { pagesWithNotes } from './upgrade';

/** The part of the store the service writes and reads (StoreApi's, over a port). */
export interface OcrStore {
  putPageOcr(r: OcrPageResult, o: { index: boolean; rotation?: Rotation }): Promise<boolean>;
  getPageOcr(documentId: DocumentId, pageIndex: number): Promise<OcrPageResult | null>;
  listPageOcr(documentId: DocumentId): Promise<{ pageIndex: number; engine: string; engineVersion: string }[]>;
  listAnnotations(documentId: DocumentId): Promise<{ marks: MarkRow[]; threads: ThreadRow[] }>;
}

export interface OcrServiceDeps {
  /** Makes the engine (on the first page, and again after it was closed for being idle). */
  engine(): OcrEngine;
  /** null: memory only (a tab in Incognito, or no library). A `persist` job needs it. */
  store: OcrStore | null;
  now(): number;
  dpi?: number;
  /** The engine is closed after this long with nothing to read. */
  idleCloseMs?: number;
}

export interface OcrServiceImpl extends OcrService {
  /** Each page as soon as it is read (the tab redraws its text layer then). */
  onResult(cb: (r: OcrPageResult) => void): () => void;
  progress(id: DocumentId): OcrProgress | null;
  /** True when no job has a page left to read and none is in flight. */
  idle(): boolean;
  /** Ends every job and closes the engine. */
  dispose(): void;
}

type PageState = 'need' | 'text' | 'done' | 'failed' | 'stale' | 'kept';

interface Job {
  id: DocumentId;
  source: PageImageSource;
  persist: boolean;
  langs: string[];
  pages: Map<number, PageState>;
  failures: Map<number, number>;
  /** Memory results (a memory-only job holds every page it read; a saved one only the last few, for `result`). */
  results: Map<number, OcrPageResult>;
  visible: number[];
  direction: 1 | -1;
  hintedAt: number;
  paused: boolean;
  stopped: boolean;
  /** Set once the pages already stored are known (a saved job); scheduling waits for it. */
  ready: boolean;
  error: string | null;
  /** Failures in a row on different pages: the engine itself does not work. */
  failedInRow: number;
  keptOld: number;
  notes: Promise<Set<number>> | null;
}

/** A page that failed this many times is given up on (it keeps no text; the scan still shows). */
const MAX_PAGE_FAILURES = 2;
/** This many pages failing in a row means the engine cannot run here: the job stops with an error. */
const MAX_FAILED_IN_ROW = 3;
/** Results a saved job keeps in memory. */
const SAVED_RESULTS_KEPT = 4;
const IDLE_CLOSE_MS = 20_000;

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export function createOcrService(deps: OcrServiceDeps): OcrServiceImpl {
  const dpi = deps.dpi ?? OCR_RENDER_DPI;
  const jobs = new Map<DocumentId, Job>();
  const progressListeners = new Set<(p: OcrProgress) => void>();
  const resultListeners = new Set<(r: OcrPageResult) => void>();
  let engine: OcrEngine | null = null;
  let inflight: { job: Job; page: number; ctrl: AbortController } | null = null;
  let pumping = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const todo = (job: Job) => (i: number) => {
    const s = job.pages.get(i);
    return s === undefined || s === 'need';
  };
  const stale = (job: Job) => (i: number) => job.pages.get(i) === 'stale';

  function progressOf(job: Job): OcrProgress {
    let text = 0;
    let done = 0;
    let left = false;
    let staleLeft = false;
    for (let i = 0; i < job.source.pageCount; i++) {
      const s = job.pages.get(i);
      if (s === 'text') text++;
      else if (s === 'done' || s === 'kept' || s === 'stale') done++;
      if (s === undefined || s === 'need') left = true;
      if (s === 'stale') staleLeft = true;
    }
    const state: OcrProgress['state'] = job.error !== null ? 'error' : job.paused ? 'paused' : left || staleLeft || !job.ready ? 'running' : 'done';
    return { documentId: job.id, state, total: job.source.pageCount - text, done, error: job.error, upgrading: !left && staleLeft, keptOld: job.keptOld };
  }

  const emit = (job: Job) => {
    const p = progressOf(job);
    for (const cb of [...progressListeners]) cb(p);
  };

  const engineNow = (): OcrEngine => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    return (engine ??= deps.engine());
  };

  function choose(): { job: Job; page: number } | null {
    const order = [...jobs.values()].filter((j) => j.ready && !j.paused && !j.stopped && j.error === null).sort((a, b) => b.hintedAt - a.hintedAt);
    for (const job of order) {
      const page = nextPage({ pageCount: job.source.pageCount, todo: todo(job), visible: job.visible, direction: job.direction });
      if (page !== null) return { job, page };
    }
    // Only then the pages an older engine version read.
    for (const job of order) {
      if (!job.persist) continue;
      const page = nextPage({ pageCount: job.source.pageCount, todo: stale(job), visible: job.visible, direction: job.direction });
      if (page !== null) return { job, page };
    }
    return null;
  }

  async function step(job: Job, i: number): Promise<void> {
    const before = job.pages.get(i);
    if (before === undefined) {
      const kind = await job.source.pageKind(i).catch(() => null);
      if (job.stopped) return;
      if (kind === null) return fail(job, i, 'the page could not be read');
      if (!needsOcr(kind)) {
        job.pages.set(i, 'text');
        emit(job);
        return;
      }
      job.pages.set(i, 'need');
    }
    const ctrl = new AbortController();
    inflight = { job, page: i, ctrl };
    try {
      const e = engineNow();
      const size = job.source.pageSize(i);
      const bitmap = await job.source.renderForOcr(i, dpi, ctrl.signal);
      const words = await e.recognize(bitmap, { pageSize: size, dpi, langs: job.langs, signal: ctrl.signal });
      if (job.stopped) return;
      const r: OcrPageResult = { documentId: job.id, pageIndex: i, engine: e.id, engineVersion: e.version, langs: job.langs, words, text: ocrText(words, size.rotation), createdAt: deps.now() };
      if (job.persist && deps.store) {
        if (before === 'stale') {
          job.notes ??= pagesWithNotes(deps.store, job.id).catch(() => new Set(Array.from({ length: job.source.pageCount }, (_, k) => k)));
          if ((await job.notes).has(i)) {
            job.keptOld++;
            job.pages.set(i, 'kept');
            emit(job);
            return;
          }
        }
        await deps.store.putPageOcr(r, { index: true, rotation: size.rotation });
      }
      job.results.set(i, r);
      if (job.persist) for (const k of job.results.keys()) if (job.results.size > SAVED_RESULTS_KEPT && k !== i) job.results.delete(k);
      job.pages.set(i, 'done');
      job.failures.delete(i);
      job.failedInRow = 0;
      for (const cb of [...resultListeners]) cb(r);
      emit(job);
    } catch (error) {
      if (isAbort(error) || job.stopped) return; // stopped for a page on screen, a pause or a stop: it stays to do
      fail(job, i, error instanceof Error ? error.message : 'the page could not be read');
    } finally {
      if (inflight?.ctrl === ctrl) inflight = null;
    }
  }

  function fail(job: Job, i: number, message: string): void {
    const n = (job.failures.get(i) ?? 0) + 1;
    job.failures.set(i, n);
    if (n >= MAX_PAGE_FAILURES) job.pages.set(i, 'failed');
    job.failedInRow++;
    if (job.failedInRow >= MAX_FAILED_IN_ROW) job.error = message.slice(0, 200);
    emit(job);
  }

  async function pump(): Promise<void> {
    if (pumping || disposed) return;
    pumping = true;
    try {
      for (;;) {
        const pick = choose();
        if (pick === null) break;
        await step(pick.job, pick.page);
        if (disposed) return;
      }
    } finally {
      pumping = false;
    }
    if (engine !== null && idleTimer === null) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (inflight !== null || choose() !== null) return;
        engine?.dispose();
        engine = null;
      }, deps.idleCloseMs ?? IDLE_CLOSE_MS);
    }
  }

  /** Stops the page in flight when a page on screen (of this job, or any job hinted later) is waiting for its turn. */
  function preempt(job: Job): void {
    const f = inflight;
    if (f === null || (f.job === job && job.visible.includes(f.page))) return;
    if (job.visible.some((i) => i >= 0 && i < job.source.pageCount && todo(job)(i))) f.ctrl.abort();
  }

  return {
    async start(j) {
      if (disposed) return;
      const known = jobs.get(j.documentId);
      if (known) {
        known.source = j.source;
        if (j.persist && !known.persist) known.persist = true;
        void pump();
        return;
      }
      if (j.persist && deps.store === null) throw new Error('ocr: a saved reading needs the library');
      const job: Job = {
        id: j.documentId,
        source: j.source,
        persist: j.persist,
        langs: [...j.langs],
        pages: new Map(),
        failures: new Map(),
        results: new Map(),
        visible: [],
        direction: 1,
        hintedAt: deps.now(),
        paused: false,
        stopped: false,
        ready: !j.persist,
        error: null,
        failedInRow: 0,
        keptOld: 0,
        notes: null,
      };
      jobs.set(j.documentId, job);
      if (j.persist && deps.store) {
        try {
          const e = engineNow();
          for (const s of await deps.store.listPageOcr(j.documentId)) job.pages.set(s.pageIndex, s.engine === e.id && s.engineVersion === e.version ? 'done' : 'stale');
        } catch {
          // The store did not answer: every page is read again; putPageOcr replaces what is there.
        }
        job.ready = true;
      }
      emit(job);
      void pump();
    },

    hint(id, h) {
      const job = jobs.get(id);
      if (!job) return;
      job.visible = h.visible.filter((i) => Number.isSafeInteger(i) && i >= 0 && i < job.source.pageCount);
      job.direction = h.direction;
      job.hintedAt = deps.now();
      preempt(job);
      void pump();
    },

    pause(id) {
      const job = jobs.get(id);
      if (!job || job.paused) return;
      job.paused = true;
      if (inflight?.job === job) inflight.ctrl.abort();
      emit(job);
    },

    resume(id) {
      const job = jobs.get(id);
      if (!job || !job.paused) return;
      job.paused = false;
      emit(job);
      void pump();
    },

    stop(id) {
      const job = jobs.get(id);
      if (!job) return;
      job.stopped = true;
      jobs.delete(id);
      if (inflight?.job === job) inflight.ctrl.abort();
    },

    async adopt(id) {
      const job = jobs.get(id);
      if (!job || deps.store === null) return;
      job.persist = true;
      const pages = job.source;
      await writeHeldPages(deps.store, job.results.values(), (i) => pages.pageSize(i).rotation);
    },

    async result(id, pageIndex) {
      const job = jobs.get(id);
      const held = job?.results.get(pageIndex);
      if (held) return held;
      if (job?.persist && deps.store) return deps.store.getPageOcr(id, pageIndex).catch(() => null);
      return null;
    },

    onProgress(cb) {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },

    onResult(cb) {
      resultListeners.add(cb);
      return () => resultListeners.delete(cb);
    },

    progress(id) {
      const job = jobs.get(id);
      return job ? progressOf(job) : null;
    },

    idle() {
      return inflight === null && choose() === null;
    },

    dispose() {
      disposed = true;
      for (const job of jobs.values()) job.stopped = true;
      jobs.clear();
      inflight?.ctrl.abort();
      if (idleTimer !== null) clearTimeout(idleTimer);
      engine?.dispose();
      engine = null;
    },
  };
}
