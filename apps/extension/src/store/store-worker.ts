// The store worker: the one owner of the library database. The offscreen document starts it and hands it ports; it
// serves every port, one request at a time, and announces each committed change on the changes channel.
//
// It never imports the secrets store (ruling R14): the database, backups and sync must never be able to read a secret.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { type DocumentId, Hlc } from '@sop/core';
import { type BlobStore, openBlobStore } from './blob-store';
import { createChangePublisher } from './change-bus';
import { ensureDeviceId } from './device-id';
import { migrate } from './migrate';
import { createStoreServer } from './protocol';
import { createStoreApi, type StoreApi } from './store-api';
import { startDailyPurge } from './trash-purge';
import { DB_DIRECTORY, DB_FILE, isMessageOf, STORE_OWNER_LOCK, STORE_PORT, type StorePortMessage } from './transport';

/** How long a new worker waits for the previous owner to go (say, while an old offscreen document is still closing). */
const OWNER_WAIT_MS = 15_000;
/** The OPFS files can stay locked for a moment after the previous owner went away: try again for this long. */
const POOL_RETRY_MS = 8_000;
const POOL_RETRY_STEP_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every table whose rows carry an HLC stamp (schema v1). */
const STAMPED_TABLES = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings', 'outbox'];

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

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;

async function openPool(sqlite3: Sqlite3) {
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
      if (Date.now() > deadline) throw e;
      await sleep(POOL_RETRY_STEP_MS);
    }
  }
}

let blobs: Promise<BlobStore> | null = null;

/** Removes a document's saved PDF. The blob store is opened the first time a purge needs it. */
async function deleteBlob(id: DocumentId): Promise<void> {
  blobs ??= openBlobStore().catch((e: unknown) => {
    blobs = null; // tried again at the next purge
    throw e;
  });
  await (await blobs).delete(id);
}

async function openStore(): Promise<StoreApi> {
  await becomeOwner();
  const sqlite3 = await sqlite3InitModule();
  const pool = await openPool(sqlite3);
  const db = new pool.OpfsSAHPoolDb(DB_FILE);
  migrate(db);
  const hlc = new Hlc(await ensureDeviceId());
  // Keep stamps going up across restarts even if the wall clock went back: start past the newest stamp written. TB2
  // finding 8: the newest one on any synced row, not only in the outbox, which sync empties from Release 2 on (and a
  // draft's stamp can be newer than the outbox's). Stamps sort as text: 13 digits of ms, then the counter.
  const newest = db.selectValue(newestStampSql());
  if (typeof newest === 'string') hlc.receive(newest);
  const changes = createChangePublisher();
  return createStoreApi(db, { now: () => Date.now(), hlc, publish: (c) => changes.publish(c), deleteBlob });
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
