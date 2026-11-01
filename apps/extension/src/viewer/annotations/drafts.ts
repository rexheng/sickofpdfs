// No lost text (contracts §3). Whatever is typed into a note box is written to the store as a draft, so a crash, a closed
// tab or a reload brings it back. A draft belongs to the tab that started it. It never syncs and is never searched.
//
// When it is saved:
// - DRAFT_DELAY_MS after the last change. The contract allows 300 ms, but the crash gate kills the tab 100 ms after the
//   last key, and the write itself takes time, so the wait is short. Writes that arrive faster are joined into one.
// - never later than DRAFT_MAX_MS after the first unsaved change, however fast the typing is;
// - at once on `flush()` (the note box calls it on blur and Esc), on `visibilitychange` to hidden, on `pagehide` and on
//   `freeze`. These start the write in the same call, because the page may be gone a moment later.
//
// A write that fails stays in memory and is tried again. Nothing the person typed is ever dropped by a failed write.
// On a memory-only PDF nothing is written; the drafts live here until the save decision, then `flush()` writes them.

import type { CommentId, CommentRow, DocumentId, TabId, ThreadId, ThreadRow } from '@sop/core';
import type { AnnotationErrorCode, AnnotationsApi, EditDraft } from '../../store/annotations';
import type { TabPresence } from './tab-presence';

/**
 * The part of the store this file uses. A full `StoreApi` or `StoreClient` fits it; a store that lacks one of these methods
 * is a compile error. (The unit tests' doubles are cast, and `restore` and `drop` still cope with a missing method at run
 * time, so one missing method cannot lose the other drafts.)
 */
export type DraftStore = Pick<
  AnnotationsApi,
  | 'saveDraft'
  | 'listDrafts'
  | 'claimDrafts'
  | 'listDraftThreads'
  | 'discardDraft'
  | 'saveEditDraft'
  | 'listEditDrafts'
  | 'claimEditDrafts'
  | 'discardEditDraft'
>;

export interface DraftKeeper {
  /** Remember the newest text of a draft and save it soon. `thread` is the new thread of a new note, until it is saved. */
  change(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): void;
  /** Write every unsaved draft and edit now. Rejects if one could not be written; the text is still held and tried again. */
  flush(): Promise<void>;
  /** Forget a draft and delete it from the store. A comment that was already sent is never touched. */
  drop(id: CommentId): void;
  /**
   * Adopt the drafts (and unsent edits) of tabs that are gone. Returns every new-note draft of this document that this tab
   * now owns; the unsent edits are read with `editDrafts` afterwards.
   */
  restore(documentId: DocumentId): Promise<CommentRow[]>;
  /** The new thread of a restored or changed draft, so its card can sit at the right place. */
  draftThread(threadId: ThreadId): ThreadRow | undefined;
  /**
   * R54: the person is editing a comment that was already sent. `comment` is the sent comment as it is now (its live text is
   * not touched), `body` the text in the editor. Saved like a draft: 5 ms after the last change, at once on `flush()` and when
   * the page is hidden. The first call starts an edit session; later calls continue it.
   */
  changeEdit(comment: CommentRow, body: string): void;
  /**
   * R54: the edit is over, sent or cancelled. Forget it and close it in the store, so a save that is still on its way is
   * refused and the edit cannot come back. Call it after the live text was written (that write closes the edit too) and on cancel.
   */
  dropEdit(commentId: CommentId): void;
  /** R54: the unsent edits of this document that this tab holds (restored by `restore`, or typed here). */
  editDrafts(documentId: DocumentId): EditDraft[];
  /** Stop listening to the page and clear timers. Does not write; call `flush()` first if that is wanted. */
  dispose(): void;
}

export const DRAFT_DELAY_MS = 5;
export const DRAFT_MAX_MS = 300;
const RETRY_MS = [500, 1000, 2000, 4000, 5000];

/** Failures that trying again cannot fix. The names are the store's `AnnotationErrorCode`s. */
const PERMANENT: AnnotationErrorCode[] = [
  'read-only',
  'bad-row',
  'not-found',
  'not-a-draft',
  'draft-owned-elsewhere',
  'use-save-draft',
  'document-missing',
  'thread-missing',
  'immutable-field',
  'edit-closed',
  'edit-in-progress',
];
const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '');
const isPermanent = (e: unknown): boolean => PERMANENT.some((code) => errorText(e).includes(`${code}: `));

type Draft = CommentRow & { draftOfTab: TabId };

/** What a draft and an edit have in common: the state of the write that is waiting, on its way, or failed. */
interface Slot {
  /** Grows with every change; a write remembers the number it carried. */
  seq: number;
  dirty: boolean;
  firstDirtyAt: number | null;
  inflight: Promise<void> | null;
  /** The error of the newest write, while that write has not succeeded. */
  failed: Error | undefined;
}

interface Entry extends Slot {
  row: Draft;
  thread: ThreadRow | undefined;
  /** True once a write that carried the thread has succeeded (or the thread was loaded from the store). */
  threadSaved: boolean;
}

/** An unsent edit of a sent comment. */
interface EditEntry extends Slot {
  commentId: CommentId;
  threadId: ThreadId;
  documentId: DocumentId;
  editId: string;
  body: string;
  updatedAt: number;
}

/** A delete that waits for a write already on its way. `skip` says it is no longer wanted. */
interface Discard {
  id: CommentId;
  after: Promise<void>;
  running: boolean;
  skip(): boolean;
  run(store: DraftStore): Promise<void> | undefined;
}

const newSlot = (): Slot => ({ seq: 0, dirty: false, firstDirtyAt: null, inflight: null, failed: undefined });

export function createDraftKeeper(d: {
  store: DraftStore | null;
  presence: TabPresence;
  memoryOnly(): boolean;
  /** Told about every failed write or delete. `id` is null when a restore step failed. */
  onError?(id: CommentId | null, error: unknown): void;
}): DraftKeeper {
  const entries = new Map<CommentId, Entry>();
  const edits = new Map<CommentId, EditEntry>();
  const threads = new Map<ThreadId, ThreadRow>();
  const discards = new Map<string, Discard>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let disposed = false;

  const usable = (): DraftStore | null => (d.store !== null && !d.memoryOnly() ? d.store : null);
  const report = (id: CommentId | null, error: unknown): void => {
    try {
      d.onError?.(id, error);
    } catch {
      // a broken error handler must not stop a save
    }
  };
  const clear = (t: ReturnType<typeof setTimeout> | null): null => {
    if (t !== null) clearTimeout(t);
    return null;
  };
  const slots = (): Slot[] => [...entries.values(), ...edits.values()];

  function scheduleRetry(): void {
    if (disposed || retryTimer !== null || retries >= RETRY_MS.length) return;
    const wait = RETRY_MS[retries] ?? 5000;
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pump(false);
    }, wait);
  }

  function schedule(): void {
    if (disposed) return;
    timer = clear(timer);
    let oldest = Infinity;
    for (const e of slots()) if (e.dirty && e.firstDirtyAt !== null) oldest = Math.min(oldest, e.firstDirtyAt);
    if (oldest === Infinity) return;
    const wait = Math.max(0, Math.min(DRAFT_DELAY_MS, oldest + DRAFT_MAX_MS - Date.now()));
    timer = setTimeout(() => {
      timer = null;
      void pump(false);
    }, wait);
  }

  /**
   * Sends one slot. `send` is called before this function returns, so it also works inside a `pagehide` handler.
   * `gone` names the store error that means "this is not a draft (or an open edit) any more": the entry is then dropped.
   */
  function launchSlot(
    slot: Slot,
    id: CommentId,
    send: () => Promise<void>,
    o: { gone: AnnotationErrorCode; forget(): void; saved?(): void },
  ): Promise<void> {
    const seq = slot.seq;
    slot.dirty = false;
    slot.firstDirtyAt = null;
    let call: Promise<void>;
    try {
      call = send();
    } catch (err) {
      call = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const mine: Promise<void> = call
      .then(
        () => {
          retries = 0;
          o.saved?.();
          if (slot.seq === seq) slot.failed = undefined;
        },
        (err: unknown) => {
          // Only the newest write decides. If text has changed since, that write is already queued or on its way.
          if (slot.seq !== seq) return;
          if (errorText(err).includes(`${o.gone}: `)) {
            // A late change reached a draft that was already sent (or an edit that was already sent or cancelled). The store
            // kept the sent text and refused the late one, so there is nothing left to keep here.
            o.forget();
            return;
          }
          slot.dirty = true;
          slot.failed = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'the draft could not be saved');
          slot.firstDirtyAt ??= Date.now();
          report(id, err);
          if (!isPermanent(err)) scheduleRetry();
        },
      )
      .finally(() => {
        if (slot.inflight === mine) slot.inflight = null;
        if (slot.dirty && slot.failed === undefined) schedule();
      });
    slot.inflight = mine;
    return mine;
  }

  function launch(store: DraftStore, e: Entry): Promise<void> {
    const thread = e.threadSaved ? undefined : e.thread;
    return launchSlot(e, e.row.id, () => (thread ? store.saveDraft(e.row, thread) : store.saveDraft(e.row)), {
      gone: 'not-a-draft',
      forget: () => {
        if (entries.get(e.row.id) === e) entries.delete(e.row.id);
      },
      saved: () => {
        if (thread && e.thread === thread) e.threadSaved = true;
      },
    });
  }

  function launchEdit(store: DraftStore, x: EditEntry): Promise<void> {
    return launchSlot(x, x.commentId, () => store.saveEditDraft({ commentId: x.commentId, editId: x.editId, draftOfTab: d.presence.tabId, body: x.body }), {
      gone: 'edit-closed',
      forget: () => {
        if (edits.get(x.commentId) === x) edits.delete(x.commentId);
      },
    });
  }

  function runDiscards(store: DraftStore): void {
    for (const [key, rec] of discards) {
      if (rec.running) continue;
      rec.running = true;
      void rec.after
        // If the same draft was started again meanwhile, its own save replaces the old row; deleting now would delete the new text.
        .then(() => (rec.skip() ? undefined : rec.run(store)))
        .then(
          () => {
            discards.delete(key);
          },
          (err: unknown) => {
            rec.running = false;
            rec.after = Promise.resolve();
            report(rec.id, err);
            if (isPermanent(err)) discards.delete(key);
            else scheduleRetry();
          },
        );
    }
  }

  /** `urgent` writes even a slot that already has a write in flight (the page may be about to go). */
  function pump(urgent: boolean): Promise<void> {
    const store = usable();
    if (!store) return Promise.resolve();
    const waits: Promise<void>[] = [];
    for (const e of entries.values()) {
      if (e.dirty && (urgent || !e.inflight)) waits.push(launch(store, e));
      else if (e.inflight) waits.push(e.inflight);
    }
    for (const x of edits.values()) {
      if (x.dirty && (urgent || !x.inflight)) waits.push(launchEdit(store, x));
      else if (x.inflight) waits.push(x.inflight);
    }
    runDiscards(store);
    return Promise.all(waits).then(() => undefined);
  }

  function flush(): Promise<void> {
    if (disposed) return Promise.resolve();
    timer = clear(timer);
    return pump(true).then(() => {
      for (const e of slots()) if (e.dirty && e.failed !== undefined) throw e.failed;
    });
  }

  const flushQuietly = (): void => {
    flush().catch(() => undefined);
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flushQuietly();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', flushQuietly);
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flushQuietly);

  const byCreated = (a: CommentRow, b: CommentRow): number => a.createdAt - b.createdAt;
  // Sorts by when the session began, so the store can tell a newer session of this tab from an older one.
  const newEditId = (): string => `${Date.now().toString(36).padStart(10, '0')}-${globalThis.crypto.randomUUID()}`;
  const asEditDraft = (x: EditEntry): EditDraft => ({
    commentId: x.commentId,
    threadId: x.threadId,
    documentId: x.documentId,
    editId: x.editId,
    draftOfTab: d.presence.tabId,
    body: x.body,
    updatedAt: x.updatedAt,
  });

  return {
    change(row, thread) {
      if (disposed) return;
      let e = entries.get(row.id);
      if (!e) {
        e = { ...newSlot(), row, thread: undefined, threadSaved: false };
        entries.set(row.id, e);
      }
      // Typing again after a drop starts a new draft with the same id; the delete that was waiting is no longer wanted.
      if (!e.inflight) discards.delete(`c:${row.id}`);
      e.row = row;
      if (thread) {
        e.thread = thread;
        e.threadSaved = false;
        threads.set(thread.id, thread);
      }
      e.seq += 1;
      e.dirty = true;
      e.firstDirtyAt ??= Date.now();
      schedule();
    },

    flush,

    drop(id) {
      const e = entries.get(id);
      entries.delete(id);
      if (e?.thread) threads.delete(e.thread.id);
      if (d.store === null || d.memoryOnly()) return; // never stored, so there is nothing to delete
      // The delete waits for a write that is already on its way, so the draft cannot come back after it.
      discards.set(`c:${id}`, {
        id,
        after: e?.inflight ?? Promise.resolve(),
        running: false,
        skip: () => entries.has(id),
        run: (store) => store.discardDraft?.(id),
      });
      const store = usable();
      if (store) runDiscards(store);
    },

    changeEdit(comment, body) {
      if (disposed) return;
      let x = edits.get(comment.id);
      if (!x) {
        x = { ...newSlot(), commentId: comment.id, threadId: comment.threadId, documentId: comment.documentId, editId: newEditId(), body, updatedAt: Date.now() };
        edits.set(comment.id, x);
      }
      x.body = body;
      x.updatedAt = Date.now();
      x.seq += 1;
      x.dirty = true;
      x.firstDirtyAt ??= Date.now();
      schedule();
    },

    dropEdit(commentId) {
      const x = edits.get(commentId);
      if (!x) return;
      edits.delete(commentId);
      if (d.store === null || d.memoryOnly()) return;
      // Closes this edit session in the store, after any save of it that is already on its way. A newer session of the same
      // comment has another edit id and is left alone by the store.
      discards.set(`e:${commentId}:${x.editId}`, {
        id: commentId,
        after: x.inflight ?? Promise.resolve(),
        running: false,
        skip: () => false,
        run: (store) => store.discardEditDraft?.(commentId, x.editId),
      });
      const store = usable();
      if (store) runDiscards(store);
    },

    editDrafts: (documentId) =>
      [...edits.values()]
        .filter((x) => x.documentId === documentId)
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .map(asEditDraft),

    async restore(documentId) {
      const own = (): Draft[] =>
        [...entries.values()]
          .filter((e) => e.row.documentId === documentId)
          .map((e) => e.row)
          .sort(byCreated);
      const store = usable();
      if (!store) return own();

      const live = await d.presence.liveTabs();
      const tabId = d.presence.tabId;
      try {
        await store.claimDrafts(documentId, tabId, live);
      } catch (err) {
        report(null, err); // the drafts that are already ours are still listed below
      }
      const rows = await store.listDrafts(documentId, tabId);
      const stored = typeof store.listDraftThreads === 'function' ? await store.listDraftThreads(documentId, tabId) : [];
      for (const t of stored) if (!threads.has(t.id)) threads.set(t.id, t);
      for (const r of rows) {
        if (entries.has(r.id) || r.draftOfTab === null) continue; // text typed in this tab is newer than what is stored
        entries.set(r.id, { ...newSlot(), row: r as Draft, thread: threads.get(r.threadId), threadSaved: true });
      }

      // R54: the unsent edits of sent notes come back the same way. A failure here must not hide the new-note drafts above.
      try {
        if (typeof store.claimEditDrafts === 'function' && typeof store.listEditDrafts === 'function') {
          await store.claimEditDrafts(documentId, tabId, live);
          for (const e of await store.listEditDrafts(documentId, tabId)) {
            if (edits.has(e.commentId)) continue; // text typed in this tab is newer than what is stored
            edits.set(e.commentId, { ...newSlot(), commentId: e.commentId, threadId: e.threadId, documentId: e.documentId, editId: e.editId, body: e.body, updatedAt: e.updatedAt });
          }
        }
      } catch (err) {
        report(null, err);
      }
      return own();
    },

    draftThread: (threadId) => threads.get(threadId),

    dispose() {
      disposed = true;
      timer = clear(timer);
      retryTimer = clear(retryTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
        document.removeEventListener('freeze', flushQuietly);
      }
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', flushQuietly);
    },
  };
}
