// The offscreen document's side of the categoriser: it starts the categoriser worker and gives it ports to the store worker. All of the
// categoriser itself runs in the worker (worker.ts, controller.ts), on a thread of its own, so nothing it does can hold up a viewer tab.
import { STORE_PORT, type StorePortMessage } from '../store/transport';
import { isHostMessage, WORKER_PORT, WORKER_PORT_REQUEST } from './host-protocol';

export function startCategoriseHost(storeWorker: Worker): Worker {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'sop-categorise' });
  worker.onerror = (e) => console.error('sickofpdfs: the categoriser worker failed', e.message);
  worker.onmessage = (e: MessageEvent) => {
    if (!isHostMessage(e.data, WORKER_PORT_REQUEST)) return;
    // A new channel: one end goes to the store worker, the other to the categoriser worker.
    const { port1, port2 } = new MessageChannel();
    const toStore: StorePortMessage = { type: STORE_PORT };
    storeWorker.postMessage(toStore, [port2]);
    worker.postMessage({ type: WORKER_PORT }, [port1]);
  };
  return worker;
}
