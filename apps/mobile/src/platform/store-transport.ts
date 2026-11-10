// The app's version of apps/extension/src/store/transport.ts (swapped in by vite.config.ts). Everything is the extension's,
// except how a page reaches the store: in Chrome the service worker hands a page's port to the offscreen document's store
// worker; in the app each page starts its own store worker (store-worker.ts) and hands it the port directly.
import { STORE_PORT, type StorePortMessage } from '@ext/store/transport';

export {
  DB_DIRECTORY,
  DB_FILE,
  isMessageOf,
  OFFSCREEN_PATH,
  STORE_CONNECT,
  STORE_ERROR,
  STORE_OWNER_LOCK,
  STORE_PORT,
  type StoreBrokerError,
  type StoreConnectMessage,
  type StorePortMessage,
} from '@ext/store/transport';

let worker: Worker | null = null;

/** This page's store worker, started the first time anything needs the store. */
export function storeWorker(): Worker {
  if (worker === null) {
    worker = new Worker(new URL('./store-worker.ts', import.meta.url), { type: 'module', name: 'sop-store' });
    worker.onerror = (e) => console.error('sickofpdfs: the store worker failed', e.message);
  }
  return worker;
}

/** A new port to the store. Requests can be posted on it at once. */
export function openStorePort(): Promise<MessagePort> {
  const { port1, port2 } = new MessageChannel();
  const message: StorePortMessage = { type: STORE_PORT };
  storeWorker().postMessage(message, [port2]);
  return Promise.resolve(port1);
}
