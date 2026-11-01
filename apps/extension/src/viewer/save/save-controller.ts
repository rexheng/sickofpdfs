// The library save of the open PDF (Task 30): works out whether it is already in the library, asks the filter when it
// is not, and runs the save and forget effects the save machine (@sop/core reduceSave) asks for. It owns the chip's
// state and the 10 s Undo after a first-mark save.
//
// Privacy rules this file keeps:
// - Nothing is written for a PDF the library does not hold until a save: identity only reads (plus an alias of a
//   document that is already saved), and the filter runs in memory.
// - `touchLocation` and `recordOpen` are called here and nowhere else, once, when the PDF turns out to be known. A new
//   document's first location and history row come with `saveDocument` itself.
// - Incognito touches neither the store nor the blob store.
// - Undo (and later "Forget this PDF") deletes every row of the document and its stored copy (R13). A save that fails
//   half-way removes the copy it made, so no copy is left without its document.
import {
  type DocumentId,
  type FilterDecision,
  type FilterInput,
  type LocationKind,
  needsSecondLook,
  reduceSave,
  type SaveEffect,
  type SaveEvent,
  type SaveState,
  sampleIndexes,
  secondLookIndexes,
} from '@sop/core';
import type { PdfBackend, SaveController } from '@sop/viewer';
import type { BlobStore } from '../../store/blob-store';
import type { StoreClient } from '../../store/client';
import { type IdentityResult, resolveIdentity } from '../identity/resolve-identity';
import type { OpenedDocument } from '../open-document';

/** How long "Undo" stays next to the chip after a first mark saved the PDF. */
export const UNDO_MS = 10_000;
/** Pages of text per `putPageText` call. */
export const PAGE_TEXT_BATCH = 50;

/** Tooltips of the "Saved to library" chip after a save in this tab (an automatic save shows the filter's reasons). */
export const SAVED_BY_OWNER = 'You saved it';
export const SAVED_BY_FIRST_MARK = 'Your first mark saved it';

export interface SaveLocation {
  kind: LocationKind;
  raw: string;
  /** The course or web page the PDF was opened from. */
  viaPage: string | null;
}

export interface SaveControllerDeps {
  opened: OpenedDocument;
  backend: PdfBackend;
  /**
   * Null in Incognito, or when the library could not be reached. It may be given while it still connects (a promise),
   * so the controller exists as soon as the PDF is open; `start()` waits for it, in the `checking` state.
   */
  store: StoreClient | null | Promise<StoreClient | null>;
  /** Null in Incognito; without it a save keeps no copy of the PDF (`blobStored: false`). May be a promise too. */
  blobs: BlobStore | null | Promise<BlobStore | null>;
  /** The learning filter: `standInFilter` until Phase 3 passes `classify`. */
  filter: (i: FilterInput) => FilterDecision;
  incognito: boolean;
  /** Where the PDF was opened from; null for a file picked from disk. */
  location: SaveLocation | null;
  now(): number;
}

/** What the viewer's chrome reads beyond the shared SaveController contract. */
export interface SaveControllerImpl extends SaveController {
  /** The effect running now: the chip reads "Saving…", and Undo waits. Changes are announced through `subscribe`. */
  readonly busy: 'save' | 'forget' | null;
  /** The reasons a save in this tab stored, for the chip's tooltip; null when the PDF was already in the library. */
  readonly savedReasons: readonly string[] | null;
  /** The library document, while the state is `saved`. */
  documentId(): DocumentId | null;
  /** `cb` hears of a save or forget that failed. The state is then what it was before; the call also rejects. */
  onFailure(cb: (what: 'save' | 'forget') => void): () => void;
  /** Stops the Undo timer and the listeners. */
  dispose(): void;
}

type SaveCause = 'filter' | 'owner' | 'first-mark';

export function createSaveController(d: SaveControllerDeps): SaveControllerImpl {
  const { loaded, open } = d.opened;
  const openedAt = d.now();
  const listeners = new Set<(s: SaveState) => void>();
  const failureListeners = new Set<(what: 'save' | 'forget') => void>();
  let state: SaveState = { kind: 'checking' };
  let busy: { kind: 'save' | 'forget'; done: Promise<void> } | null = null;
  let decision: FilterDecision | null = null;
  let savedReasons: readonly string[] | null = null;
  let started: Promise<void> | null = null;
  let undoTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** The store and blob store, once `start()` has them. Effects only run after that. */
  let store: StoreClient | null = null;
  let blobs: BlobStore | null = null;

  const notify = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb(state);
      } catch {
        // One listener's failure must not stop the others.
      }
    }
  };

  const stopUndoTimer = (): void => {
    if (undoTimer !== null) clearTimeout(undoTimer);
    undoTimer = null;
  };

  const startUndoTimer = (): void => {
    stopUndoTimer();
    undoTimer = setTimeout(() => {
      undoTimer = null;
      void dispatch({ type: 'undo-expired' });
    }, UNDO_MS);
  };

  function set(next: SaveState): void {
    const wasUndoable = state.kind === 'saved' && state.undoable;
    const undoable = next.kind === 'saved' && next.undoable;
    if (next === state) return;
    state = next;
    if (undoable && !wasUndoable) startUndoTimer();
    if (!undoable) stopUndoTimer();
    if (next.kind !== 'saved') savedReasons = null;
    notify();
  }

  // ---- page text: read once, page by page, so page renders can go between the engine calls ----
  const texts = new Map<number, Promise<string>>();
  const textOf = (pageIndex: number): Promise<string> => {
    const hit = texts.get(pageIndex);
    if (hit) return hit;
    const p = d.backend.getPageText(open.doc, pageIndex);
    texts.set(pageIndex, p);
    p.catch(() => {
      if (texts.get(pageIndex) === p) texts.delete(pageIndex); // a failed read may be asked again
    });
    return p;
  };
  async function textsOf(indexes: number[]): Promise<string[]> {
    const out: string[] = [];
    for (const i of indexes) out.push(await textOf(i));
    return out;
  }
  const allPageTexts = (): Promise<string[]> => textsOf(Array.from({ length: open.pageCount }, (_, i) => i));

  /**
   * The filter's view of the PDF: links, names, sizes, metadata and the text of the first and last 5 pages (and of up
   * to 10 middle pages when those hold almost no words). Text the engine cannot read counts as no text.
   */
  async function filterInput(): Promise<FilterInput> {
    const read = (indexes: number[]) => textsOf(indexes).catch(() => indexes.map(() => ''));
    let sampleText = await read(sampleIndexes(open.pageCount));
    if (needsSecondLook(sampleText)) sampleText = [...sampleText, ...(await read(secondLookIndexes(open.pageCount)))];
    return {
      url: loaded.sourceUrl ?? d.location?.raw ?? null,
      fileName: loaded.displayName,
      pageCount: open.pageCount,
      pageSizes: open.pages,
      metadata: open.metadata,
      sampleText,
      viaPage: d.location?.viaPage ?? null,
    };
  }

  // ---- effects ----
  async function saveEffect(undoable: boolean, cause: SaveCause): Promise<void> {
    if (store === null) throw new Error('library-unavailable: the library could not be opened in this tab');
    const id = loaded.sha256;
    const pages = await allPageTexts();
    const put = blobs === null ? null : await blobs.put(loaded.blob, id);
    const reasons = cause === 'filter' ? (decision?.reasons ?? []) : [cause === 'owner' ? SAVED_BY_OWNER : SAVED_BY_FIRST_MARK];
    try {
      await store.saveDocument({
        id,
        byteSize: loaded.size,
        pageCount: open.pageCount,
        title: open.metadata.title,
        authors: [],
        pdfId: open.metadata.pdfId,
        hasText: pages.some((t) => /\S/u.test(t)),
        encrypted: open.encrypted,
        blobStored: put !== null,
        saveReasons: reasons,
        location: d.location,
        openedAt,
      });
    } catch (error) {
      if (put?.created === true) await dropCopyWithoutDocument(store, blobs, id);
      throw error;
    }
    try {
      for (let at = 0; at < pages.length; at += PAGE_TEXT_BATCH) {
        await store.putPageText(
          id,
          pages.slice(at, at + PAGE_TEXT_BATCH).map((text, k) => ({ pageIndex: at + k, text })),
        );
      }
    } catch (error) {
      // The document is saved; only search misses some of its pages. Nothing about the PDF goes in the message.
      console.warn('sickofpdfs: the page text was not all stored', error instanceof Error ? error.message.split(':')[0] : '');
    }
    texts.clear(); // the library has the text now; this tab no longer needs its copy
    savedReasons = reasons;
    await dispatch({ type: 'saved', documentId: id, undoable });
  }

  /** The copy this tab stored, when the document did not get saved after all (another tab may have saved it). */
  async function dropCopyWithoutDocument(lib: StoreClient, copies: BlobStore | null, id: DocumentId): Promise<void> {
    const there = await lib.getDocument(id).then(
      (row) => row !== null,
      () => false,
    );
    if (!there) await copies?.delete(id).catch(() => {});
  }

  async function forgetEffect(): Promise<void> {
    if (store === null || state.kind !== 'saved') return;
    const id = state.documentId;
    await store.forgetDocument(id);
    await blobs?.delete(id);
    const step = reduceSave(state, { type: 'undone' });
    // The reducer goes back to the stand-in's "not sure"; the filter's own reasons are the right tooltip.
    set(step.state.kind === 'unsure' && decision?.verdict === 'unsure' ? { kind: 'unsure', reasons: decision.reasons } : step.state);
  }

  function run(effect: SaveEffect, cause: SaveCause): Promise<void> {
    if (effect.kind === 'ask') return Promise.resolve(); // the question shows while the state is `asking`
    if (busy !== null) {
      // One effect at a time. A second save while one runs is the same save.
      if (busy.kind === effect.kind) return busy.done;
      return busy.done.then(
        () => run(effect, cause),
        () => run(effect, cause),
      );
    }
    const kind = effect.kind;
    const done = (kind === 'save' ? saveEffect(effect.undoable, cause) : forgetEffect()).then(
      () => {
        busy = null;
        notify();
      },
      (error: unknown) => {
        busy = null;
        if (kind === 'forget' && state.kind === 'saved' && state.undoable) startUndoTimer(); // Undo can be tried again
        notify();
        for (const cb of [...failureListeners]) cb(kind);
        throw error;
      },
    );
    busy = { kind, done };
    notify();
    return done;
  }

  async function dispatch(e: SaveEvent): Promise<void> {
    if (disposed) return;
    const step = reduceSave(state, e);
    set(step.state);
    if (step.effect === null) return;
    const cause: SaveCause = e.type === 'classified' ? 'filter' : e.type === 'first-mark' ? 'first-mark' : 'owner';
    await run(step.effect, cause);
  }

  async function begin(): Promise<void> {
    if (d.incognito) return dispatch({ type: 'incognito' });
    [store, blobs] = await Promise.all([d.store, Promise.resolve(d.blobs).catch(() => null)]);
    if (store === null) {
      // No library in this tab: notes are kept until the tab closes.
      set({ kind: 'memory-only' });
      return;
    }
    let identity: IdentityResult = { kind: 'unknown' };
    try {
      identity = await resolveIdentity({ sha256: loaded.sha256, pageCount: open.pageCount, pageTexts: allPageTexts }, store);
    } catch (error) {
      // Treated as a new PDF: the owner can still save it. Nothing about the PDF goes in the message.
      console.warn('sickofpdfs: the library could not say whether it holds this PDF', error instanceof Error ? error.message.split(':')[0] : '');
    }
    if (identity.kind === 'known') {
      const documentId = identity.documentId;
      try {
        if (d.location !== null) await store.touchLocation({ documentId, ...d.location, at: d.now() });
        await store.recordOpen(documentId, d.now());
      } catch (error) {
        console.warn('sickofpdfs: this open was not recorded', error instanceof Error ? error.message.split(':')[0] : '');
      }
      return dispatch({ type: 'identified', documentId });
    }
    const input = await filterInput();
    try {
      decision = d.filter(input);
    } catch {
      decision = { verdict: 'unsure', reasons: [] }; // a filter that fails leaves the choice to the owner
    }
    try {
      await dispatch({ type: 'classified', decision }); // a learning verdict saves here
    } catch {
      // The automatic save failed: the owner can save it from the chip.
      if (state.kind === 'checking') set({ kind: 'unsure', reasons: decision.reasons });
    }
  }

  /** Waits for `start()` (when it was called), so a request made while the PDF is being identified is not lost. */
  const afterStart = async (): Promise<void> => {
    if (started !== null) await started.catch(() => {});
  };

  return {
    get state() {
      return state;
    },
    get busy() {
      return busy?.kind ?? null;
    },
    get savedReasons() {
      return savedReasons;
    },
    documentId: () => (state.kind === 'saved' ? state.documentId : null),
    subscribe(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    onFailure(cb) {
      failureListeners.add(cb);
      return () => void failureListeners.delete(cb);
    },
    start: () => (started ??= begin()),
    async requestSave() {
      await afterStart();
      await dispatch({ type: 'save-requested' });
    },
    async firstMark() {
      await afterStart();
      await dispatch({ type: 'first-mark' });
    },
    async undo() {
      stopUndoTimer();
      await dispatch({ type: 'undo-requested' });
    },
    async answerAsk(save) {
      await dispatch({ type: 'ask-answered', save });
    },
    dispose() {
      disposed = true;
      stopUndoTimer();
      listeners.clear();
      failureListeners.clear();
    },
  };
}
