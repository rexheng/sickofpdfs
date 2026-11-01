// The offscreen document: a hidden page the service worker creates (background/offscreen.ts). It owns the local store:
// it starts the store worker (SQLite on OPFS) and hands it every store port the service worker brokers.
import { isMessageOf, STORE_PORT, type StorePortMessage } from '../../store/transport';

const worker = new Worker(new URL('../../store/store-worker.ts', import.meta.url), { type: 'module', name: 'sop-store' });
worker.onerror = (e) => console.error('sickofpdfs: the store worker failed', e.message);

navigator.serviceWorker.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (!isMessageOf<StorePortMessage>(e.data, STORE_PORT) || !port) return;
  const message: StorePortMessage = { type: STORE_PORT };
  worker.postMessage(message, [port]);
};
