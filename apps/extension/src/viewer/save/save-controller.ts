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
// - R67: Undo and Forget also remove what this computer kept of the PDF outside the store (forgetLocalTraces), and every
//   open tab follows a forget back to "Not sure". The first-mark Undo is offered only while that mark is all there is,
//   in any tab; a save a note started has none.
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
import type { StoreChange } from '../../store/change-bus';
import { forgetLocalTraces } from './local-traces';
import type { StoreClient } from '../../store/client';
import { type IdentityResult, resolveIdentity } from '../identity/resolve-identity';
import type { OpenedDocument } from '../open-document';

/** What the viewer calls a PDF whose address gives no name (displayNameFor's fallback). Never a title. */
const GENERIC_NAME = 'document.pdf';

/** How long "Undo" stays next to the chip after a first mark saved the PDF. */
export const UNDO_MS = 10_000;
/** Pages of text per `putPageText` call. */
export const PAGE_TEXT_BATCH = 50;

/** Tooltips of the "Saved to library" chip after a save in this tab (an automatic save shows the filter's reasons). */
export const SAVED_BY_OWNER = 'You saved it';
export const SAVED_BY_FIRST_MARK = 'Your first mark saved it';
export const SAVED_BY_FIRST_NOTE = 'Your first note saved it';

/** R67 (c): the channel on which a tab tells the others that a PDF has more than its first mark now. */
export const SAVE_CHANNEL = 'sop-save';
interface MoreContent {
  type: 'more-content';
  /** The file's fingerprint and, once saved, its library id. */
  ids: string[];
}

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
  /** R67 (a): the last save failed and nothing has saved the PDF since. The chip says "Couldn't save. Try again". */
  readonly failed: boolean;
  /** The library document, while the state is `saved`. */
  documentId(): DocumentId | null;
  /**
   * The saved document is in the library's Trash (ruling R76): the chip says "In Trash" and offers Restore. Opening it
   * never restores it by itself. Changes are announced through `subscribe`.
   */
  readonly trashed: boolean;
  /** Takes the saved document out of the Trash. Rejects when the library could not do it. */
  restoreFromTrash(): Promise<void>;
  /** `cb` hears of a save or forget that failed. The state is then what it was before; the call also rejects. */
  onFailure(cb: (what: 'save' | 'forget') => void): () => void;
  /** Stops the Undo timer and the listeners. */
  dispose(): void;
}

type SaveCause = 'filter' | 'owner' | 'first-mark' | 'first-note';

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
  let trashed = false;
  /** The store and blob store, once `start()` has them. Effects only run after that. */
  let store: StoreClient | null = null;
  let blobs: BlobStore | null = null;
  /** Stops listening to the library's changes (another tab's save). */
  let stopFollowing: (() => void) | null = null;
  /** R67 (a): the last save failed. */
  let failed = false;
  /** R67 (c): since the last first mark here, more was made here (another mark, a note): its save gets no Undo. */
  let moreHere = false;
  /** R67 (f): the last first-mark save here was asked for by a note. */
  let byNote = false;
  /** R67 (c): another tab said it has more on this PDF; a save here gets no Undo until the PDF is forgotten. */
  let othersAdded = false;
  /** R67 (b): this tab's last save created the document (not another tab's, not one already there). */
  let createdHere = false;
  /** R67 (c): tells the other tabs; null in Incognito or where there is no BroadcastChannel. */
  let channel: BroadcastChannel | null = null;

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
    if (next.kind === 'saved') failed = false;
    if (undoable && !wasUndoable) startUndoTimer();
    if (!undoable) stopUndoTimer();
    if (next.kind !== 'saved') {
      savedReasons = null;
      trashed = false; // a PDF that is not in the library is not in its Trash either
    }
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

  /**
   * The PDF's own title. A file picked from disk with none is saved under its file name (ruling R76), since it has no
   * link the library could name it by; a PDF from the web without one is named by its link.
   */
  function titleToSave(): string | null {
    const own = open.metadata.title?.trim() ?? '';
    if (/[\p{L}\p{N}]/u.test(own)) return own;
    if (d.location !== null || loaded.displayName === GENERIC_NAME) return open.metadata.title;
    const name = loaded.displayName.replace(/\.pdf$/i, '').trim();
    return /[\p{L}\p{N}]/u.test(name) ? name : open.metadata.title;
  }

  // ---- effects ----
  async function saveEffect(undoable: boolean, cause: SaveCause): Promise<void> {
    if (store === null) throw new Error('library-unavailable: the library could not be opened in this tab');
    const id = loaded.sha256;
    const pages = await allPageTexts();
    const put = blobs === null ? null : await blobs.put(loaded.blob, id);
    const reasons =
      cause === 'filter' ? (decision?.reasons ?? []) : [cause === 'owner' ? SAVED_BY_OWNER : cause === 'first-note' ? SAVED_BY_FIRST_NOTE : SAVED_BY_FIRST_MARK];
    let created: boolean;
    try {
      ({ created } = await store.saveDocument({
        id,
        byteSize: loaded.size,
        pageCount: open.pageCount,
        title: titleToSave(),
        authors: [],
        pdfId: open.metadata.pdfId,
        hasText: pages.some((t) => /\S/u.test(t)),
        encrypted: open.encrypted,
        blobStored: put !== null,
        saveReasons: reasons,
        location: d.location,
        openedAt,
      }));
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
    createdHere = created && (cause === 'first-mark' || cause === 'first-note');
    // R67 (c): Undo only ever removes the save and the one mark that caused it. Not when this tab did not create the
    // document, nor when more was made meanwhile, here or in another tab.
    await dispatch({ type: 'saved', documentId: id, undoable: undoable && created && !moreHere && !othersAdded });
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
    // R67 (e): the drafts' crash-safe copies, the save-pending records and the margin hint go with the document.
    forgetLocalTraces(id, loaded.sha256);
    await blobs?.delete(id);
    backToNotSure();
  }

  /** After a forget, here or in another tab (R67 d): "Not sure" again, and the next first mark starts afresh. */
  function backToNotSure(): void {
    othersAdded = false;
    moreHere = false;
    byNote = false;
    createdHere = false;
    const step = reduceSave(state, { type: 'undone' });
    // The reducer goes back to the stand-in's "not sure"; the filter's own reasons are the right tooltip.
    set(step.state.kind === 'unsure' && decision?.verdict === 'unsure' ? { kind: 'unsure', reasons: decision.reasons } : step.state);
  }

  /** R67 (c): no Undo for what is saved here, or for the save on its way. */
  function endUndoHere(): void {
    moreHere = true;
    if (state.kind === 'saved' && state.undoable) void dispatch({ type: 'undo-expired' });
  }

  function tellOthers(): void {
    try {
      const msg: MoreContent = { type: 'more-content', ids: [loaded.sha256, ...(state.kind === 'saved' ? [state.documentId] : [])] };
      channel?.postMessage(msg);
    } catch {
      // the other tabs keep their Undo a little longer; it still runs out after 10 s
    }
  }

  function onMoreContent(e: MessageEvent): void {
    const m = e.data as Partial<MoreContent> | null;
    if (disposed || !m || m.type !== 'more-content' || !Array.isArray(m.ids)) return;
    const mine = m.ids.includes(loaded.sha256) || (state.kind === 'saved' && m.ids.includes(state.documentId));
    if (!mine) return;
    othersAdded = true;
    endUndoHere();
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
    if (kind === 'save') failed = false;
    const done = (kind === 'save' ? saveEffect(effect.undoable, cause) : forgetEffect()).then(
      () => {
        busy = null;
        notify();
      },
      (error: unknown) => {
        busy = null;
        if (kind === 'save' && state.kind !== 'saved') failed = true; // R67 (a): the chip offers to try again
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
    const cause: SaveCause =
      e.type === 'classified'
        ? 'filter'
        : e.type === 'first-mark' || (e.type === 'resume-save' && e.undoable)
          ? e.undoable === false
            ? 'first-note'
            : 'first-mark'
          : 'owner';
    await run(step.effect, cause);
  }

  /** Records this open of a PDF the library holds: its location and its history row. */
  async function recordKnownOpen(lib: StoreClient, documentId: DocumentId): Promise<void> {
    try {
      if (d.location !== null) await lib.touchLocation({ documentId, ...d.location, at: d.now() });
      await lib.recordOpen(documentId, d.now());
    } catch (error) {
      console.warn('sickofpdfs: this open was not recorded', error instanceof Error ? error.message.split(':')[0] : '');
    }
  }

  /**
   * Tabs in step (plan section 4 item 8): when another tab saves this PDF (a `documents` upsert), or records this copy
   * as an alias of a saved one, a tab that has not saved it yet looks again and follows: it becomes `saved` too. Not
   * while it is still checking (start() decides then), saving itself, or kept in memory because the owner said No here.
   * Following writes nothing: this tab's own open and address are recorded the next time the PDF is opened.
   */
  let following: Promise<void> | null = null;
  let lookAgain = false;
  /** Reads whether the saved document is in the Trash now, and tells the chip when that changed. */
  async function readTrashed(lib: StoreClient, documentId: DocumentId): Promise<void> {
    const row = await lib.getDocument(documentId).catch(() => null);
    const now = row !== null && row.deletedAt !== null;
    if (disposed || now === trashed || state.kind !== 'saved' || state.documentId !== documentId) return;
    trashed = now;
    notify();
  }

  function onLibraryChange(c: StoreChange): void {
    if (disposed) return;
    if (c.table === 'documents' && c.op === 'delete') {
      // R67 (d): another tab forgot this PDF (its Undo). This tab follows: "Not sure", and its notes session drops what
      // the store no longer has. Never "Saved" for a PDF that is not saved. While a save or Undo runs here, that decides.
      const mine = c.ids.includes(loaded.sha256) || (state.kind === 'saved' && c.ids.includes(state.documentId));
      if (mine) othersAdded = false;
      if (mine && state.kind === 'saved' && busy === null) backToNotSure();
      return;
    }
    // R76 (d): the saved document went to the Trash, or came back (the library tab, another tab): the chip follows.
    if (c.table === 'documents' && c.op === 'upsert' && store !== null && state.kind === 'saved' && c.ids.includes(state.documentId)) {
      void readTrashed(store, state.documentId);
      return;
    }
    if (c.op !== 'upsert' || (c.table !== 'documents' && c.table !== 'aliases')) return;
    if (following !== null) {
      lookAgain = true;
      return;
    }
    following = (async () => {
      do {
        lookAgain = false;
        const lib = store;
        if (disposed || lib === null || busy !== null) return;
        if (state.kind !== 'unsure' && state.kind !== 'not-learning' && state.kind !== 'asking') return;
        const identity = await resolveIdentity({ sha256: loaded.sha256, pageCount: open.pageCount, pageTexts: allPageTexts }, lib).catch((): IdentityResult => ({ kind: 'unknown' }));
        // The state may have moved while the library was read (this tab saved, or the owner answered).
        if (identity.kind !== 'known' || disposed || (state as SaveState).kind === 'saved') continue;
        await dispatch({ type: 'identified', documentId: identity.documentId });
      } while (lookAgain);
    })().finally(() => {
      following = null;
    });
  }

  async function begin(): Promise<void> {
    if (d.incognito) return dispatch({ type: 'incognito' });
    [store, blobs] = await Promise.all([d.store, Promise.resolve(d.blobs).catch(() => null)]);
    if (store === null) {
      // No library in this tab: notes are kept until the tab closes.
      set({ kind: 'memory-only' });
      return;
    }
    if (!disposed) stopFollowing = store.onChange(onLibraryChange);
    if (!disposed && typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(SAVE_CHANNEL);
        channel.onmessage = onMoreContent;
      } catch {
        channel = null;
      }
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
      await recordKnownOpen(store, documentId);
      await dispatch({ type: 'identified', documentId });
      await readTrashed(store, documentId);
      return;
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
    get failed() {
      return failed && state.kind !== 'saved';
    },
    documentId: () => (state.kind === 'saved' ? state.documentId : null),
    get trashed() {
      return state.kind === 'saved' && trashed;
    },
    async restoreFromTrash() {
      if (store === null || state.kind !== 'saved') return;
      const id = state.documentId;
      await store.restoreDocument(id);
      await readTrashed(store, id);
    },
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
    async firstMark(o) {
      // R67 (c, f): a note's save, or one with more than the first mark already made, gets no Undo.
      const undoable = o?.undoable !== false;
      moreHere = false;
      byNote = !undoable;
      tellOthers(); // for the other tabs this mark or note is more than their first mark
      await afterStart();
      await dispatch({ type: 'first-mark', ...(undoable ? {} : { undoable: false }) });
    },
    endUndo() {
      if (disposed) return;
      const tell = state.kind === 'saved' || busy?.kind === 'save';
      endUndoHere();
      if (tell) tellOthers();
    },
    async withdraw() {
      // R67 (b): the note that saved the PDF was emptied and closed before anything else was made, in any tab.
      if (busy?.kind === 'save') await busy.done.catch(() => {});
      if (disposed || !byNote || !createdHere || moreHere || othersAdded || state.kind !== 'saved') return;
      byNote = false;
      await run({ kind: 'forget' }, 'owner');
    },
    async resumeSave(undoable) {
      await afterStart();
      if (!undoable) byNote = false;
      await dispatch({ type: 'resume-save', undoable });
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
      stopFollowing?.();
      channel?.close();
      channel = null;
      stopUndoTimer();
      listeners.clear();
      failureListeners.clear();
    },
  };
}
