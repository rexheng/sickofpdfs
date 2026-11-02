// The offscreen document's side of the online lookups (S12): it starts the queue (queue.ts) and gives it ports to the store worker. The queue
// runs here, on the document's main thread, because reading arXiv's answer needs the XML parser, which a worker does not have.
import { STORE_PORT, type StorePortMessage } from '../store/transport';
import { startLookupQueue, type LookupQueue } from './queue';

export function startLookupsHost(storeWorker: Worker): LookupQueue {
  return startLookupQueue({
    openStorePort: () => {
      // A new channel: one end goes to the store worker, the other to the queue.
      const { port1, port2 } = new MessageChannel();
      const toStore: StorePortMessage = { type: STORE_PORT };
      storeWorker.postMessage(toStore, [port2]);
      return Promise.resolve(port1);
    },
  });
}
