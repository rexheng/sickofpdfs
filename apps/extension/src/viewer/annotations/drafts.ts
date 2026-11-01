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
import type { AnnotationErrorCode, AnnotationsApi } from '../../store/annotations';
import type { TabPresence } from './tab-presence';

/** The part of the store this file uses. A full `StoreApi` or `StoreClient` fits; a test double needs only these. */
export type DraftStore = Pick<AnnotationsApi, 'saveDraft' | 'listDrafts' | 'claimDrafts'> & Partial<Pick<AnnotationsApi, 'listDraftThreads' | 'discardDraft'>>;

export interface DraftKeeper {
  /** Remember the newest text of a draft and save it soon. `thread` is the new thread of a new note, until it is saved. */
  change(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): void;
  /** Write every unsaved draft now. Rejects if a draft could not be written; the text is still held and tried again. */
  flush(): Promise<void>;
  /** Forget a draft and delete it from the store. A comment that was already sent is never touched. */
  drop(id: CommentId): void;
  /** Adopt the drafts of tabs that are gone, and return every draft of this document that this tab now owns. */
  restore(documentId: DocumentId): Promise<CommentRow[]>;
  /** The new thread of a restored or changed draft, so its card can sit at the right place. */
  draftThread(threadId: ThreadId): ThreadRow | undefined;
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
  'not-a-draft',
  'draft-owned-elsewhere',
  'use-save-draft',
  'document-missing',
  'thread-missing',
  'immutable-field',
];
const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : '');
const isPermanent = (e: unknown): boolean => PERMANENT.some((code) => errorText(e).includes(`${code}: `));

type Draft = CommentRow & { draftOfTab: TabId };

interface Entry {
  row: Draft;
  thread: ThreadRow | undefined;
  /** True once a write that carried the thread has succeeded (or the thread was loaded from the store). */
  threadSaved: boolean;
  /** Grows with every change; a write remembers the number it carried. */
  seq: number;
  dirty: boolean;
  firstDirtyAt: number | null;
  inflight: Promise<void> | null;
  /** The error of the newest write, while that write has not succeeded. */
  failed: Error | undefined;
}

export function createDraftKeeper(d: {
  store: DraftStore | null;
  presence: TabPresence;
  memoryOnly(): boolean;
  /** Told about every failed write or delete. `id` is null when a restore step failed. */
  onError?(id: CommentId | null, error: unknown): void;
}): DraftKeeper {
  const entries = new Map<CommentId, Entry>();
  const threads = new Map<ThreadId, ThreadRow>();
  const discards = new Map<CommentId, { after: Promise<void>; running: boolean }>();
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
    for (const e of entries.values()) if (e.dirty && e.firstDirtyAt !== null) oldest = Math.min(oldest, e.firstDirtyAt);
    if (oldest === Infinity) return;
    const wait = Math.max(0, Math.min(DRAFT_DELAY_MS, oldest + DRAFT_MAX_MS - Date.now()));
    timer = setTimeout(() => {
      timer = null;
      void pump(false);
    }, wait);
  }

  /** Sends one draft. The store call is made before this function returns, so it also works inside a `pagehide` handler. */
  function launch(store: DraftStore, e: Entry): Promise<void> {
    const seq = e.seq;
    const thread = e.threadSaved ? undefined : e.thread;
    e.dirty = false;
    e.firstDirtyAt = null;
    let call: Promise<void>;
    try {
      call = thread ? store.saveDraft(e.row, thread) : store.saveDraft(e.row);
    } catch (err) {
      call = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const mine: Promise<void> = call
      .then(
        () => {
          retries = 0;
          if (thread && e.thread === thread) e.threadSaved = true;
          if (e.seq === seq) e.failed = undefined;
        },
        (err: unknown) => {
          // Only the newest write decides. If text has changed since, that write is already queued or on its way.
          if (e.seq !== seq) return;
          if (errorText(err).includes('not-a-draft: ')) {
            // The comment was sent (or sent from another place) while a late change was on its way. The sent text is safe in the
            // store and the store refused to replace it, so there is no draft left to keep.
            if (entries.get(e.row.id) === e) entries.delete(e.row.id);
            return;
          }
          e.dirty = true;
          e.failed = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'the draft could not be saved');
          e.firstDirtyAt ??= Date.now();
          report(e.row.id, err);
          if (!isPermanent(err)) scheduleRetry();
        },
      )
      .finally(() => {
        if (e.inflight === mine) e.inflight = null;
        if (e.dirty && e.failed === undefined) schedule();
      });
    e.inflight = mine;
    return mine;
  }

  function runDiscards(store: DraftStore): void {
    for (const [id, rec] of discards) {
      if (rec.running) continue;
      if (!store.discardDraft) {
        discards.delete(id);
        continue;
      }
      rec.running = true;
      const discard = store.discardDraft.bind(store);
      void rec.after
        // If the same id was started again meanwhile, its own save replaces the old row; deleting now would delete the new text.
        .then(() => (entries.has(id) ? undefined : discard(id)))
        .then(
          () => {
            discards.delete(id);
          },
          (err: unknown) => {
            rec.running = false;
            rec.after = Promise.resolve();
            report(id, err);
            if (isPermanent(err)) discards.delete(id);
            else scheduleRetry();
          },
        );
    }
  }

  /** `urgent` writes even a draft that already has a write in flight (the page may be about to go). */
  function pump(urgent: boolean): Promise<void> {
    const store = usable();
    if (!store) return Promise.resolve();
    const waits: Promise<void>[] = [];
    for (const e of entries.values()) {
      if (e.dirty && (urgent || !e.inflight)) waits.push(launch(store, e));
      else if (e.inflight) waits.push(e.inflight);
    }
    runDiscards(store);
    return Promise.all(waits).then(() => undefined);
  }

  function flush(): Promise<void> {
    if (disposed) return Promise.resolve();
    timer = clear(timer);
    return pump(true).then(() => {
      for (const e of entries.values()) if (e.dirty && e.failed !== undefined) throw e.failed;
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

  return {
    change(row, thread) {
      if (disposed) return;
      let e = entries.get(row.id);
      if (!e) {
        e = { row, thread: undefined, threadSaved: false, seq: 0, dirty: false, firstDirtyAt: null, inflight: null, failed: undefined };
        entries.set(row.id, e);
      }
      // Typing again after a drop starts a new draft with the same id; the delete that was waiting is no longer wanted.
      if (!e.inflight) discards.delete(row.id);
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
      discards.set(id, { after: e?.inflight ?? Promise.resolve(), running: false });
      const store = usable();
      if (store) runDiscards(store);
    },

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
      const stored = store.listDraftThreads ? await store.listDraftThreads(documentId, tabId) : [];
      for (const t of stored) if (!threads.has(t.id)) threads.set(t.id, t);
      for (const r of rows) {
        if (entries.has(r.id) || r.draftOfTab === null) continue; // text typed in this tab is newer than what is stored
        entries.set(r.id, {
          row: r as Draft,
          thread: threads.get(r.threadId),
          threadSaved: true,
          seq: 0,
          dirty: false,
          firstDirtyAt: null,
          inflight: null,
          failed: undefined,
        });
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
