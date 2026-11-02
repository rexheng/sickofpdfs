// The drafts journal: a copy of every draft that the draft keeper writes, synchronously, into the extension's localStorage.
//
// Why: all the extension's pages share one renderer process (Chrome puts every page of one extension in one process). When a
// viewer tab's renderer dies, the offscreen store document and the store worker die with it, so a draft write that was on its
// way to the store is lost. A localStorage write is different: `setItem` hands the change to the browser process before it
// returns, and the browser keeps it there. Measured (crash-report.md): a setItem that has returned survives `kill -9` of the
// renderer right after it, 8 times out of 8.
//
// Rules (contracts section 3, "no lost text"):
// - One key per draft: `sop-draft:c:<comment id>` for a note or reply being typed, `sop-draft:e:<comment id>` for an unsent
//   edit of a sent note (R54). The value is small: the text, the ids, the tab that owns it and a time. The whole row (with its
//   new thread) is kept only until the store has confirmed one write of it; after that the store keeps the rest.
// - `pending` says the store has not confirmed this text yet. On restore, a pending journal text is newer than the store's.
// - The keeper writes here only when it writes to the store: never for a PDF that is not saved, never in Incognito (the
//   viewer has no notes there, and `localDraftJournal` refuses too). One exception (TB4 ruling, Forget wins, no lost text):
//   when another tab forgets the PDF, an unsent note this tab still holds is kept here until it is sent, dropped or saved.
// - An entry goes when the draft is sent or discarded and the store has confirmed it, or when the PDF is forgotten.
// - Nothing here syncs or is searched: sync reads the store's outbox, search the store's index.
// - Only extension pages can read it: localStorage is per origin, and web pages and content scripts have another origin.

import type { CommentId, CommentRow, DocumentId, TabId, ThreadId, ThreadRow } from '@sop/core';

export const JOURNAL_PREFIX = 'sop-draft:';

export interface JournalCommentEntry {
  v: 1;
  kind: 'comment';
  documentId: DocumentId;
  commentId: CommentId;
  threadId: ThreadId;
  /** The tab that owns the draft. */
  tab: TabId;
  body: string;
  /** When this text was typed (the tab's clock, ms). For the record; restore decides by `pending`. */
  at: number;
  /** True while the store has not confirmed this text. */
  pending: boolean;
  /** The draft is over (sent or cancelled); the entry goes once the store has confirmed the delete. */
  closing?: true;
  /** The whole row, only until the store has confirmed a write of it: what restore needs if the store never had it. */
  row?: CommentRow & { draftOfTab: TabId };
  /** The draft's new thread, only until the store has confirmed it. */
  thread?: ThreadRow;
}

export interface JournalEditEntry {
  v: 1;
  kind: 'edit';
  documentId: DocumentId;
  commentId: CommentId;
  threadId: ThreadId;
  editId: string;
  tab: TabId;
  body: string;
  at: number;
  pending: boolean;
  closing?: true;
}

export type JournalEntry = JournalCommentEntry | JournalEditEntry;
export type JournalKind = JournalEntry['kind'];

export interface DraftJournal {
  /** Writes the entry now. Never throws; returns false if it could not be written (an older copy is then removed). */
  put(e: JournalEntry): boolean;
  get(kind: JournalKind, commentId: CommentId): JournalEntry | null;
  remove(kind: JournalKind, commentId: CommentId): void;
  /** Every entry of one document. */
  list(documentId: DocumentId): JournalEntry[];
  /**
   * Removes every entry of one document (the PDF was forgotten). Only entries that parse and name that document: an entry
   * that cannot be read or placed is never removed by a clear (R77). It shows under "Recovered notes", and only the owner's
   * Delete there removes it (recovered-notes.ts).
   */
  clear(documentId: DocumentId): void;
  /** Runs `fn` while holding this document's journal lock, so two tabs never adopt the same entry. */
  locked<T>(documentId: DocumentId, fn: () => Promise<T>): Promise<T>;
}

/** The part of the Web Storage API the journal uses. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const keyOf = (kind: JournalKind, id: CommentId): string => `${JOURNAL_PREFIX}${kind === 'comment' ? 'c' : 'e'}:${id}`;

const isText = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

const fields = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

function parse(raw: string | null): JournalEntry | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  if (e.v !== 1 || (e.kind !== 'comment' && e.kind !== 'edit')) return null;
  if (!isText(e.documentId) || !isText(e.commentId) || !isText(e.threadId) || !isText(e.tab)) return null;
  if (typeof e.body !== 'string' || typeof e.at !== 'number' || typeof e.pending !== 'boolean') return null;
  if (e.kind === 'edit' && !isText(e.editId)) return null;
  const row = fields(e.row);
  if (e.kind === 'comment' && e.row !== undefined && (row?.id !== e.commentId || row.threadId !== e.threadId || row.documentId !== e.documentId)) return null;
  const thread = fields(e.thread);
  if (e.kind === 'comment' && e.thread !== undefined && (thread?.id !== e.threadId || thread.documentId !== e.documentId)) return null;
  return v as JournalEntry;
}

/** True when a journal entry can be placed: it parses and names its document (R77: anything else is a recovered note). */
export function canPlace(raw: string | null): boolean {
  return parse(raw) !== null;
}

/** Web Locks, where there are any. */
const lockManager = (): LockManager | null => (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null);

/** A journal over `storage`. `createDraftJournal(localStorage)` is the viewer's; tests pass their own storage. */
export function createDraftJournal(storage: KeyValueStorage): DraftJournal {
  const keys = (): string[] => {
    const out: string[] = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(JOURNAL_PREFIX)) out.push(k);
      }
    } catch {
      // storage that cannot be read has no entries
    }
    return out;
  };
  const read = (k: string): JournalEntry | null => {
    try {
      return parse(storage.getItem(k));
    } catch {
      return null;
    }
  };
  const removeKey = (k: string): void => {
    try {
      storage.removeItem(k);
    } catch {
      // nothing more can be done
    }
  };

  return {
    put(e) {
      const k = keyOf(e.kind, e.commentId);
      try {
        storage.setItem(k, JSON.stringify(e));
        return true;
      } catch {
        // Full or refused. An older copy must not outlive the newer text, so it goes; the store still has the draft.
        removeKey(k);
        return false;
      }
    },
    get: (kind, id) => read(keyOf(kind, id)),
    remove: (kind, id) => removeKey(keyOf(kind, id)),
    list(documentId) {
      const out: JournalEntry[] = [];
      for (const k of keys()) {
        const e = read(k);
        if (e && e.documentId === documentId && k === keyOf(e.kind, e.commentId)) out.push(e);
      }
      return out;
    },
    clear(documentId) {
      for (const k of keys()) {
        const e = read(k);
        if (e !== null && e.documentId === documentId && k === keyOf(e.kind, e.commentId)) removeKey(k);
      }
    },
    locked(documentId, fn) {
      const locks = lockManager();
      if (!locks) return fn();
      return locks.request(`sop-draft-journal:${documentId}`, () => fn());
    },
  };
}

/** The viewer's journal: the extension's localStorage. Null in Incognito and where localStorage cannot be used. */
export function localDraftJournal(): DraftJournal | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) return null;
    if (typeof localStorage === 'undefined') return null;
    return createDraftJournal(localStorage);
  } catch {
    return null; // a page with storage blocked throws on the first touch
  }
}

/** The PDF was forgotten: its drafts go from the journal too (call it where the store's `forgetDocument` is called). */
export function forgetDraftJournal(documentId: DocumentId): void {
  localDraftJournal()?.clear(documentId);
}
