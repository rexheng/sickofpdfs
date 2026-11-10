// The web library's store worker: the extension's store (apps/extension/src/store), with the database in this tab's memory.
//
// The web library is a sync client like the extension and the phone app. Each tab fills its copy from the cloud (the sync
// API's pull) and sends its changes back (push), so the library's pages, notes and tags work exactly as they do in Chrome.
// Nothing is written to this computer's disk: the web library is meant to work on any computer, a borrowed one included, and a
// closed tab leaves no copy of the library behind. A change is sent at once; until the cloud has it, the page says so and asks
// before the tab is closed (sync/engine.ts).
//
// Not here, on purpose: the daily Trash purge (the cloud runs it for every device) and saved PDF files (there are none).
// It never imports the secrets store (ruling R14).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Hlc } from '@sop/core';
import { createChangePublisher } from '@ext/store/change-bus';
import { ensureDeviceId } from '@ext/store/device-id';
import { migrate } from '@ext/store/migrate';
import { createStoreServer } from '@ext/store/protocol';
import { createStoreApi, type StoreApi } from '@ext/store/store-api';
import { isMessageOf, STORE_PORT, type StorePortMessage } from '@ext/store/transport';

async function openStore(): Promise<StoreApi> {
  (globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  migrate(db);
  const hlc = new Hlc(await ensureDeviceId());
  const changes = createChangePublisher();
  const nothing = () => Promise.resolve();
  return createStoreApi(db, { now: () => Date.now(), hlc, publish: (c) => changes.publish(c), deleteBlob: nothing, deleteThumbnail: nothing });
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

self.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (isMessageOf<StorePortMessage>(e.data, STORE_PORT) && port) server.attach(port);
};

getApi().catch(() => {});
