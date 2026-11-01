// How a page reaches the store (STORE_TRANSPORT = sw-brokered-port, Phase 0 P0-6):
//
//   page          → service worker: postMessage({ type: 'store:connect' }, [port])
//   service worker → offscreen doc: postMessage({ type: 'store:port' }, [port])   after making sure the document exists
//   offscreen doc  → store worker:  postMessage({ type: 'store:port' }, [port])
//
// The page then talks to the store worker directly over that port; the service worker is not in the path. If the
// service worker cannot hand the port on, it answers { type: 'store:error', message } on the port.

/** The OPFS directory the SQLite pool lives in, and the database's name inside it. */
export const DB_DIRECTORY = '.sop-db';
export const DB_FILE = '/library.sqlite3';

/** The offscreen document's page, as built by WXT (src/entrypoints/offscreen/index.html). */
export const OFFSCREEN_PATH = 'offscreen.html';

/**
 * The Web Lock the store worker holds for its whole life. A second worker waits for it, and a page can tell from it whether
 * a store worker is alive.
 */
export const STORE_OWNER_LOCK = 'sop-store-owner';

export const STORE_CONNECT = 'store:connect';
export const STORE_PORT = 'store:port';
export const STORE_ERROR = 'store:error';

export interface StoreConnectMessage {
  type: typeof STORE_CONNECT;
}
export interface StorePortMessage {
  type: typeof STORE_PORT;
}
export interface StoreBrokerError {
  type: typeof STORE_ERROR;
  message: string;
}

export const isMessageOf = <T extends { type: string }>(x: unknown, type: T['type']): x is T =>
  typeof x === 'object' && x !== null && (x as { type?: unknown }).type === type;

/** A new port to the store, brokered by the extension's service worker. Requests can be posted on it at once. */
export async function openStorePort(): Promise<MessagePort> {
  const { port1, port2 } = new MessageChannel();
  const worker = (await navigator.serviceWorker.ready).active;
  if (!worker) {
    port1.close();
    throw new Error('store-unavailable: the extension has no active service worker');
  }
  const message: StoreConnectMessage = { type: STORE_CONNECT };
  worker.postMessage(message, [port2]);
  return port1;
}
