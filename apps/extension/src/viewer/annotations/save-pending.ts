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
// - R105b: it says what started the save (`cause`), so a save finished on the next open keeps that reason. "Your first note saved
//   it" stays a first note's save, and Claude still asks first on it. A record that does not say (one written before this field)
//   is never taken as the owner's own Save.
// - A second copy in IndexedDB (crashsave, Nov 7). Until the save lands, this record is the only copy of the note's words. When
//   the renderer crashes, Chrome terminates the extension, and the owner reloads it, Chrome sometimes drops every localStorage
//   write the crashed pages made in their last seconds (measured: 2 crashes in 16 during a first note's save; the page never
//   removed the record, it was simply not there after the reload). An IndexedDB write that has committed is kept. So every write
//   and removal of a record is copied there too, a few ms behind (`PendingMirror`), and the next open of the file puts back into
//   localStorage the copy of a tab that has gone before it looks for records (`recover`). The copy follows the record exactly:
//   it is removed with it, and Undo and Forget clear both. Same origin as localStorage, so web pages and content scripts cannot
//   read it either; it never syncs, is never searched and is not in backups.
import type { CommentRow, TabId } from '@sop/core';
import type { AnnotationOp } from './boundary';
import type { KeyValueStorage } from './draft-journal';
import type { SessionEditDraft } from './session';

export const PENDING_PREFIX = 'sop-pending:';

/** What started a save that is on its way: the owner's own Save (the chip, the banner, Yes), the filter's own save, or a first note or mark. */
export type PendingCause = 'owner' | 'filter' | 'first-note' | 'first-mark';
const CAUSES: readonly PendingCause[] = ['owner', 'filter', 'first-note', 'first-mark'];

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
  /** R105b: what started the save. Left out when this tab does not know: then the save it finishes is not the owner's choice. */
  cause?: PendingCause;
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
  /**
   * Puts back into localStorage the IndexedDB copy of each record for this fingerprint (every fingerprint when null) that
   * localStorage lost or holds an older version of, unless `skip` says its tab still owns it. Call it before `list`. Never rejects.
   */
  recover?(fingerprint: string | null, skip: (rec: PendingSave) => boolean): Promise<void>;
}

/** The second copy of the records (see the rules above). Writes are queued and never throw; reads give [] when they cannot read. */
export interface PendingMirror {
  put(key: string, value: string): void;
  remove(key: string): void;
  /** Removes every copy whose key starts with `prefix`. */
  clear(prefix: string): void;
  /** Every copy whose key starts with `prefix`, after the writes queued before this call. */
  read(prefix: string): Promise<[string, string][]>;
}

const keyOf = (p: Pick<PendingSave, 'fingerprint' | 'tab' | 'life'>): string => `${PENDING_PREFIX}${p.fingerprint}:${p.tab}:${p.life}`;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

function parse(raw: string | null): PendingSave | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingSave> | null;
    if (!v || v.v !== 1 || !isId(v.fingerprint) || !isId(v.tab) || !isId(v.life) || typeof v.at !== 'number' || typeof v.undoable !== 'boolean') return null;
    if (!Array.isArray(v.ops) || !Array.isArray(v.drafts) || !Array.isArray(v.edits)) return null;
    const rec = v as PendingSave;
    if (rec.cause !== undefined && !CAUSES.includes(rec.cause)) delete rec.cause; // a cause it does not know is no cause
    return rec;
  } catch {
    return null;
  }
}

export function createPendingSaves(storage: KeyValueStorage, mirror: PendingMirror | null = null): PendingSaves {
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
    mirror?.remove(k);
  };
  return {
    put(p) {
      if (!isId(p.fingerprint)) return false; // never a record without its file
      const k = keyOf(p);
      const raw = JSON.stringify(p);
      try {
        storage.setItem(k, raw);
      } catch {
        removeKey(k); // full: an older copy must not outlive newer text
        return false;
      }
      mirror?.put(k, raw);
      return true;
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
      if (isId(fingerprint)) mirror?.clear(`${PENDING_PREFIX}${fingerprint}:`);
    },
    locked(fn) {
      const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null;
      return locks ? locks.request('sop-pending-saves', () => fn()) : fn();
    },
    async recover(fingerprint, skip) {
      if (!mirror || (fingerprint !== null && !isId(fingerprint))) return;
      const copies = await mirror.read(fingerprint === null ? PENDING_PREFIX : `${PENDING_PREFIX}${fingerprint}:`).catch(() => []);
      for (const [k, raw] of copies) {
        const copy = parse(raw);
        if (!copy || k !== keyOf(copy) || skip(copy)) continue;
        let here: PendingSave | null;
        try {
          here = parse(storage.getItem(k));
        } catch {
          here = null;
        }
        if (here !== null && here.at >= copy.at) continue; // localStorage has it, as new or newer
        try {
          storage.setItem(k, raw);
        } catch {
          // full: the copy stays in IndexedDB, and the next open tries again
        }
      }
    },
  };
}

const MIRROR_DB = 'sop-pending-copies';
const MIRROR_STORE = 'records';

/** The records' copy in this origin's IndexedDB. Writes go in order, one transaction at a time; a key's newer write replaces one still waiting. */
export function createPendingMirror(factory: IDBFactory): PendingMirror {
  let db: Promise<IDBDatabase | null> | null = null;
  const open = (): Promise<IDBDatabase | null> =>
    (db ??= new Promise((resolve) => {
      try {
        const req = factory.open(MIRROR_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(MIRROR_STORE);
        req.onsuccess = () => {
          const d = req.result;
          d.onversionchange = () => d.close();
          resolve(d);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null); // no IndexedDB here: localStorage alone keeps the records
      }
    }));
  type Op = { key: string; value: string | null } | { prefix: string };
  let queue: Op[] = [];
  let drained: Promise<void> = Promise.resolve();
  let running = false;
  const range = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, `${prefix}￿`);
  const write = (d: IDBDatabase, ops: Op[]): Promise<void> =>
    new Promise((resolve) => {
      try {
        const tx = d.transaction(MIRROR_STORE, 'readwrite');
        const s = tx.objectStore(MIRROR_STORE);
        for (const op of ops) {
          if ('prefix' in op) s.delete(range(op.prefix));
          else if (op.value === null) s.delete(op.key);
          else s.put(op.value, op.key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve(); // the database went away: localStorage still has the record
      }
    });
  const pump = (): void => {
    if (running) return;
    running = true;
    drained = (async () => {
      try {
        while (queue.length > 0) {
          const ops = queue;
          queue = [];
          const d = await open();
          if (d) await write(d, ops);
        }
      } finally {
        running = false;
      }
    })();
  };
  const enqueue = (op: Op): void => {
    if (!('prefix' in op)) queue = queue.filter((o) => 'prefix' in o || o.key !== op.key);
    queue.push(op);
    pump();
  };
  void open(); // opened now, so the first letter's copy does not wait for it
  return {
    put: (key, value) => enqueue({ key, value }),
    remove: (key) => enqueue({ key, value: null }),
    clear: (prefix) => enqueue({ prefix }),
    async read(prefix) {
      await drained;
      const d = await open();
      if (!d) return [];
      return new Promise((resolve) => {
        try {
          const s = d.transaction(MIRROR_STORE, 'readonly').objectStore(MIRROR_STORE);
          const keys = s.getAllKeys(range(prefix));
          const values = s.getAll(range(prefix));
          values.onsuccess = () => {
            const ks = keys.result as unknown[];
            const vs = values.result as unknown[];
            const out: [string, string][] = [];
            ks.forEach((k, i) => {
              const v = vs[i];
              if (typeof k === 'string' && typeof v === 'string') out.push([k, v]);
            });
            resolve(out);
          };
          values.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
    },
  };
}

let localMirror: PendingMirror | null | undefined;
/** This page's copy of the records (one queue and one connection per page). Null where IndexedDB cannot be used. */
export function localPendingMirror(): PendingMirror | null {
  if (localMirror !== undefined) return localMirror;
  try {
    localMirror = typeof indexedDB === 'undefined' ? null : createPendingMirror(indexedDB);
  } catch {
    localMirror = null;
  }
  return localMirror;
}

/** The viewer's records: the extension's localStorage. Null in Incognito and where localStorage cannot be used. */
export function localPendingSaves(): PendingSaves | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.extension?.inIncognitoContext) return null;
    if (typeof localStorage === 'undefined') return null;
    return createPendingSaves(localStorage, localPendingMirror());
  } catch {
    return null;
  }
}
