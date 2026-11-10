// What every store worker does, wherever it runs: become the one owner of the library database, start SQLite, open the
// database, bring it to the newest schema (migrate.ts, schema v9 and on, with the sync side), and serve every port one
// request at a time. The extension's store worker (store-worker.ts, started by the offscreen document) and the phone app's
// (apps/mobile/src/platform/store-worker.ts, started by each page) both call `serveStore`; only how the database file is
// opened differs, so a change to the store reaches both.
//
// It never imports the secrets store (ruling R14): the database, backups and sync must never be able to read a secret.
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { type DocumentId, Hlc } from '@sop/core';
import { type BlobStore, openBlobStore } from './blob-store';
import { createChangePublisher } from './change-bus';
import { ensureDeviceId } from './device-id';
import { migrate } from './migrate';
import { createStoreServer } from './protocol';
import { createStoreApi, type StoreApi } from './store-api';
import { deleteThumbnailFile } from './thumbnail-files';
import { startDailyPurge } from './trash-purge';
import { DB_DIRECTORY, isMessageOf, STORE_OWNER_LOCK, STORE_PORT, type StorePortMessage } from './transport';

/** How long a new worker waits for the previous owner to go (say, while an old offscreen document is still closing). */
const OWNER_WAIT_MS = 15_000;
/** The OPFS files can stay locked for a moment after the previous owner went away: try again for this long. */
const POOL_RETRY_MS = 8_000;
const POOL_RETRY_STEP_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

/** Every table whose rows carry an HLC stamp (schema v1; the tag tables are v5). */
const STAMPED_TABLES = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings', 'tags', 'reading_tags', 'auto_tag_removed', 'outbox'];

/** The newest HLC stamp on any row: the clock's floor after a restart. */
function newestStampSql(): string {
  return `SELECT MAX(hlc) FROM (${STAMPED_TABLES.map((t) => `SELECT MAX(hlc) AS hlc FROM ${t}`).join(' UNION ALL ')})`;
}

let ownerLock: Promise<void> | null = null;

/** Waits until this worker is the only owner (the STORE_OWNER_LOCK Web Lock), then holds that until it ends. */
function becomeOwner(): Promise<void> {
  ownerLock ??= new Promise<void>((resolve, reject) => {
    navigator.locks
      .request(STORE_OWNER_LOCK, { signal: AbortSignal.timeout(OWNER_WAIT_MS) }, () => {
        resolve();
        return new Promise<never>(() => {}); // never released: the browser frees it when this worker ends
      })
      .catch((e: unknown) => {
        ownerLock = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
  return ownerLock;
}

/**
 * Opens SQLite's OPFS SAH pool, where the library lives. A start fails while the files are still held by the previous
 * owner; it is tried again for a while. `giveUp` says which failures are final at once (the app: "OPFS is not there").
 */
export async function openPool(sqlite3: Sqlite3, giveUp: (e: unknown) => boolean = () => false) {
  const options = {
    name: 'sop',
    directory: DB_DIRECTORY,
    initialCapacity: 8,
    // Data safety: by default a failed start DELETES the pool's directory. A start fails when the files are still held by
    // the previous owner, and must then leave every file where it is and be tried again.
    preserveOnInitFailure: true,
    forceReinitIfPreviouslyFailed: true,
  };
  const deadline = Date.now() + POOL_RETRY_MS;
  for (;;) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs(options);
    } catch (e) {
      if (giveUp(e) || Date.now() > deadline) throw e;
      await sleep(POOL_RETRY_STEP_MS);
    }
  }
}

/** The database a store worker opened, and what it adds round the store. */
export interface OpenedDatabase {
  db: Database;
  /** Runs once the schema is migrated, before the first answer (the app's fallback writes its copy to disk then). */
  afterMigrate?(): Promise<void>;
  /** Wraps the store (the app's fallback copies each write to disk before it answers). */
  wrap?(api: StoreApi): StoreApi;
}

let blobs: Promise<BlobStore> | null = null;

/**
 * Removes every file kept for a document: its saved PDF and its library thumbnail (ruling R76). The blob store is opened
 * the first time a purge needs it.
 */
async function deleteBlob(id: DocumentId): Promise<void> {
  blobs ??= openBlobStore().catch((e: unknown) => {
    blobs = null; // tried again at the next purge
    throw e;
  });
  await (await blobs).delete(id);
  await deleteThumbnailFile(id);
}

/**
 * Serves the library store from this worker: every port posted to it (STORE_PORT) is answered, one request at a time,
 * and Trash is emptied once a day. `open` opens the database file; it runs once this worker owns the store.
 */
export function serveStore(open: (sqlite3: Sqlite3) => Promise<OpenedDatabase>): void {
  async function openStore(): Promise<StoreApi> {
    await becomeOwner();
    // The extension pages are cross-origin isolated (for the OCR threads), so SharedArrayBuffer exists there. SQLite would
    // then also start its "opfs" and "opfs-wl" file systems, each with a worker of its own. The library uses only the SAH
    // pool (openPool), so those two stay off and the store starts as it always has.
    (globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
    const sqlite3 = await sqlite3InitModule();
    const opened = await open(sqlite3);
    const { db } = opened;
    migrate(db);
    await opened.afterMigrate?.();
    const hlc = new Hlc(await ensureDeviceId());
    // Keep stamps going up across restarts even if the wall clock went back: start past the newest stamp written. TB2
    // finding 8: the newest one on any synced row, not only in the outbox, which sync empties from Release 2 on (and a
    // draft's stamp can be newer than the outbox's). Stamps sort as text: 13 digits of ms, then the counter.
    const newest = db.selectValue(newestStampSql());
    if (typeof newest === 'string') hlc.receive(newest);
    const changes = createChangePublisher();
    const api = createStoreApi(db, { now: () => Date.now(), hlc, publish: (c) => changes.publish(c), deleteBlob, deleteThumbnail: deleteThumbnailFile });
    return opened.wrap?.(api) ?? api;
  }

  let opening: Promise<StoreApi> | null = null;

  /** The open store. A failed open is tried again by the next request. */
  function getApi(): Promise<StoreApi> {
    opening ??= openStore().catch((e: unknown) => {
      opening = null;
      const reason = e instanceof Error ? e.message : String(e);
      console.error('sickofpdfs: the library database could not be opened', reason);
      throw new Error(`store-unavailable: ${reason}`);
    });
    return opening;
  }

  const server = createStoreServer(getApi);

  // Trash is emptied once the store has started and then once a day. It goes through the server's own queue, like any request.
  startDailyPurge(server);

  self.onmessage = (e: MessageEvent) => {
    const port = e.ports[0];
    if (isMessageOf<StorePortMessage>(e.data, STORE_PORT) && port) server.attach(port);
  };

  // Open at once, so the first request does not wait for SQLite to start.
  getApi().catch(() => {});
}
