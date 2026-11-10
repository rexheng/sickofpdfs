// R108: the open document's page order. The thumbnails move pages (drag, Alt+Up and Alt+Down), Ctrl+Z and Ctrl+Y undo
// and redo a move, and "Reset page order" puts the file's own order back. The order is the view store's `pageOrder`, so
// the page list and the thumbnails follow it at once; nothing is drawn again.
//
// Where it is kept:
// - A saved reading keeps its order in the library's settings, `pageOrder.of.<sha>` (@sop/core/page-order). Settings
//   rows go into backups and sync like any other row, so no schema change was needed; Forget, an Undo of a save and the
//   Trash purge delete the row with the reading (store/page-order-rows.ts).
// - A PDF that is not saved (not sure, not learning, kept in memory, Incognito) keeps it in this tab only: nothing is
//   written. If it is saved later in this tab, the order the owner made is written then.
// - Another tab that changes the order of the same reading is followed.
import { type DocumentId, type PageOrder, cleanPageOrder, movePages, nudgePages, pageOrderKey, samePageOrder } from '@sop/core';
import type { SaveController, ViewerStore } from '@sop/viewer';
import type { StoreClient } from '../../store/client';
import { recordEdit, tookUndo } from './edit-journal';

export interface PageOrderDeps {
  store: ViewerStore;
  pageCount: number;
  /** The library store once connected; null in Incognito or when it could not be reached. */
  library: () => Promise<Pick<StoreClient, 'getSetting' | 'setSetting' | 'onChange'> | null>;
  /** A short note for the owner ("Page moved", with Undo). */
  showNote(text: string, action?: { label: string; run: () => void }): void;
}

export interface PageOrderController {
  /** The order shown now (null: the file's own). */
  order(): PageOrder;
  /** Moves `pages` (original indices) together to just before position `before`. False when nothing changed. */
  move(pages: readonly number[], before: number): boolean;
  /** Moves `pages` one place up or down. False when nothing changed (already at the start or the end). */
  nudge(pages: readonly number[], dir: -1 | 1): boolean;
  /** The file's own order again. */
  reset(): boolean;
  /** Undoes the last move in this tab. False when there was none. */
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * The library save of the open PDF (it is made once the PDF is open). While it says "saved", the order is kept with
   * the reading. Returns what lets go of it.
   */
  attachSave(save: Pick<SaveController, 'state' | 'subscribe'> | null): () => void;
  dispose(): void;
}

/** How many moves this tab can undo. */
const UNDO_LIMIT = 100;

const MOVED_NOTE = (n: number): string => (n === 1 ? 'Page moved' : `${n} pages moved`);
/** Said once in a tab whose PDF is not saved: the order will not be kept. */
const TAB_ONLY_NOTE = (n: number): string => `${MOVED_NOTE(n)}. This order lasts until you close this tab, because this PDF isn’t saved.`;
const RESET_NOTE = 'Pages are back in their first order';
const NOT_KEPT_NOTE = 'Couldn’t keep the new page order. It lasts until you close this tab.';

export function createPageOrderController(d: PageOrderDeps): PageOrderController {
  const past: PageOrder[] = [];
  const future: PageOrder[] = [];
  let disposed = false;
  /** The reading the order is kept for, while the PDF is saved. */
  let keptFor: DocumentId | null = null;
  /** The owner moved pages in this tab: a stored order must not replace theirs. */
  let touched = false;
  /** Bumped by every move here, so a read that was under way when the owner moved a page is dropped. */
  let localVersion = 0;
  let saidTabOnly = false;
  /** Writes in flight, so a change notice for our own write is not read back as another tab's. */
  let writing = 0;
  let stopWatching: (() => void) | null = null;
  let save: Pick<SaveController, 'state' | 'subscribe'> | null = null;

  const current = (): PageOrder => d.store.get().pageOrder;
  const apply = (next: PageOrder) => d.store.set({ pageOrder: next });
  const savedId = (): DocumentId | null => (save?.state.kind === 'saved' ? save.state.documentId : null);

  async function write(id: DocumentId, order: PageOrder): Promise<void> {
    const lib = await d.library();
    if (lib === null || disposed || keptFor !== id) return;
    writing++;
    try {
      await lib.setSetting(pageOrderKey(id), order === null ? null : [...order]);
    } catch {
      d.showNote(NOT_KEPT_NOTE);
    } finally {
      writing--;
    }
  }

  /** Reads the stored order (another tab's, or the one from the last visit) unless the owner has moved pages here. */
  async function read(id: DocumentId): Promise<void> {
    const v = localVersion;
    const lib = await d.library();
    if (lib === null || disposed || keptFor !== id) return;
    let stored: unknown;
    try {
      stored = await lib.getSetting(pageOrderKey(id));
    } catch {
      return; // the file's own order until the next change
    }
    if (disposed || keptFor !== id || writing > 0 || v !== localVersion) return;
    const next = cleanPageOrder(stored, d.pageCount);
    if (!samePageOrder(next, current())) apply(next);
  }

  async function watch(id: DocumentId): Promise<void> {
    const lib = await d.library();
    if (lib === null || disposed || keptFor !== id) return;
    const key = pageOrderKey(id);
    stopWatching?.();
    stopWatching = lib.onChange((c) => {
      if (c.table !== 'settings' || !c.ids.includes(key) || writing > 0) return;
      void read(id);
    });
  }

  /** The save state changed: a reading that is saved now keeps its order (the owner's from this tab, or the stored one). */
  function onSave(): void {
    const id = savedId();
    if (id === keptFor) return;
    keptFor = id;
    stopWatching?.();
    stopWatching = null;
    if (id === null) return;
    void watch(id);
    if (touched) void write(id, current());
    else void read(id);
  }

  /** The snackbar's Undo: the same as Ctrl+Z on this move, and the tab's undo journal is told. */
  const undoFromNote = () => {
    if (undo()) tookUndo('pages');
  };

  /** `note`: what to say (and how many pages moved), or null to say nothing (Alt+Up and Alt+Down: the move is in view). */
  function change(next: PageOrder, note: { said: string; count: number } | null): boolean {
    if (disposed) return false;
    const was = current();
    if (samePageOrder(next, was)) return false;
    past.push(was);
    if (past.length > UNDO_LIMIT) past.shift();
    future.length = 0;
    touched = true;
    localVersion++;
    apply(next);
    recordEdit('pages');
    const id = savedId();
    if (id !== null && keptFor === id) void write(id, next);
    if (note !== null) {
      // Once in a tab whose PDF is not saved: the new order is not kept.
      const tabOnly = id === null && !saidTabOnly && next !== null;
      if (tabOnly) saidTabOnly = true;
      d.showNote(tabOnly ? TAB_ONLY_NOTE(note.count) : note.said, { label: 'Undo', run: undoFromNote });
    }
    return true;
  }

  function step(from: PageOrder[], to: PageOrder[]): boolean {
    if (disposed || from.length === 0) return false;
    const next = from.pop()!;
    to.push(current());
    touched = true;
    localVersion++;
    apply(next);
    const id = savedId();
    if (id !== null && keptFor === id) void write(id, next);
    return true;
  }

  const undo = () => step(past, future);
  const redo = () => step(future, past);

  let offSave: (() => void) | null = null;

  return {
    order: current,
    move: (pages, before) => {
      const count = new Set(pages).size;
      return change(movePages(current(), d.pageCount, pages, before), { said: MOVED_NOTE(count), count });
    },
    nudge: (pages, dir) => change(nudgePages(current(), d.pageCount, pages, dir), null),
    reset: () => change(null, { said: RESET_NOTE, count: 0 }),
    undo,
    redo,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    attachSave(next) {
      offSave?.();
      save = next;
      offSave = next?.subscribe(onSave) ?? null;
      onSave();
      const mine = offSave;
      return () => {
        if (offSave !== mine) return;
        offSave?.();
        offSave = null;
        save = null;
        onSave();
      };
    },
    dispose() {
      disposed = true;
      offSave?.();
      stopWatching?.();
    },
  };
}
