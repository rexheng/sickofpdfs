// IndexedDB `sop-handles` (contracts §5, Phase 3): the chosen backup folder, a small status record, what this computer has
// already written to that folder, and the forgotten readings whose copies in the folder are not removed yet.
//
// It sits next to `sop-device` and is "store side": it holds no secret, and this file never reaches the secrets store (the
// import boundary in eslint.config.mjs bars it). It is never backed up and never synced: a folder handle means nothing on
// another computer.
//
// Object stores (all out-of-line keys):
//   target  'backup'     StoredTarget: the folder handle (or, in test builds, an OPFS folder standing in for it)
//   status  'backup'     BackupStatus
//   known   'backup'     string[]: ids of the readings this computer wrote into the folder. It is what lets a run tell
//                        "removed here on purpose" from "never mine" (writer.ts: the guards).
//   scrub   <documentId> { documentId, requestedAt }: a forgotten reading. The copies are removed from the folder and from
//                        every snapshot (R75); the entry goes only when that is done, so a folder that is offline now is
//                        cleaned at the next run.
import { emptyStatus, type BackupStatus } from './status';

export const HANDLES_DB = 'sop-handles';
const DB_VERSION = 1;

/** The folder the owner chose. */
export interface FolderTarget {
  kind: 'folder';
  handle: FileSystemDirectoryHandle;
  /** The folder's name, for Settings. */
  name: string;
  pickedAt: number;
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

export interface HandleStore {
  getTarget(): Promise<StoredTarget | null>;
  setTarget(target: StoredTarget): Promise<void>;
  /** Forgets the folder, the status, what was written and the forgotten readings still to be removed there. Files already in the folder stay where they are. */
  clearTarget(): Promise<void>;
  getStatus(): Promise<BackupStatus>;
  /** Reads, changes and writes the status in one transaction, so a page and the offscreen document never overwrite each other. */
  updateStatus(change: (current: BackupStatus) => BackupStatus): Promise<BackupStatus>;
  getKnown(): Promise<Set<string>>;
  setKnown(ids: Iterable<string>): Promise<void>;
  addScrub(documentId: string, at: number): Promise<void>;
  listScrubs(): Promise<PendingScrub[]>;
  removeScrubs(documentIds: readonly string[]): Promise<void>;
  close(): void;
}

const KEY = 'backup';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLES_DB, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['target', 'status', 'known']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      if (!db.objectStoreNames.contains('scrub')) db.createObjectStore('scrub', { keyPath: 'documentId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The backup settings did not open.'));
    request.onblocked = () => reject(new Error('The backup settings are blocked by another tab.'));
  });
}

type StoreName = 'target' | 'status' | 'known' | 'scrub';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A stored target is read defensively: anything that is not one of the two shapes reads as "no folder". */
function asTarget(v: unknown): StoredTarget | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'folder' && isRecord(v.handle) && typeof v.name === 'string') {
    return { kind: 'folder', handle: v.handle as unknown as FileSystemDirectoryHandle, name: v.name, pickedAt: typeof v.pickedAt === 'number' ? v.pickedAt : 0 };
  }
  if (v.kind === 'test-opfs' && typeof v.folder === 'string' && typeof v.name === 'string') {
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

    clearTarget: () =>
      transact<void>(['target', 'status', 'known', 'scrub'], 'readwrite', (open) => {
        open('target').delete(KEY);
        open('status').delete(KEY);
        open('known').delete(KEY);
        // A folder that is no longer ours has nothing to be cleaned, and the forgotten readings' ids do not stay on this computer.
        open('scrub').clear();
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
      transact<Set<string>>('known', 'readonly', (open, answer) => {
        const request = open('known').get(KEY);
        request.onsuccess = () => {
          const v: unknown = request.result;
          answer(new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []));
        };
      }),

    setKnown: (ids) =>
      transact<void>('known', 'readwrite', (open) => {
        open('known').put([...ids], KEY);
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

    close() {
      void opening?.then((db) => db.close());
      opening = undefined;
    },
  };
}
