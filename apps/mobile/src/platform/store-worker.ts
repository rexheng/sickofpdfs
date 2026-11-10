// The app's store worker: the extension's store worker (apps/extension/src/store/store-worker.ts), started by each page of the app
// instead of by an offscreen document. Each page has its own: the app shows one page at a time, and the Web Lock
// `sop-store-owner` lets a new page's worker in only once the last page's worker has gone.
//
// Storage, chosen once per phone and remembered (STORAGE_MODE_KEY):
// - "opfs": SQLite in the phone's private file storage (the SAH pool), exactly as the extension keeps it. Used whenever this
//   WebView has OPFS sync access handles (Android System WebView 109 and later).
// - "idb": the fallback for a WebView without them. The database lives in memory and every write is copied whole into
//   IndexedDB before the store answers it, so a write the viewer was told is done is on disk. Slower, but nothing is lost.
// A mode is never switched on its own once chosen (a busy OPFS file is waited for, never taken as "no OPFS"), so the library is
// never split between the two.
//
// It never imports the secrets store (ruling R14).
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { type DocumentId, Hlc } from '@sop/core';
import { type BlobStore, openBlobStore } from '@ext/store/blob-store';
import { createChangePublisher } from '@ext/store/change-bus';
import { ensureDeviceId } from '@ext/store/device-id';
import { migrate } from '@ext/store/migrate';
import { createStoreServer } from '@ext/store/protocol';
import { createStoreApi, type StoreApi } from '@ext/store/store-api';
import { deleteThumbnailFile } from '@ext/store/thumbnail-files';
import { startDailyPurge } from '@ext/store/trash-purge';
import { DB_DIRECTORY, DB_FILE, isMessageOf, STORE_OWNER_LOCK, STORE_PORT, type StorePortMessage } from '@ext/store/transport';
import { idbGet, idbPut } from './idb';
import { STORAGE_MODE_KEY, type StorageMode } from './storage-mode';

/** How long a new worker waits for the previous page's worker to go. */
const OWNER_WAIT_MS = 15_000;
/** The OPFS files can stay locked for a moment after the previous owner went away: try again for this long. */
const POOL_RETRY_MS = 8_000;
const POOL_RETRY_STEP_MS = 150;
/** The fallback database's bytes in IndexedDB (idb.ts, store "files"). */
const SNAPSHOT_KEY = 'library.sqlite3';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const STAMPED_TABLES = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings', 'tags', 'reading_tags', 'auto_tag_removed', 'outbox'];
const newestStampSql = (): string => `SELECT MAX(hlc) FROM (${STAMPED_TABLES.map((t) => `SELECT MAX(hlc) AS hlc FROM ${t}`).join(' UNION ALL ')})`;

let ownerLock: Promise<void> | null = null;

function becomeOwner(): Promise<void> {
  ownerLock ??= new Promise<void>((resolve, reject) => {
    navigator.locks
      .request(STORE_OWNER_LOCK, { signal: AbortSignal.timeout(OWNER_WAIT_MS) }, () => {
        resolve();
        return new Promise<never>(() => {}); // held until this worker ends
      })
      .catch((e: unknown) => {
        ownerLock = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
  return ownerLock;
}

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

/** Does this WebView give workers OPFS sync access handles, which the SAH pool needs? */
function hasSyncAccessHandles(): boolean {
  return (
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof (FileSystemFileHandle.prototype as { createSyncAccessHandle?: unknown }).createSyncAccessHandle === 'function'
  );
}

/** A failure that means "OPFS is not there or not allowed", not "the files are busy". */
function isUnsupported(e: unknown): boolean {
  const name = e instanceof DOMException ? e.name : e instanceof Error ? e.name : '';
  return name === 'NotSupportedError' || name === 'SecurityError' || name === 'NotAllowedError' || name === 'TypeError';
}

async function openPool(sqlite3: Sqlite3) {
  const options = { name: 'sop', directory: DB_DIRECTORY, initialCapacity: 8, preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true };
  const deadline = Date.now() + POOL_RETRY_MS;
  for (;;) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs(options);
    } catch (e) {
      if (isUnsupported(e) || Date.now() > deadline) throw e;
      await sleep(POOL_RETRY_STEP_MS);
    }
  }
}

/** The fallback: the database in memory, loaded from (and written back to) IndexedDB. */
async function openSnapshotDb(sqlite3: Sqlite3): Promise<{ db: Database; save: () => Promise<void> }> {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const bytes = await idbGet<Uint8Array>(SNAPSHOT_KEY);
  if (bytes instanceof Uint8Array && bytes.byteLength > 0) {
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    db.checkRc(sqlite3.capi.sqlite3_deserialize(db.pointer!, 'main', p, bytes.byteLength, bytes.byteLength, flags));
  }
  const save = async () => {
    await idbPut(SNAPSHOT_KEY, sqlite3.capi.sqlite3_js_db_export(db));
  };
  return { db, save };
}

let blobs: Promise<BlobStore> | null = null;

async function deleteBlob(id: DocumentId): Promise<void> {
  blobs ??= openBlobStore().catch((e: unknown) => {
    blobs = null;
    throw e;
  });
  await (await blobs).delete(id);
  await deleteThumbnailFile(id);
}

/**
 * Wraps the store so that, in the fallback, every call that changed a row is written to IndexedDB before it answers. The server
 * runs one call at a time, so the copy always matches the answers given.
 */
function persistAfterWrites(api: StoreApi, db: Database, sqlite3: Sqlite3, save: () => Promise<void>): StoreApi {
  let saved = sqlite3.capi.sqlite3_total_changes(db.pointer!);
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const result: unknown = await (value as (...a: unknown[]) => unknown).apply(target, args);
        const now = sqlite3.capi.sqlite3_total_changes(db.pointer!);
        if (now !== saved) {
          await save();
          saved = now;
        }
        return result;
      };
    },
  });
}

async function chooseMode(): Promise<StorageMode> {
  const remembered = await idbGet<StorageMode>(STORAGE_MODE_KEY).catch(() => undefined);
  if (remembered === 'opfs' || remembered === 'idb') return remembered;
  return hasSyncAccessHandles() ? 'opfs' : 'idb';
}

async function openStore(): Promise<StoreApi> {
  await becomeOwner();
  (globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
  const sqlite3 = await sqlite3InitModule();
  let mode = await chooseMode();
  let db: Database;
  let save: (() => Promise<void>) | null = null;
  if (mode === 'opfs') {
    try {
      const pool = await openPool(sqlite3);
      db = new pool.OpfsSAHPoolDb(DB_FILE);
    } catch (e) {
      // Only on a phone that never used OPFS, and only when OPFS says it is not there: then the fallback starts empty.
      const remembered = await idbGet<StorageMode>(STORAGE_MODE_KEY).catch(() => undefined);
      if (remembered === 'opfs' || !isUnsupported(e)) throw e;
      mode = 'idb';
      const snap = await openSnapshotDb(sqlite3);
      db = snap.db;
      save = snap.save;
    }
  } else {
    const snap = await openSnapshotDb(sqlite3);
    db = snap.db;
    save = snap.save;
  }
  migrate(db);
  if (save !== null) await save(); // the migrated schema is on disk before the first answer
  await idbPut(STORAGE_MODE_KEY, mode);
  const hlc = new Hlc(await ensureDeviceId());
  const newest = db.selectValue(newestStampSql());
  if (typeof newest === 'string') hlc.receive(newest);
  const changes = createChangePublisher();
  const api = createStoreApi(db, { now: () => Date.now(), hlc, publish: (c) => changes.publish(c), deleteBlob, deleteThumbnail: deleteThumbnailFile });
  console.info(`sickofpdfs: the library is stored in ${mode === 'opfs' ? 'OPFS' : 'IndexedDB (fallback)'}`);
  return save === null ? api : persistAfterWrites(api, db, sqlite3, save);
}

let opening: Promise<StoreApi> | null = null;

function getApi(): Promise<StoreApi> {
  opening ??= openStore().catch((e: unknown) => {
    opening = null;
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error('sickofpdfs: the library database could not be opened', reason);
    throw new Error(`store-unavailable: ${reason}`);
  });
  return opening;
}

const server = createStoreServer(getApi);
startDailyPurge(server);

self.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (isMessageOf<StorePortMessage>(e.data, STORE_PORT) && port) server.attach(port);
};

getApi().catch(() => {});
