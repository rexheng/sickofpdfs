// Scanned pages in the viewer tab (Phase 7.3's two hosts, the tab's side). The tab decides where its scan is read, and merges what
// is read into the page text everything reads (withOcr, packages/viewer/src/text/ocr-source.ts):
// - A saved reading: the offscreen page's OCR worker reads it (ocr/host.ts), from the saved copy, and goes on after the tab closes.
//   The tab asks for it on the OCR channel, tells it which pages are on screen, and reads each page back from the library when
//   its `page_ocr` row arrives (a store change event).
// - A PDF that is not saved (not sure, not learning, a receipt, Incognito; D7.1): the tab reads it itself, in memory only, with an
//   engine of its own. Nothing is written, posted or kept: it is gone when the tab closes. When the owner saves it (Save, or a
//   first mark), what was read is written to the library then, and the background takes over for the rest.
//
// The viewer chrome for it (the "Reading text" chip, Pause, Settings) is Phase 7.5's; this file only gives it what it needs.
import { countWords, type DocumentId, needsOcr, OCR_MAX_WORDS, type OcrPageResult, type OcrProgress } from '@sop/core';
import type { OcrLookup, PageTextProviderImpl, PdfBackend } from '@sop/viewer';
import { writeHeldPages } from '../../ocr/adopt';
import { createOcrEngine } from '../../ocr/engine/engine';
import { OCR_LANGS } from '../../ocr/engine/models';
import { createPageSource } from '../../ocr/page-source';
import { onOcrProgress, postOcr } from '../../ocr/progress';
import { createOcrService, type OcrServiceImpl } from '../../ocr/service';
import type { StoreClient } from '../../store/client';
import type { OpenedDocument } from '../open-document';
import type { SaveControllerImpl } from '../save/save-controller';
import { libraryStore } from '../use-store';

export interface ViewerOcr {
  lookup: OcrLookup;
  /** Whether the tab expects recognised text for its scanned pages (so "open it in Chrome's viewer" is not needed). */
  reading(): boolean;
  /** The page has recognised text now. */
  has(pageIndex: number): boolean;
  /** `cb(pageIndex)` each time a page's recognised text arrives or goes. */
  onPageText(cb: (pageIndex: number) => void): () => void;
  /** How far the reading is (this tab's, or the background's for a saved reading); null before anything started. */
  progress(): OcrProgress | null;
  onProgress(cb: (p: OcrProgress) => void): () => void;
  /** The pages that have recognised text now, in order (the test hooks read it). */
  recognised(): number[];
  /** The pages on screen, and the way the reader is scrolling. */
  hint(visible: number[], direction: 1 | -1): void;
  /** The library save, once it exists (one render after the PDF opens): the tab follows its state. */
  attach(save: SaveControllerImpl | null): () => void;
  dispose(): void;
}

export interface ViewerOcrDeps {
  backend: PdfBackend;
  opened: OpenedDocument;
  /** The PDFium page text (the provider withOcr wraps), for the quick "this page has its own text" check. */
  base: PageTextProviderImpl;
}

/** A page waits at most this long to learn whether a stored result exists (a saved scan that was just reopened). */
const SETTLE_MAX_MS = 5000;
/** A tab hands its scan to the background at most this long after the save: the page it is reading is finished first. */
const DRAIN_MAX_MS = 10_000;
/** The save decision is waited for at most this long before an unsaved scan is read in memory anyway. */
const CHECKING_MAX_MS = 4000;

type Mode = { kind: 'unknown' } | { kind: 'off' } | { kind: 'memory' } | { kind: 'saved'; id: DocumentId };

export function createViewerOcr(d: ViewerOcrDeps): ViewerOcr {
  const pages = d.opened.open.pages;
  const source = createPageSource(d.backend, d.opened.open.doc, pages);
  /** The memory job's key: the file's own hash. It is never stored or sent anywhere. */
  const memoryId = d.opened.loaded.sha256;
  const results = new Map<number, OcrPageResult>();
  const loads = new Map<number, Promise<OcrPageResult | null>>();
  const kinds = new Map<number, Promise<boolean>>();
  const textListeners = new Set<(i: number) => void>();
  const progressListeners = new Set<(p: OcrProgress) => void>();
  let mode: Mode = { kind: 'unknown' };
  let stored = new Set<number>();
  let store: StoreClient | null = null;
  let service: OcrServiceImpl | null = null;
  let requested = false;
  let lastProgress: OcrProgress | null = null;
  let hintNow: { visible: number[]; direction: 1 | -1 } = { visible: [0], direction: 1 };
  let disposed = false;
  const offs: (() => void)[] = [];

  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
    setTimeout(resolve, SETTLE_MAX_MS);
  });

  const tell = (i: number) => {
    for (const cb of [...textListeners]) cb(i);
  };
  const setProgress = (p: OcrProgress) => {
    lastProgress = p;
    for (const cb of [...progressListeners]) cb(p);
  };

  /** Whether page i is a scanned page the recogniser reads (asked once a page). */
  const needs = (i: number): Promise<boolean> => {
    let k = kinds.get(i);
    if (!k) {
      k = source.pageKind(i).then(needsOcr, () => false);
      kinds.set(i, k);
    }
    return k;
  };

  const setting = async (key: string): Promise<boolean> => {
    try {
      return (await store?.getSetting(key)) !== false;
    } catch {
      return true;
    }
  };

  // ---- the memory job (a PDF that is not saved) ----

  const startMemory = async (): Promise<void> => {
    if (service !== null || disposed) return;
    const made = createOcrService({ engine: () => createOcrEngine({ base: chrome.runtime.getURL('') }), store: null, now: () => Date.now() });
    service = made;
    made.onResult((r) => {
      if (mode.kind === 'off' || service !== made) return;
      results.set(r.pageIndex, r);
      tell(r.pageIndex);
    });
    made.onProgress((p) => setProgress({ ...p, documentId: memoryId }));
    await made.start({ documentId: memoryId, source, persist: false, langs: OCR_LANGS });
    made.hint(memoryId, hintNow);
  };

  const stopMemory = (): void => {
    service?.dispose();
    service = null;
  };

  // ---- a saved reading (the background reads it) ----

  const askBackground = (id: DocumentId): void => {
    if (requested) return;
    requested = true;
    offs.push(onOcrProgress(id, setProgress));
    postOcr({ type: 'ocr:start', documentId: id, ...hintNow });
  };

  const loadStored = (id: DocumentId, i: number): Promise<OcrPageResult | null> => {
    let p = loads.get(i);
    if (!p) {
      p = (store?.getPageOcr(id, i) ?? Promise.resolve(null)).then(
        (r) => {
          if (r !== null && mode.kind === 'saved' && mode.id === id) {
            const had = results.get(i);
            results.set(i, r);
            // The page the tab wrote itself (adopt) comes back the same: its text layer is not built again for nothing.
            if (had === undefined || had.text !== r.text) tell(i);
          }
          return r;
        },
        () => null,
      );
      loads.set(i, p);
      void p.finally(() => loads.delete(i));
    }
    return p;
  };

  async function becomeSaved(id: DocumentId): Promise<void> {
    const wasMemory = service !== null;
    mode = { kind: 'saved', id };
    try {
      stored = new Set((await (store?.listPageOcr(id) ?? Promise.resolve([]))).map((s) => s.pageIndex));
    } catch {
      stored = new Set();
    }
    settle();
    if (wasMemory && store !== null) {
      // A page on screen that the library does not have yet is finished here first (it is the one being read); then what the
      // tab read before the save goes into the library (D7.1), and the background reads the rest.
      const draining = service;
      if (!stored.has(hintNow.visible[0] ?? 0)) {
        await Promise.race([draining?.drain(), new Promise((resolve) => setTimeout(resolve, DRAIN_MAX_MS))]);
      }
      if (service === draining) stopMemory();
      const held = [...results.values()].filter((r) => !stored.has(r.pageIndex)).map((r) => ({ ...r, documentId: id }));
      await writeHeldPages(store, held, (i) => pages[i]?.rotation ?? 0);
      for (const r of held) stored.add(r.pageIndex);
    }
    if (!(await setting('ocr.enabled'))) return;
    if (stored.size > 0 || wasMemory || (await needs(hintNow.visible[0] ?? 0))) askBackground(id);
  }


  async function becomeUnsaved(): Promise<void> {
    mode = { kind: 'memory' };
    settle();
    if (!(await setting('ocr.enabled')) || !(await setting('ocr.unsavedInMemory'))) {
      mode = { kind: 'off' };
      stopMemory();
      if (results.size > 0) {
        const gone = [...results.keys()];
        results.clear();
        for (const i of gone) tell(i);
      }
      return;
    }
    if (await needs(hintNow.visible[0] ?? 0)) await startMemory();
  }

  const follow = (s: SaveControllerImpl['state']): void => {
    if (disposed || s.kind === 'checking') return;
    if (s.kind === 'saved') {
      if (mode.kind !== 'saved' || mode.id !== s.documentId) void becomeSaved(s.documentId);
    } else if (mode.kind !== 'memory' && mode.kind !== 'off') {
      // Not saved, or no longer saved (the save's Undo forgot it: the library's copy of the text went with it).
      requested = false;
      void becomeUnsaved();
    }
  };

  let storeKnown: () => void = () => {};
  const storeReady = new Promise<void>((resolve) => {
    storeKnown = resolve;
  });
  void libraryStore().then((client) => {
    if (disposed) return;
    store = client;
    if (client !== null) {
      offs.push(
        client.onChange((c) => {
          if (mode.kind !== 'saved' || c.documentId !== mode.id || c.table !== 'page_ocr') return;
          const id = mode.id;
          for (const key of c.ids) {
            const i = Number(key.slice(key.lastIndexOf(':') + 1));
            if (!Number.isSafeInteger(i)) continue;
            if (c.op === 'delete') {
              if (results.delete(i)) tell(i);
              stored.delete(i);
            } else {
              stored.add(i);
              loads.delete(i);
              void loadStored(id, i);
            }
          }
        }),
      );
    }
    storeKnown();
  });
  // A save decision that takes long (or a tab with no library): the scan is read in memory meanwhile; nothing is written before it is saved.
  setTimeout(() => {
    if (mode.kind !== 'unknown' || disposed) return;
    void storeReady.then(() => {
      if (mode.kind === 'unknown' && !disposed) void becomeUnsaved();
    });
  }, CHECKING_MAX_MS);

  const lookup: OcrLookup = {
    known: (i) => results.get(i) ?? null,
    async page(i) {
      const hit = results.get(i);
      if (hit) return hit;
      // A page with its own text never waits for anything.
      if (countWords(await d.base.text(i).catch(() => '')) >= OCR_MAX_WORDS) return null;
      await settled;
      const now = results.get(i);
      if (now) return now;
      if (mode.kind === 'saved' && stored.has(i)) return loadStored(mode.id, i);
      return null;
    },
    rotation: (i) => pages[i]?.rotation ?? 0,
  };

  return {
    lookup,
    // Until the save decision is known the scan is expected to be read (only the owner's "off" switch stops it).
    reading: () => mode.kind !== 'off' || results.size > 0,
    has: (i) => results.has(i),
    recognised: () => [...results.keys()].sort((a, b) => a - b),
    onPageText(cb) {
      textListeners.add(cb);
      return () => textListeners.delete(cb);
    },
    progress: () => lastProgress,
    onProgress(cb) {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    hint(visible, direction) {
      hintNow = { visible: visible.filter((i) => i >= 0 && i < pages.length), direction };
      // Before the save decision is known (a few seconds for a scan) the page on screen is read in memory already: that writes
      // nothing, and a saved reading takes it over (becomeSaved).
      if (mode.kind === 'memory' || mode.kind === 'unknown') {
        if (service) service.hint(memoryId, hintNow);
        else
          void needs(hintNow.visible[0] ?? 0).then(async (n) => {
            if (n && (mode.kind === 'memory' || mode.kind === 'unknown')) await startMemory();
          });
      } else if (mode.kind === 'saved') {
        const id = mode.id;
        if (requested) postOcr({ type: 'ocr:hint', documentId: id, ...hintNow });
        else
          void needs(hintNow.visible[0] ?? 0).then(async (n) => {
            if (n && mode.kind === 'saved' && (await setting('ocr.enabled'))) askBackground(id);
          });
      }
    },
    attach(save) {
      if (save === null) return () => {};
      let off: (() => void) | null = null;
      let live = true;
      void storeReady.then(() => {
        if (!live || disposed) return;
        follow(save.state);
        off = save.subscribe(follow);
      });
      return () => {
        live = false;
        off?.();
      };
    },
    dispose() {
      disposed = true;
      stopMemory();
      for (const off of offs) off();
      results.clear();
      textListeners.clear();
      progressListeners.clear();
    },
  };
}
