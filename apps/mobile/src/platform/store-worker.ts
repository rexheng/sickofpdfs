// The app's store worker: the extension's store (apps/extension/src/store/store-host.ts, the same code the extension's store
// worker runs, schema v9 and its sync side included), started by each page of the app instead of by an offscreen document.
// Each page has its own: the app shows one page at a time, and the Web Lock `sop-store-owner` lets a new page's worker in
// only once the last page's worker has gone.
//
// Only how the database file is opened is the app's own. Storage, chosen once per phone and remembered (STORAGE_MODE_KEY):
// - "opfs": SQLite in the phone's private file storage (the SAH pool), exactly as the extension keeps it. Used whenever this
//   WebView has OPFS sync access handles (Android System WebView 109 and later).
// - "idb": the fallback for a WebView without them. The database lives in memory and every write is copied whole into
//   IndexedDB before the store answers it, so a write the viewer was told is done is on disk. Slower, but nothing is lost.
// A mode is never switched on its own once chosen (a busy OPFS file is waited for, never taken as "no OPFS"), so the library is
// never split between the two.
//
// It never imports the secrets store (ruling R14).
import type { Database } from '@sqlite.org/sqlite-wasm';
import { type OpenedDatabase, openPool, serveStore, type Sqlite3 } from '@ext/store/store-host';
import type { StoreApi } from '@ext/store/store-api';
import { DB_FILE } from '@ext/store/transport';
import { idbGet, idbPut } from './idb';
import { STORAGE_MODE_KEY, type StorageMode } from './storage-mode';

/** The fallback database's bytes in IndexedDB (idb.ts, store "files"). */
const SNAPSHOT_KEY = 'library.sqlite3';

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

/** The fallback database, with its copy to disk after the migration and after every write. */
async function snapshotStore(sqlite3: Sqlite3): Promise<OpenedDatabase> {
  const { db, save } = await openSnapshotDb(sqlite3);
  return {
    db,
    afterMigrate: async () => {
      await save(); // the migrated schema is on disk before the first answer
      await idbPut(STORAGE_MODE_KEY, 'idb');
      console.info('sickofpdfs: the library is stored in IndexedDB (fallback)');
    },
    wrap: (api) => persistAfterWrites(api, db, sqlite3, save),
  };
}

serveStore(async (sqlite3) => {
  if ((await chooseMode()) === 'idb') return snapshotStore(sqlite3);
  try {
    const pool = await openPool(sqlite3, isUnsupported);
    const db = new pool.OpfsSAHPoolDb(DB_FILE);
    return {
      db,
      afterMigrate: async () => {
        await idbPut(STORAGE_MODE_KEY, 'opfs');
        console.info('sickofpdfs: the library is stored in OPFS');
      },
    };
  } catch (e) {
    // Only on a phone that never used OPFS, and only when OPFS says it is not there: then the fallback starts empty.
    const remembered = await idbGet<StorageMode>(STORAGE_MODE_KEY).catch(() => undefined);
    if (remembered === 'opfs' || !isUnsupported(e)) throw e;
    return snapshotStore(sqlite3);
  }
});
