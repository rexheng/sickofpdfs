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
//
// The journal (draft-journal.ts). The store lives in the offscreen document, which shares the viewer tabs' renderer process,
// so a renderer crash kills the store too and a store write that was on its way is lost. So every change is also written,
// synchronously, to the journal in the extension's localStorage, which the browser process keeps. `restore` reads both: a
// journal text the store has not confirmed is newer and wins. The journal follows the store's rules: nothing for a PDF that
// is not saved, an entry per draft, gone once the draft is sent or discarded and the store has confirmed it. One exception
// (TB4 ruling, Forget wins): an unsent note a tab still holds when another tab forgets the PDF is kept here (`keepUnsaved`).
// After a Forget with "Never save this file" (TB5 ruling) it is kept privately: set aside with its words only (no file
// fingerprint, no quote), under a random id, held by this tab until the tab goes; then it is a recovered note.
// R101: a journal draft older than the note it was for never overwrites the note. It is set aside as a recovered note instead.

import type { CommentId, CommentRow, DocumentId, TabId, ThreadId, ThreadRow } from '@sop/core';
import type { AnnotationErrorCode, AnnotationsApi, EditDraft } from '../../store/annotations';
import { type DraftJournal, type JournalCommentEntry, type JournalEditEntry, noteIsNewer } from './draft-journal';
import type { TabPresence } from './tab-presence';

/**
 * The part of the store this file uses. A full `StoreApi` or `StoreClient` fits it; a store that lacks one of these methods
 * is a compile error. (The unit tests' doubles are cast, and `restore` and `drop` still cope with a missing method at run
 * time, so one missing method cannot lose the other drafts.)
 */
export type DraftStore = Pick<
  AnnotationsApi,
  | 'listAnnotations'
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
   * The store has confirmed comment `id` as a sent row (or deleted it): its draft is over. Forgets the draft here and its
   * journal entry, and never touches the store. Optional, so a keeper without a journal need not have it.
   */
  sent?(id: CommentId): void;
  /**
   * TB4 ruling (Forget wins, no lost text): the owner forgot this PDF in another tab while this tab held this unsent note.
   * The note stays in this tab, and its text is kept in the journal only (the store has no document for it now), so a crash
   * loses nothing. Never written to the store; `change` takes over once the PDF is saved again, `drop` removes it. Optional,
   * so a keeper without a journal need not have it.
   * `private` (TB5 ruling): the owner forgot it with "Never save this file". Only the words are kept, set aside under a random
   * id with no file fingerprint and no quote of the PDF, held by this tab; once the tab has gone they are a recovered note.
   */
  keepUnsaved?(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow, o?: { private?: boolean }): void;
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
  /**
   * R54: the edit was sent, and its live write is on its way. The keeper keeps this text (a crash before the write lands
   * brings it back), and the next `changeEdit` of the comment begins a new edit session. That session's text is kept in
   * the journal at once, but only reaches the store after `dropEdit`, because the live write closes whatever edit of this
   * tab is open. Optional, so a keeper without it still compiles.
   */
  sentEdit?(commentId: CommentId): void;
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
  /** For the journal: the `seq` the store last confirmed (0 when nothing typed here was confirmed yet). */
  confirmedSeq: number;
  /** For the journal: true once the store has confirmed any write of this draft, or the draft came from the store. */
  confirmed: boolean;
  /** For the journal: the `seq` last written to it (-1: never). */
  journaledSeq: number;
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
  /** The edit was sent (`sentEdit`); its live write has not been confirmed by `dropEdit` yet. */
  sent?: boolean;
  /** A new session begun while the last one's live write was on its way: journaled, not sent to the store until `dropEdit`. */
  held?: boolean;
}

/** A delete that waits for a write already on its way. `skip` says it is no longer wanted. */
interface Discard {
  id: CommentId;
  after: Promise<void>;
  running: boolean;
  skip(): boolean;
  run(store: DraftStore): Promise<void> | undefined;
  /** After the store confirmed the delete (or it was skipped): the journal entry can go. */
  done?(): void;
}

const newSlot = (): Slot => ({ seq: 0, dirty: false, firstDirtyAt: null, inflight: null, failed: undefined, confirmedSeq: 0, confirmed: false, journaledSeq: -1 });

/** This page's life: notes set aside and held by this tab in an earlier life of it (before a reload) are its no more. */
const PAGE_LIFE = globalThis.crypto.randomUUID();

export function createDraftKeeper(d: {
  store: DraftStore | null;
  presence: TabPresence;
  memoryOnly(): boolean;
  /** Told about every failed write or delete. `id` is null when a restore step failed. */
  onError?(id: CommentId | null, error: unknown): void;
  /** The crash-safe copy of every draft (draft-journal.ts). The viewer passes `localDraftJournal()`; none in tests. */
  journal?: DraftJournal | null;
}): DraftKeeper {
  const entries = new Map<CommentId, Entry>();
  const edits = new Map<CommentId, EditEntry>();
  /** R54: edits that were sent, whose live write `dropEdit` has not confirmed yet, while a newer session of them is open. */
  const sentEdits = new Map<CommentId, EditEntry>();
  const journal = d.journal ?? null;
  const threads = new Map<ThreadId, ThreadRow>();
  const discards = new Map<string, Discard>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let disposed = false;

  /** Notes held privately after a Forget with "Never save this file": the random id each one's words are set aside under. */
  const asideIds = new Map<CommentId, string>();
  /** The note is sent, dropped, or the keeper has it again: its private copy goes. */
  const dropAside = (id: CommentId): void => {
    const aside = asideIds.get(id);
    if (aside === undefined) return;
    asideIds.delete(id);
    journal?.removeAside?.(aside);
  };
  /** Words set aside from the journal for "Recovered notes" (R101): an entry older than the note it was for. */
  const setAside = (j: { kind: 'comment' | 'edit'; commentId: CommentId; body: string; at: number }, key: string): boolean => {
    if (journal?.keepAside === undefined) return false;
    if (j.body.trim() !== '' && !journal.keepAside(`${j.commentId}.${key}`, { kind: j.kind, body: j.body, at: j.at })) return false; // kept where it is
    journal.remove(j.kind, j.commentId);
    return true;
  };
  // A reload of this tab: what its earlier page held privately shows under "Recovered notes" now (that page is gone).
  journal?.releaseAside?.(d.presence.tabId, PAGE_LIFE);

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

  // ---- the journal (draft-journal.ts). It is written whenever the store would take the draft, and only then.

  /** Writes a draft's newest text to the journal. The whole row goes too until the store has confirmed it. */
  function journalDraft(e: Entry): void {
    if (!journal || !usable()) return;
    const unsavedThread = e.thread !== undefined && !e.threadSaved ? e.thread : undefined;
    const whole = !e.confirmed || unsavedThread !== undefined;
    const entry: JournalCommentEntry = {
      v: 1,
      kind: 'comment',
      documentId: e.row.documentId,
      commentId: e.row.id,
      threadId: e.row.threadId,
      tab: d.presence.tabId,
      body: e.row.body,
      at: Date.now(),
      pending: e.confirmedSeq !== e.seq,
      ...(whole ? { row: e.row } : {}),
      ...(whole && unsavedThread ? { thread: unsavedThread } : {}),
    };
    journal.put(entry);
    e.journaledSeq = e.seq;
  }

  function journalEdit(x: EditEntry): void {
    if (!journal || !usable()) return;
    const entry: JournalEditEntry = {
      v: 1,
      kind: 'edit',
      documentId: x.documentId,
      commentId: x.commentId,
      threadId: x.threadId,
      editId: x.editId,
      tab: d.presence.tabId,
      body: x.body,
      at: x.updatedAt,
      pending: x.confirmedSeq !== x.seq,
    };
    journal.put(entry);
    x.journaledSeq = x.seq;
  }

  /** The draft is over: the entry says so at once, and goes once the store has confirmed the delete. */
  function closeInJournal(kind: 'comment' | 'edit', id: CommentId): void {
    const j = journal?.get(kind, id);
    if (j && j.tab === d.presence.tabId) journal!.put({ ...j, closing: true });
  }

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
    o: { gone: AnnotationErrorCode; forget(): void; saved?(seq: number): void; lost?(): void },
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
          o.saved?.(seq);
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
          // The store has no such document any more (it was forgotten): the text stays in memory, but not in the journal.
          if (errorText(err).includes('document-missing: ')) o.lost?.();
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
        if (entries.get(e.row.id) !== e) return;
        entries.delete(e.row.id);
        journal?.remove('comment', e.row.id);
      },
      saved: (seq) => {
        if (thread && e.thread === thread) e.threadSaved = true;
        e.confirmed = true;
        e.confirmedSeq = Math.max(e.confirmedSeq, seq);
        if (entries.get(e.row.id) === e) journalDraft(e);
      },
      lost: () => journal?.remove('comment', e.row.id),
    });
  }

  function launchEdit(store: DraftStore, x: EditEntry): Promise<void> {
    return launchSlot(x, x.commentId, () => store.saveEditDraft({ commentId: x.commentId, editId: x.editId, draftOfTab: d.presence.tabId, body: x.body }), {
      gone: 'edit-closed',
      forget: () => {
        if (edits.get(x.commentId) !== x) return;
        edits.delete(x.commentId);
        journal?.remove('edit', x.commentId);
      },
      saved: (seq) => {
        x.confirmed = true;
        x.confirmedSeq = Math.max(x.confirmedSeq, seq);
        if (edits.get(x.commentId) === x) journalEdit(x);
      },
      lost: () => journal?.remove('edit', x.commentId),
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
            rec.done?.();
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
      if (e.dirty && e.journaledSeq !== e.seq) journalDraft(e);
      if (e.dirty && (urgent || !e.inflight)) waits.push(launch(store, e));
      else if (e.inflight) waits.push(e.inflight);
    }
    for (const x of edits.values()) {
      if (x.dirty && x.journaledSeq !== x.seq) journalEdit(x);
      if (x.held) continue; // waits for the live write of the edit before it (sentEdit)
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

  /** Marks a slot as changed here, so the keeper writes it to the store (and the journal) soon. */
  function touch(slot: Slot): void {
    slot.seq += 1;
    slot.dirty = true;
    slot.firstDirtyAt ??= Date.now();
  }

  /**
   * The second half of `restore`: what the journal holds that the store does not. Runs after the store's own drafts (and
   * edits) of tabs that are gone were claimed and loaded. For each journal entry of this document:
   * - a draft of a tab that is alive is not ours: left alone;
   * - a draft that was being sent or cancelled when its tab went is finished: the store's delete is asked for again;
   * - a text the store has not confirmed (`pending`) is newer than the store's: it wins, and is written to the store;
   * - a text the store confirmed is already there (or was sent or deleted since): the store's row stands;
   * - R66: an entry whose comment the store already has as a sent row with the same text (the tab went between the store
   *   confirming the send and `sent()`; for an edit, between the live text being written and `dropEdit()`) is dropped without
   *   being shown. A text that differs from the sent one is never dropped;
   * - every entry this tab adopts names this tab as its owner from now on.
   */
  function fromJournal(
    documentId: DocumentId,
    live: Set<TabId>,
    storeDrafts: Set<CommentId>,
    storeEdits: EditDraft[] | null,
    typedHere: Set<CommentId>,
    editedHere: Set<CommentId>,
    sent: ReadonlyMap<CommentId, CommentRow>,
  ): void {
    if (!journal) return;
    const tabId = d.presence.tabId;
    const store = usable();
    let any = false;
    for (const j of journal.list(documentId)) {
      if (j.tab !== tabId && live.has(j.tab)) continue; // another tab is alive and owns it
      if (j.closing) {
        // The draft was over when its tab went. It must not come back: forget what the store gave us of it above, and ask
        // for the delete again (it changes nothing if it already happened, and never touches a sent comment).
        if (j.kind === 'comment' && !typedHere.has(j.commentId)) {
          const e = entries.get(j.commentId);
          entries.delete(j.commentId);
          if (e?.thread) threads.delete(e.thread.id);
        }
        if (j.kind === 'edit' && !editedHere.has(j.commentId)) edits.delete(j.commentId);
        const done = (): void => journal.remove(j.kind, j.commentId);
        const asked = j.kind === 'comment' ? store?.discardDraft?.(j.commentId) : store?.discardEditDraft?.(j.commentId, j.editId);
        if (asked) asked.then(done, (err: unknown) => report(j.commentId, err));
        else done();
        continue;
      }
      if (j.kind === 'comment') {
        if (typedHere.has(j.commentId)) continue;
        const e = entries.get(j.commentId);
        if (e && storeDrafts.has(j.commentId)) {
          if (j.pending && j.body !== e.row.body) {
            e.row = { ...e.row, body: j.body };
            touch(e);
            any = true;
          }
          journalDraft(e); // this tab owns it now
        } else if (sent.get(j.commentId)?.body === j.body) {
          journal.remove('comment', j.commentId); // R66: it was sent after all; this copy is stale
        } else if (j.pending && j.row) {
          // The store never had this draft (the tab went before its first write landed): it comes back from the journal.
          const thread = j.thread ? { ...j.thread, draftOfTab: tabId } : undefined;
          if (thread) threads.set(thread.id, thread);
          const row: Draft = { ...j.row, body: j.body, draftOfTab: tabId };
          const x: Entry = { ...newSlot(), row, thread: thread ?? threads.get(row.threadId), threadSaved: thread === undefined };
          entries.set(row.id, x);
          touch(x);
          journalDraft(x);
          any = true;
        } else {
          journal.remove('comment', j.commentId); // the store has it sent, deleted or forgotten
        }
      } else {
        if (editedHere.has(j.commentId) || storeEdits === null) continue;
        const s = storeEdits.find((e) => e.commentId === j.commentId);
        const x = edits.get(j.commentId);
        if (s && x) {
          // The newer edit session wins; within one session, a text the store has not confirmed is newer.
          const newer = j.editId > s.editId || (j.editId === s.editId && j.body !== s.body);
          if (j.pending && newer) {
            x.editId = j.editId;
            x.body = j.body;
            x.updatedAt = j.at;
            touch(x);
            any = true;
          }
          journalEdit(x);
        } else if (sent.get(j.commentId)?.body === j.body) {
          journal.remove('edit', j.commentId); // R66: the live text is this text, so the edit was applied; this copy is stale
        } else if (j.pending && sent.has(j.commentId) && noteIsNewer(sent.get(j.commentId)!, j.at)) {
          // R101: the note was changed after these words were typed (a restore, another tab). They never replace it: they are
          // set aside for "Recovered notes", and the note keeps its newer words.
          setAside(j, j.editId);
        } else if (j.pending) {
          // Never reached the store. If it was sent or cancelled after all, the store refuses it (edit-closed) and it goes.
          const y: EditEntry = { ...newSlot(), commentId: j.commentId, threadId: j.threadId, documentId: j.documentId, editId: j.editId, body: j.body, updatedAt: j.at };
          edits.set(j.commentId, y);
          touch(y);
          journalEdit(y);
          any = true;
        } else {
          journal.remove('edit', j.commentId);
        }
      }
    }
    if (any) schedule();
  }

  /**
   * R101: an unsent change of a tab that is gone, older than the note itself (the note was changed since, by a restore or another
   * tab), never comes back as the note's editor, where Save or Esc would put the old words over the newer note. Its words (the
   * newer of the store's copy and the journal's) are set aside for "Recovered notes", and its edit session is closed.
   */
  function staleEdits(store: DraftStore, storeEdits: EditDraft[] | null, editedHere: Set<CommentId>, sent: ReadonlyMap<CommentId, CommentRow>): void {
    if (!journal || storeEdits === null) return;
    for (const e of storeEdits) {
      const note = sent.get(e.commentId);
      const x = edits.get(e.commentId);
      if (editedHere.has(e.commentId) || note === undefined || x === undefined || x.editId !== e.editId) continue;
      const j = journal.get('edit', e.commentId);
      const later = j !== null && j.kind === 'edit' && !j.closing && j.pending && (j.editId > e.editId || (j.editId === e.editId && j.body !== e.body)) ? j : null;
      const words = later !== null ? { body: later.body, at: later.at, key: later.editId } : { body: e.body, at: e.updatedAt, key: e.editId };
      if (words.body === note.body || !noteIsNewer(note, words.at)) continue;
      if (!setAside({ kind: 'edit', commentId: e.commentId, body: words.body, at: words.at }, words.key)) continue; // could not be kept aside: left as it was
      edits.delete(e.commentId);
      store.discardEditDraft?.(e.commentId, e.editId).catch((err: unknown) => report(e.commentId, err));
    }
  }

  /**
   * Closes one edit session in the store, after any save of it that is already on its way. A newer session of the same
   * comment has another edit id and is left alone by the store, and keeps its own journal entry.
   */
  function closeSession(x: EditEntry): void {
    const commentId = x.commentId;
    const newer = (): boolean => {
      const now = edits.get(commentId);
      return now !== undefined && now !== x;
    };
    if (d.store === null || d.memoryOnly()) {
      if (!newer()) journal?.remove('edit', commentId);
      return;
    }
    if (!newer()) closeInJournal('edit', commentId);
    discards.set(`e:${commentId}:${x.editId}`, {
      id: commentId,
      after: x.inflight ?? Promise.resolve(),
      running: false,
      skip: () => false,
      run: (store) => store.discardEditDraft?.(commentId, x.editId),
      done: () => {
        if (!edits.has(commentId)) journal?.remove('edit', commentId); // a newer edit of this comment keeps its entry
      },
    });
    const store = usable();
    if (store) runDiscards(store);
  }

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
      // R67: a draft is kept under the library id of its PDF. A row without one could never be restored or stored.
      if (row.documentId === '') {
        report(row.id, new Error('bad-row: a draft needs its document id'));
        return;
      }
      let e = entries.get(row.id);
      if (!e) {
        e = { ...newSlot(), row, thread: undefined, threadSaved: false };
        entries.set(row.id, e);
      }
      // Typing again after a drop starts a new draft with the same id; the delete that was waiting is no longer wanted.
      if (!e.inflight) discards.delete(`c:${row.id}`);
      dropAside(row.id); // the PDF is saved again: the keeper has it, in the store and the journal
      e.row = row;
      if (thread) {
        e.thread = thread;
        e.threadSaved = false;
        threads.set(thread.id, thread);
      }
      e.seq += 1;
      e.dirty = true;
      e.firstDirtyAt ??= Date.now();
      journalDraft(e); // in the same call: the renderer may be gone before the store write lands
      schedule();
    },

    flush,

    drop(id) {
      dropAside(id);
      const e = entries.get(id);
      entries.delete(id);
      if (e?.thread) threads.delete(e.thread.id);
      if (d.store === null || d.memoryOnly()) {
        journal?.remove('comment', id);
        return; // never stored, so there is nothing to delete
      }
      closeInJournal('comment', id);
      // The delete waits for a write that is already on its way, so the draft cannot come back after it.
      discards.set(`c:${id}`, {
        id,
        after: e?.inflight ?? Promise.resolve(),
        running: false,
        skip: () => entries.has(id),
        run: (store) => store.discardDraft?.(id),
        done: () => {
          if (!entries.has(id)) journal?.remove('comment', id); // a draft started again with this id keeps its entry
        },
      });
      const store = usable();
      if (store) runDiscards(store);
    },

    keepUnsaved(row, thread, o) {
      if (disposed || !journal || row.documentId === '') return;
      if (o?.private === true && journal.keepAside !== undefined) {
        // TB5 ruling: no copy that names the file (its fingerprint) or quotes it stays; only the words, under an id of their own.
        let aside = asideIds.get(row.id);
        if (aside === undefined) asideIds.set(row.id, (aside = globalThis.crypto.randomUUID()));
        if (row.body.trim() === '') {
          dropAside(row.id);
          journal.remove('comment', row.id);
          return;
        }
        if (journal.keepAside(aside, { kind: 'comment', body: row.body, at: Date.now(), held: { tab: d.presence.tabId, life: PAGE_LIFE } })) journal.remove('comment', row.id);
        return;
      }
      const entry: JournalCommentEntry = {
        v: 1,
        kind: 'comment',
        documentId: row.documentId,
        commentId: row.id,
        threadId: row.threadId,
        tab: d.presence.tabId,
        body: row.body,
        at: Date.now(),
        pending: true, // the store never confirmed this text
        row,
        ...(thread ? { thread } : {}),
      };
      journal.put(entry);
    },

    sent(id) {
      dropAside(id);
      const e = entries.get(id);
      if (e && !e.dirty && !e.inflight) {
        entries.delete(id);
        if (e.thread) threads.delete(e.thread.id);
      }
      journal?.remove('comment', id);
    },

    changeEdit(comment, body) {
      if (disposed) return;
      if (comment.documentId === '') {
        report(comment.id, new Error('bad-row: an edit needs its document id'));
        return;
      }
      let x = edits.get(comment.id);
      if (x?.sent) {
        // The last edit was sent and its write is on its way: this is a new session (R54). The old one stays until
        // `dropEdit`, so its delete still runs then.
        sentEdits.set(comment.id, x);
        x = undefined;
      }
      if (!x) {
        const held = sentEdits.has(comment.id);
        x = { ...newSlot(), commentId: comment.id, threadId: comment.threadId, documentId: comment.documentId, editId: newEditId(), body, updatedAt: Date.now(), ...(held ? { held } : {}) };
        edits.set(comment.id, x);
      }
      x.body = body;
      x.updatedAt = Date.now();
      x.seq += 1;
      x.dirty = true;
      x.firstDirtyAt ??= Date.now();
      journalEdit(x);
      schedule();
    },

    sentEdit(commentId) {
      const x = edits.get(commentId);
      if (x) x.sent = true;
    },

    dropEdit(commentId) {
      // The live write of a sent edit has landed. A session begun meanwhile (sentEdit) is let go to the store now; the
      // sent one is closed as before.
      const old = sentEdits.get(commentId);
      if (old) {
        sentEdits.delete(commentId);
        const next = edits.get(commentId);
        if (next?.held) {
          next.held = false;
          if (next.dirty) schedule();
        }
        closeSession(old);
        return;
      }
      const x = edits.get(commentId);
      if (!x) return;
      edits.delete(commentId);
      closeSession(x);
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

      // Under the journal's lock, so that two tabs opening at once never both adopt one draft from the journal.
      const adopt = async (): Promise<void> => {
        // Text typed in this tab is newer than anything stored, so these are left as they are.
        const typedHere = new Set(entries.keys());
        const editedHere = new Set(edits.keys());
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
          // Phase 4: a reply Claude was writing is not a note of the owner's. Claude's turn runner takes it back (reply-rows.ts).
          if (entries.has(r.id) || r.draftOfTab === null || r.author === 'claude') continue;
          entries.set(r.id, { ...newSlot(), confirmed: true, row: r as Draft, thread: threads.get(r.threadId), threadSaved: true });
        }

        // R54: the unsent edits of sent notes come back the same way. A failure here must not hide the new-note drafts above.
        let storeEdits: EditDraft[] | null = null;
        try {
          if (typeof store.claimEditDrafts === 'function' && typeof store.listEditDrafts === 'function') {
            await store.claimEditDrafts(documentId, tabId, live);
            storeEdits = await store.listEditDrafts(documentId, tabId);
            for (const e of storeEdits) {
              if (edits.has(e.commentId)) continue;
              edits.set(e.commentId, {
                ...newSlot(),
                confirmed: true,
                commentId: e.commentId,
                threadId: e.threadId,
                documentId: e.documentId,
                editId: e.editId,
                body: e.body,
                updatedAt: e.updatedAt,
              });
            }
          }
        } catch (err) {
          report(null, err);
        }
        if (journal) {
          // R66: the comments the store has as sent, to spot a journal entry for text that was sent just before the crash.
          // Read only when an entry could be adopted; if it cannot be read, the entry is shown (text is never dropped).
          const sent = new Map<CommentId, CommentRow>();
          const mayAdopt = journal.list(documentId).some((j) => !j.closing && (j.tab === tabId || !live.includes(j.tab)));
          if (typeof store.listAnnotations === 'function' && (mayAdopt || (storeEdits?.length ?? 0) > 0)) {
            try {
              for (const c of (await store.listAnnotations(documentId)).comments) sent.set(c.id, c);
            } catch (err) {
              report(null, err);
            }
          }
          staleEdits(store, storeEdits, editedHere, sent);
          fromJournal(documentId, new Set(live), new Set(rows.map((r) => r.id)), storeEdits, typedHere, editedHere, sent);
        }
      };
      await (journal ? journal.locked(documentId, adopt) : adopt());
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
