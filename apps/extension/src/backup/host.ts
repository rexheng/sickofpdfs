// The offscreen document's side of the backup: it starts the backup worker, gives it ports to the store worker, and sends the
// badge message (a worker has no `chrome.*`). All of the backup itself runs in the worker (worker.ts, controller.ts).
import { STORE_PORT, type StorePortMessage } from '../store/transport';
import { announceBackupBadge } from './badge';
import { isHostMessage, WORKER_BADGE, WORKER_PORT, WORKER_PORT_REQUEST } from './host-protocol';

export function startBackupHost(storeWorker: Worker): Worker {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'sop-backup' });
  worker.onerror = (e) => console.error('sickofpdfs: the backup worker failed', e.message);
  worker.onmessage = (e: MessageEvent) => {
    if (isHostMessage(e.data, WORKER_PORT_REQUEST)) {
      // A new channel: one end goes to the store worker, the other to the backup worker.
      const { port1, port2 } = new MessageChannel();
      const toStore: StorePortMessage = { type: STORE_PORT };
      storeWorker.postMessage(toStore, [port2]);
      worker.postMessage({ type: WORKER_PORT }, [port1]);
    } else if (isHostMessage(e.data, WORKER_BADGE)) {
      announceBackupBadge((e.data as { waiting?: unknown }).waiting === true);
    }
  };
  return worker;
}
