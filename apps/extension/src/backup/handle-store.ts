// IndexedDB `sop-handles` (contracts §5, Phase 3): the chosen backup folder, a small status record, what this computer has
// already written to that folder, and the forgotten readings whose copies in the folder are not removed yet.
//
// It sits next to `sop-device` and is "store side": it holds no secret, and this file never reaches the secrets store (the
// import boundary in eslint.config.mjs bars it). It is never backed up and never synced: a folder handle means nothing on
// another computer.
//
// Object stores:
//   target  'backup'     StoredTarget: the folder handle (or, in test builds, an OPFS folder standing in for it)
//   status  'backup'     BackupStatus
//   known   'backup'     KnownRecord: the readings this computer wrote into the folder, each with its number of notes (live marks
//                        and comments) at the last good run. It is what lets a run tell "removed here on purpose" from "never
//                        mine", and notice notes that vanished (writer.ts: the guards). Version 1 kept a plain string[].
//   scrub   <documentId> { documentId, requestedAt }: a reading that left the library for good (R82: Forget, a Trash purge, an Undo
//                        of a save). Its copies are removed from the chosen folder and from every snapshot; the entry goes only when
//                        that is done, so a folder that is offline now is cleaned at the next run.
//   retired <auto id>    RetiredFolder: a folder the owner moved away from (Change folder, Turn off) while removals were still
//                        waiting for it. Its handle and its list stay until the removals are done there (each run tries again);
//                        then the record goes. Nothing else is ever written to a retired folder.
//
// The pending lists belong to the folder they must be removed from: choosing the same folder again keeps them (and `known`), and
// changing folders moves them to `retired`, never drops them (secread4 M3).
import { emptyStatus, type BackupStatus } from './status';

export const HANDLES_DB = 'sop-handles';
const DB_VERSION = 2;

/** The folder the owner chose. */
export interface FolderTarget {
  kind: 'folder';
  handle: FileSystemDirectoryHandle;
  /** The folder's name, for Settings. */
  name: string;
  pickedAt: number;
  /**
   * Test builds only (the hooks boundary, test-hooks.ts): what the folder says about permission instead of what Chrome says. A worker cannot be
   * reached by patching a page's `queryPermission`, so a test sets this next to the target. Production builds never read it.
   */
  testPermission?: PermissionState;
}

/** Test builds only: an OPFS folder that stands in for the picked one (the picker cannot be driven headless). */
export interface TestFolderTarget {
  kind: 'test-opfs';
  /** The folder's name under the OPFS root. */
  folder: string;
  /** What `queryPermission` says. A test sets it to 'prompt' to lose the permission. */
  permission: PermissionState;
  name: string;
  pickedAt: number;
}

export type StoredTarget = FolderTarget | TestFolderTarget;

export interface PendingScrub {
  documentId: string;
  requestedAt: number;
}

/** A folder the owner moved away from while removals were still waiting for it. */
export interface RetiredFolder {
  id: number;
  target: StoredTarget;
  scrubs: PendingScrub[];
  retiredAt: number;
}

/**
 * The readings this computer wrote into the folder, each with its number of notes (live marks and comments) at the last good run.
 * `null` is "not known": a record from before notes were counted. The notes guard leaves such a reading out.
 */
export type KnownReadings = Map<string, number | null>;

export interface HandleStore {
  getTarget(): Promise<StoredTarget | null>;
  /** Puts a new handle for the folder that is chosen now (its permission changed, say). Use `changeTarget` to choose a folder. */
  setTarget(target: StoredTarget): Promise<void>;
  /**
   * Chooses `next` (null: backup is turned off), in one transaction. `same`: it is the folder that is chosen now, picked again, so
   * what was written there and its pending removals are kept. Otherwise the old folder's pending removals move to `retired` with its
   * handle (nothing is dropped), and the status and the written list start afresh. Files already in a folder stay where they are.
   */
  changeTarget(next: StoredTarget | null, o: { same: boolean; at: number }): Promise<void>;
  getStatus(): Promise<BackupStatus>;
  /** Reads, changes and writes the status in one transaction, so a page and the offscreen document never overwrite each other. */
  updateStatus(change: (current: BackupStatus) => BackupStatus): Promise<BackupStatus>;
  getKnown(): Promise<KnownReadings>;
  /** Records what the folder holds now. A plain list of ids keeps the note counts already known for them. */
  setKnown(readings: KnownReadings | Iterable<string>): Promise<void>;
  addScrub(documentId: string, at: number): Promise<void>;
  listScrubs(): Promise<PendingScrub[]>;
  removeScrubs(documentIds: readonly string[]): Promise<void>;
  listRetired(): Promise<RetiredFolder[]>;
  /** Removals done in a retired folder. When none is left, the record (and its handle) goes. */
  doneRetired(id: number, documentIds: readonly string[]): Promise<void>;
  /** A new handle for a retired folder (its permission was granted again). */
  setRetiredTarget(id: number, target: StoredTarget): Promise<void>;
  /**
   * R88: drops every queued removal requested before `before`, from the chosen folder's queue and from retired folders. A retired
   * folder left with nothing goes. Returns what was dropped from retired folders, for Settings.
   */
  expireScrubs(before: number): Promise<{ folderName: string; count: number }[]>;
  close(): void;
}

const KEY = 'backup';

/** `known` as stored: version 2 keeps the note counts. */
interface KnownRecord {
  v: 2;
  readings: Record<string, number | null>;
}

function asKnown(v: unknown): KnownReadings {
  const out: KnownReadings = new Map();
  if (Array.isArray(v)) {
    for (const id of v) if (typeof id === 'string') out.set(id, null);
  } else if (typeof v === 'object' && v !== null && (v as { v?: unknown }).v === 2) {
    const readings = (v as { readings?: unknown }).readings;
    if (typeof readings === 'object' && readings !== null) {
      for (const [id, n] of Object.entries(readings)) out.set(id, typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
    }
  }
  return out;
}

function asRetired(v: unknown): RetiredFolder | null {
  if (!isRecord(v) || typeof v.id !== 'number') return null;
  const target = asTarget(v.target);
  if (target === null) return null;
  const scrubs = Array.isArray(v.scrubs)
    ? v.scrubs.flatMap((r: unknown) => (isRecord(r) && typeof r.documentId === 'string' ? [{ documentId: r.documentId, requestedAt: typeof r.requestedAt === 'number' ? r.requestedAt : 0 }] : []))
    : [];
  return { id: v.id, target, scrubs, retiredAt: typeof v.retiredAt === 'number' ? v.retiredAt : 0 };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLES_DB, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['target', 'status', 'known']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      if (!db.objectStoreNames.contains('scrub')) db.createObjectStore('scrub', { keyPath: 'documentId' });
      if (!db.objectStoreNames.contains('retired')) db.createObjectStore('retired', { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The backup settings did not open.'));
    request.onblocked = () => reject(new Error('The backup settings are blocked by another tab.'));
  });
}

type StoreName = 'target' | 'status' | 'known' | 'scrub' | 'retired';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * A stored target is read defensively: anything that is not one of the two shapes reads as "no folder". The test-only parts
 * (`testPermission`, the `test-opfs` stand-in) are read only in a test build: `import.meta.env.MODE` is fixed at build time,
 * so a production build drops them (TB4 code and security critic, finding 5).
 */
function asTarget(v: unknown): StoredTarget | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'folder' && isRecord(v.handle) && typeof v.name === 'string') {
    const folder: FolderTarget = { kind: 'folder', handle: v.handle as unknown as FileSystemDirectoryHandle, name: v.name, pickedAt: typeof v.pickedAt === 'number' ? v.pickedAt : 0 };
    if (import.meta.env.MODE === 'test') {
      const p = v.testPermission;
      if (p === 'prompt' || p === 'granted' || p === 'denied') folder.testPermission = p;
    }
    return folder;
  }
  if (import.meta.env.MODE === 'test' && v.kind === 'test-opfs' && typeof v.folder === 'string' && typeof v.name === 'string') {
    return {
      kind: 'test-opfs',
      folder: v.folder,
      permission: v.permission === 'prompt' || v.permission === 'denied' ? v.permission : 'granted',
      name: v.name,
      pickedAt: typeof v.pickedAt === 'number' ? v.pickedAt : 0,
    };
  }
  return null;
}

function asStatus(v: unknown): BackupStatus {
  const base = emptyStatus();
  if (!isRecord(v)) return base;
  return { ...base, ...(v as Partial<BackupStatus>) };
}

/** Opens (and, the first time, creates) the database. Any extension page, the offscreen document or the service worker may call it. */
export async function openHandleStore(): Promise<HandleStore> {
  let opening: Promise<IDBDatabase> | undefined;
  // One connection, opened again if the browser closes it (a deleted database, a newer version in another tab).
  const database = (): Promise<IDBDatabase> =>
    (opening ??= openDatabase().then(
      (db) => {
        db.onversionchange = () => {
          opening = undefined;
          db.close();
        };
        db.onclose = () => {
          opening = undefined;
        };
        return db;
      },
      (error: unknown) => {
        opening = undefined;
        throw error;
      },
    ));
  await database();

  /** Runs `body` in one transaction and answers when the transaction has committed. */
  async function transact<T>(
    stores: StoreName | StoreName[],
    mode: IDBTransactionMode,
    body: (open: (name: StoreName) => IDBObjectStore, answer: (value: T) => void) => void,
  ): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      let result!: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('The backup settings could not be used.'));
      tx.onabort = () => reject(tx.error ?? new Error('The backup settings could not be used.'));
      body(
        (name) => tx.objectStore(name),
        (value) => {
          result = value;
        },
      );
    });
  }

  return {
    getTarget: () =>
      transact<StoredTarget | null>('target', 'readonly', (open, answer) => {
        const request = open('target').get(KEY);
        request.onsuccess = () => answer(asTarget(request.result));
      }),

    setTarget: (target) =>
      transact<void>('target', 'readwrite', (open) => {
        open('target').put(target, KEY);
      }),

    changeTarget: (next, o) =>
      transact<void>(['target', 'status', 'known', 'scrub', 'retired'], 'readwrite', (open) => {
        const target = open('target');
        if (o.same && next !== null) {
          // The same folder, picked again: it keeps what was written there and what is still to be removed from it.
          target.put(next, KEY);
          return;
        }
        const old = target.get(KEY);
        const pending = open('scrub').getAll();
        // Requests in a transaction finish in order, so `old` has its result when `pending` has.
        pending.onsuccess = () => {
          const was = asTarget(old.result);
          const rows: unknown[] = pending.result;
          const scrubs = rows.flatMap((r) =>
            isRecord(r) && typeof r.documentId === 'string' ? [{ documentId: r.documentId, requestedAt: typeof r.requestedAt === 'number' ? r.requestedAt : 0 }] : [],
          );
          // Removals still waiting for the old folder stay with it (and its handle) until they are done there.
          if (was !== null && scrubs.length > 0) open('retired').add({ target: was, scrubs, retiredAt: o.at });
          open('scrub').clear();
          open('known').delete(KEY);
          open('status').delete(KEY);
          if (next === null) target.delete(KEY);
          else target.put(next, KEY);
        };
      }),

    getStatus: () =>
      transact<BackupStatus>('status', 'readonly', (open, answer) => {
        const request = open('status').get(KEY);
        request.onsuccess = () => answer(asStatus(request.result));
      }),

    updateStatus: (change) =>
      transact<BackupStatus>('status', 'readwrite', (open, answer) => {
        const store = open('status');
        const request = store.get(KEY);
        request.onsuccess = () => {
          const next = change(asStatus(request.result));
          store.put(next, KEY);
          answer(next);
        };
      }),

    getKnown: () =>
      transact<KnownReadings>('known', 'readonly', (open, answer) => {
        const request = open('known').get(KEY);
        request.onsuccess = () => answer(asKnown(request.result));
      }),

    setKnown: (readings) =>
      transact<void>('known', 'readwrite', (open) => {
        const store = open('known');
        const request = store.get(KEY);
        request.onsuccess = () => {
          const before = asKnown(request.result);
          const next: KnownRecord = { v: 2, readings: {} };
          if (readings instanceof Map) for (const [id, n] of readings) next.readings[id] = n;
          else for (const id of readings) next.readings[id] = before.get(id) ?? null;
          store.put(next, KEY);
        };
      }),

    addScrub: (documentId, at) =>
      transact<void>('scrub', 'readwrite', (open) => {
        const store = open('scrub');
        // The earliest request stands, so a repeated one does not look newer.
        const request = store.get(documentId);
        request.onsuccess = () => {
          if (request.result === undefined) store.put({ documentId, requestedAt: at });
        };
      }),

    listScrubs: () =>
      transact<PendingScrub[]>('scrub', 'readonly', (open, answer) => {
        const request = open('scrub').getAll();
        request.onsuccess = () => {
          const rows: unknown[] = request.result;
          answer(
            rows.flatMap((r) =>
              isRecord(r) && typeof r.documentId === 'string' ? [{ documentId: r.documentId, requestedAt: typeof r.requestedAt === 'number' ? r.requestedAt : 0 }] : [],
            ),
          );
        };
      }),

    removeScrubs: (documentIds) =>
      transact<void>('scrub', 'readwrite', (open) => {
        const store = open('scrub');
        for (const id of documentIds) store.delete(id);
      }),

    listRetired: () =>
      transact<RetiredFolder[]>('retired', 'readonly', (open, answer) => {
        const request = open('retired').getAll();
        request.onsuccess = () => {
          const rows: unknown[] = request.result;
          answer(rows.flatMap((r) => asRetired(r) ?? []));
        };
      }),

    doneRetired: (id, documentIds) =>
      transact<void>('retired', 'readwrite', (open) => {
        const store = open('retired');
        const request = store.get(id);
        request.onsuccess = () => {
          const cur = asRetired(request.result);
          if (cur === null) return;
          const done = new Set(documentIds);
          const scrubs = cur.scrubs.filter((p) => !done.has(p.documentId));
          if (scrubs.length === 0) store.delete(id);
          else store.put({ ...cur, scrubs });
        };
      }),

    expireScrubs: (before) =>
      transact<{ folderName: string; count: number }[]>(['scrub', 'retired'], 'readwrite', (open, answer) => {
        const dropped: { folderName: string; count: number }[] = [];
        answer(dropped);
        const queue = open('scrub');
        const all = queue.getAll();
        all.onsuccess = () => {
          for (const r of all.result as unknown[]) {
            if (isRecord(r) && typeof r.documentId === 'string' && (typeof r.requestedAt !== 'number' || r.requestedAt < before)) queue.delete(r.documentId);
          }
        };
        const retired = open('retired');
        const folders = retired.getAll();
        folders.onsuccess = () => {
          for (const raw of folders.result as unknown[]) {
            const cur = asRetired(raw);
            if (cur === null) continue;
            const kept = cur.scrubs.filter((p) => p.requestedAt >= before);
            if (kept.length === cur.scrubs.length) continue;
            dropped.push({ folderName: cur.target.name, count: cur.scrubs.length - kept.length });
            if (kept.length === 0) retired.delete(cur.id);
            else retired.put({ ...cur, scrubs: kept });
          }
        };
      }),

    setRetiredTarget: (id, target) =>
      transact<void>('retired', 'readwrite', (open) => {
        const store = open('retired');
        const request = store.get(id);
        request.onsuccess = () => {
          const cur = asRetired(request.result);
          if (cur !== null) store.put({ ...cur, target });
        };
      }),

    close() {
      void opening?.then((db) => db.close());
      opening = undefined;
    },
  };
}
