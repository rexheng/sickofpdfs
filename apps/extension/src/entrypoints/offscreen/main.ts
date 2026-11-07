// The offscreen document: a hidden page the service worker creates (background/offscreen.ts). It owns the local store:
// it starts the store worker (SQLite on OPFS) and hands it every store port the service worker brokers.
import { startBackupHost } from '../../backup/host';
import { startReindexHost } from '../../backup/reindex';
import { startCategoriseHost } from '../../categorise/host';
import { startLookupsHost } from '../../lookups/host';
import { startOcrHost } from '../../ocr/host';
import { isMessageOf, STORE_PORT, type StorePortMessage } from '../../store/transport';

const worker = new Worker(new URL('../../store/store-worker.ts', import.meta.url), { type: 'module', name: 'sop-store' });
worker.onerror = (e) => console.error('sickofpdfs: the store worker failed', e.message);

navigator.serviceWorker.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (!isMessageOf<StorePortMessage>(e.data, STORE_PORT) || !port) return;
  const message: StorePortMessage = { type: STORE_PORT };
  worker.postMessage(message, [port]);
};

// The backup runs in a worker of its own, started from here (backup/host.ts).
startBackupHost(worker);

// The auto categoriser runs in a worker of its own too (categorise/host.ts): the model, the codes, the topics. Local only.
startCategoriseHost(worker);

// Restored readings have their page text read again here, in the background, with a worker of its own (backup/reindex.ts).
startReindexHost(worker);

// The online lookups (arXiv, Crossref) are a queue here. It does nothing, and sends nothing, until the owner switches "Online lookups" on.
startLookupsHost(worker);

// Scanned pages of saved readings are read here, in the background, with a worker of its own (ocr/host.ts), so the reading goes
// on after the tab closes. Local only: the recogniser and its models are the extension's own files.
startOcrHost(worker);
