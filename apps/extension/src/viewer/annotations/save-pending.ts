// Ruling R67 (a): what the owner made on a PDF while its save was on its way is kept as "save-pending".
//
// The first mark or the first typed note on a PDF that is not saved starts its save. The save reads every page's text
// before it writes anything, so on a long book it takes seconds. Until it lands, nothing can go to the store, because
// the store has no document to hang the rows on. So the session keeps, synchronously, one record per tab in the
// extension's localStorage (which survives a crash of the tab, draft-journal.ts says why), keyed by the opened file's
// fingerprint (its SHA-256, the id the save gives the document). Never an empty document id.
//
// - The record holds the writes still waiting (marks, notes that were sent, removals) and the unsent notes and edits.
// - It is written only once a save is really on its way: the owner's mark or note started it, the owner pressed Save or
//   answered Yes, or the filter is saving a learning PDF. Nothing is written while the question "Save this PDF?" is open.
// - When the save lands, the unsent notes go to the draft keeper under the document id, and the record keeps only the
//   writes still waiting. Once those are written the record goes.
// - If the tab closes or crashes first, the next open of the same file (or of a stamped copy, once the document exists)
//   finds the record, completes the save (the owner's own action started it), and puts the notes back.
// - If the save fails, the record stays, and the chip says "Couldn't save. Try again".
// - Undo and Forget remove it (forgetLocalTraces). Nothing here syncs or is searched. Incognito keeps none.
import type { CommentRow, TabId } from '@sop/core';
import type { AnnotationOp } from './boundary';
import type { KeyValueStorage } from './draft-journal';
import type { SessionEditDraft } from './session';

export const PENDING_PREFIX = 'sop-pending:';

export interface PendingSave {
  v: 1;
  /** The opened file's SHA-256: the document id the save gives it. */
  fingerprint: string;
  /** The tab that made these notes. */
  tab: TabId;
  /**
   * One page life of that tab. A tab keeps its id across its own reloads (R65), so this tells the page that wrote the
   * record from the page that reads it after a reload.
   */
  life: string;
  /** When the record was last written (the tab's clock, ms). */
  at: number;
  /** The save keeps its Undo when it completes: only a mark started it, and nothing else was made (R67 c, f). */
  undoable: boolean;
  /** Writes not made yet, oldest first, as the session's write queue holds them. */
  ops: AnnotationOp[];
  /** Unsent notes, as the draft keeper would save them (a new note's thread rides in `meta.sopDraft`). */
  drafts: CommentRow[];
  /** Unsent edits of sent notes (R54). */
  edits: SessionEditDraft[];
}

export interface PendingSaves {
  /** Writes the record now. Never throws; false when it could not be written (the older copy is then removed). */
  put(p: PendingSave): boolean;
  remove(p: Pick<PendingSave, 'fingerprint' | 'tab' | 'life'>): void;
  /** Every tab's record for this fingerprint. */
  list(fingerprint: string): PendingSave[];
  /** Removes every tab's record for this fingerprint. */
  clear(fingerprint: string): void;
  /** Runs `fn` holding the one lock all tabs use for these records, so two tabs never take the same one. */
  locked<T>(fn: () => Promise<T>): Promise<T>;
}

const keyOf = (p: Pick<PendingSave, 'fingerprint' | 'tab' | 'life'>): string => `${PENDING_PREFIX}${p.fingerprint}:${p.tab}:${p.life}`;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

function parse(raw: string | null): PendingSave | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingSave> | null;
    if (!v || v.v !== 1 || !isId(v.fingerprint) || !isId(v.tab) || !isId(v.life) || typeof v.at !== 'number' || typeof v.undoable !== 'boolean') return null;
    if (!Array.isArray(v.ops) || !Array.isArray(v.drafts) || !Array.isArray(v.edits)) return null;
    return v as PendingSave;
  } catch {
    return null;
  }
}

export function createPendingSaves(storage: KeyValueStorage): PendingSaves {
  const keys = (fingerprint: string): string[] => {
    const out: string[] = [];
    const prefix = `${PENDING_PREFIX}${fingerprint}:`;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k?.startsWith(prefix)) out.push(k);
      }
    } catch {
      // storage that cannot be read has no records
    }
    return out;
  };
  const removeKey = (k: string): void => {
    try {
      storage.removeItem(k);
    } catch {
      // nothing more can be done
    }
  };
  return {
    put(p) {
      if (!isId(p.fingerprint)) return false; // never a record without its file
      const k = keyOf(p);
      try {
        storage.setItem(k, JSON.stringify(p));
        return true;
      } catch {
        removeKey(k); // full: an older copy must not outlive newer text
        return false;
      }
    },
    remove: (p) => removeKey(keyOf(p)),
    list(fingerprint) {
      const out: PendingSave[] = [];
      for (const k of keys(fingerprint)) {
        let rec: PendingSave | null;
        try {
          rec = parse(storage.getItem(k));
        } catch {
          rec = null;
        }
        if (rec && k === keyOf(rec)) out.push(rec);
      }
      return out;
    },
    clear(fingerprint) {
      for (const k of keys(fingerprint)) removeKey(k);
    },
    locked(fn) {
      const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;
      return locks ? locks.request('sop-pending-saves', () => fn()) : fn();
    },
  };
}

/** The viewer's records: the extension's localStorage. Null in Incognito and where localStorage cannot be used. */
export function localPendingSaves(): PendingSaves | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) return null;
    if (typeof localStorage === 'undefined') return null;
    return createPendingSaves(localStorage);
  } catch {
    return null;
  }
}
