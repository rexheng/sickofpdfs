// The drafts journal: a copy of every draft that the draft keeper writes, synchronously, into the extension's localStorage.
//
// Why: all the extension's pages share one renderer process (Chrome puts every page of one extension in one process). When a
// viewer tab's renderer dies, the offscreen store document and the store worker die with it, so a draft write that was on its
// way to the store is lost. A localStorage write is different: `setItem` hands the change to the browser process before it
// returns, and the browser keeps it there. Measured (crash-report.md): a setItem that has returned survives `kill -9` of the
// renderer right after it, 8 times out of 8. But not always once Chrome has terminated the extension and the owner reloads it:
// then it sometimes drops every write of the crashed pages' last seconds (crashsave, 2 crashes in 16). For a draft of a saved
// PDF the store's own copy is at most DRAFT_MAX_MS behind, so that loses at most the last letters. The two kinds of entry that
// have no copy in the store get a second copy in IndexedDB instead (`crashCopy`, the same copy as save-pending.ts keeps):
// - an unsent note this tab holds after another tab forgot the PDF (TB4 ruling, below);
// - words set aside for "Recovered notes" (`keepAside`, below).
// The copy is the same text as the entry, nothing more (an aside has no document id and no fingerprint, TB5 F1). It goes when
// the entry goes, and Forget clears it with the entry. It is never in the store, a backup or search. The next viewer of a saved
// PDF and the Notes page put a lost entry back from it (`recover`) before they read the journal.
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
// - Words set aside (`keepAside`, key `sop-draft:r:<id>`) are the owner's, kept for "Recovered notes" only: no PDF takes them back,
//   and only the owner's Delete there removes them (recovered-notes.ts). They carry no document id, no file fingerprint and no
//   quote of the PDF, only the words and a time. Two kinds:
//   - R101: a crash draft older than the note it was for (the note changed since, by a restore, another tab or later sync). It
//     never overwrites the newer note (`noteIsNewer`);
//   - TB5 ruling: a note a tab still holds after the owner forgot the PDF with "Never save this file". Its id is a random one made
//     for it, never the file's fingerprint. While its tab lives it is that tab's (`held`), and it shows under "Recovered notes"
//     once the tab has gone.
// - Nothing here syncs or is searched: sync reads the store's outbox, search the store's index.
// - Only extension pages can read it: localStorage is per origin, and web pages and content scripts have another origin.

import type { CommentId, CommentRow, DocumentId, TabId, ThreadId, ThreadRow } from '@sop/core';
import { localPendingMirror, type PendingMirror } from './save-pending';

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

/** The words of a note set aside for "Recovered notes" (see the rules above). */
export interface AsideEntry {
  v: 1;
  aside: true;
  /** A note being written, or an unsent change to a sent note. */
  kind: 'comment' | 'edit';
  body: string;
  /** When the words were typed (ms). */
  at: number;
  /** The tab holding the note in memory, and the page life it was made in: it is that tab's until the tab goes. */
  held?: { tab: TabId; life: string };
}

export const ASIDE_PREFIX = `${JOURNAL_PREFIX}r:`;

/**
 * R101: the note was changed after `at`, when the journal's words were typed: its last edit, or when it was made if it was never
 * edited. Every edit sets `editedAt` to the moment of the edit (here, in another tab, or on the computer a restore brings it from),
 * so a crash draft older than that never overwrites the note. (Not the row's stamp: that is when the store wrote it, which can be
 * a moment after an edit session the owner began straight after sending the last one.)
 */
export function noteIsNewer(note: Pick<CommentRow, 'createdAt' | 'editedAt'>, at: number): boolean {
  const changed = note.editedAt ?? note.createdAt;
  return typeof changed === 'number' && Number.isFinite(changed) && changed > at;
}
export type JournalKind = JournalEntry['kind'];

export interface DraftJournal {
  /**
   * Writes the entry now. Never throws; returns false if it could not be written (an older copy is then removed). `crashCopy`:
   * the store has no copy of this text (TB4), so it is copied to IndexedDB too. An entry written without it loses its copy.
   */
  put(e: JournalEntry, o?: { crashCopy?: boolean }): boolean;
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
  /** Sets words aside for "Recovered notes" under `id` (see the rules above). Never throws; false if it could not be written. */
  keepAside?(id: string, e: Omit<AsideEntry, 'v' | 'aside'>): boolean;
  /** Removes words set aside under `id` (the note was sent, emptied or saved after all). */
  removeAside?(id: string): void;
  /** Words set aside that a tab held: the ones a page of `tab` other than `life` held are that tab's no more (it was reloaded). */
  releaseAside?(tab: TabId, life: string): void;
  /**
   * Puts back into localStorage each IndexedDB copy that localStorage lost or holds an older version of, unless `skip` says the
   * tab named in it still owns it (a tab that is open and still typing). Call it before reading the journal. Never rejects.
   */
  recover?(skip: (tab: string) => boolean): Promise<void>;
}

/** The keys this page copied to IndexedDB: an entry written again without its copy (the store has it now) drops the copy. */
const copiedKeys = new Set<string>();

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
export function createDraftJournal(storage: KeyValueStorage, mirror: PendingMirror | null = null): DraftJournal {
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
    copiedKeys.delete(k);
    mirror?.remove(k); // a copy another tab or an earlier page made goes too
  };
  /** Writes `raw` under `k`, with its IndexedDB copy when `copy`. False if localStorage refused it. */
  const write = (k: string, raw: string, copy: boolean): boolean => {
    try {
      storage.setItem(k, raw);
    } catch {
      return false;
    }
    if (copy) {
      copiedKeys.add(k);
      mirror?.put(k, raw);
    } else if (copiedKeys.delete(k)) mirror?.remove(k);
    return true;
  };

  return {
    put(e, o) {
      const k = keyOf(e.kind, e.commentId);
      if (write(k, JSON.stringify(e), o?.crashCopy === true)) return true;
      // Full or refused. An older copy must not outlive the newer text, so it goes; the store still has the draft.
      removeKey(k);
      return false;
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
      // A copy whose entry localStorage lost goes too: nothing of a forgotten PDF's notes comes back from it.
      void mirror
        ?.read(JOURNAL_PREFIX)
        .then((copies) => {
          for (const [k, raw] of copies) {
            const e = parse(raw);
            if (e !== null && e.documentId === documentId && k === keyOf(e.kind, e.commentId) && readRaw(k) === null) mirror.remove(k);
          }
        })
        .catch(() => {});
    },
    locked(documentId, fn) {
      const locks = lockManager();
      if (!locks) return fn();
      return locks.request(`sop-draft-journal:${documentId}`, () => fn());
    },
    keepAside(id, e) {
      const k = `${ASIDE_PREFIX}${id}`;
      const entry: AsideEntry = { v: 1, aside: true, kind: e.kind, body: e.body, at: e.at, ...(e.held ? { held: e.held } : {}) };
      // Full or refused: false, and the words are still where they were (the tab, or the journal entry not yet removed).
      return write(k, JSON.stringify(entry), true);
    },
    removeAside: (id) => removeKey(`${ASIDE_PREFIX}${id}`),
    releaseAside(tab, life) {
      for (const k of keys()) {
        if (!k.startsWith(ASIDE_PREFIX)) continue;
        let e: Partial<AsideEntry> | null;
        try {
          e = JSON.parse(storage.getItem(k) ?? 'null') as Partial<AsideEntry> | null;
        } catch {
          continue;
        }
        if (e?.aside !== true || e.held?.tab !== tab || e.held.life === life) continue;
        const rest = { ...e };
        delete rest.held;
        write(k, JSON.stringify(rest), true); // if refused, it stays held; it shows once the tab has gone
      }
    },
    async recover(skip) {
      if (!mirror) return;
      const copies = await mirror.read(JOURNAL_PREFIX).catch((): [string, string][] => []);
      for (const [k, raw] of copies) {
        const copy = fields(safeJson(raw));
        if (!copy) continue;
        const owner = typeof copy.tab === 'string' ? copy.tab : fields(copy.held)?.tab;
        if (typeof owner === 'string' && skip(owner)) continue;
        const here = fields(safeJson(readRaw(k)));
        if (here !== null && typeof here.at === 'number' && typeof copy.at === 'number' && here.at >= copy.at) continue; // as new or newer
        try {
          storage.setItem(k, raw);
          copiedKeys.add(k);
        } catch {
          // full: the copy stays in IndexedDB, and the next look tries again
        }
      }
    },
  };
  function readRaw(k: string): string | null {
    try {
      return storage.getItem(k);
    } catch {
      return null;
    }
  }
}

function safeJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The viewer's journal: the extension's localStorage. Null in Incognito and where localStorage cannot be used. */
export function localDraftJournal(): DraftJournal | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) return null;
    if (typeof localStorage === 'undefined') return null;
    return createDraftJournal(localStorage, localPendingMirror());
  } catch {
    return null; // a page with storage blocked throws on the first touch
  }
}

/** The PDF was forgotten: its drafts go from the journal too (call it where the store's `forgetDocument` is called). */
export function forgetDraftJournal(documentId: DocumentId): void {
  localDraftJournal()?.clear(documentId);
}
