// The offscreen document's side of the categoriser: it starts the categoriser worker and gives it ports to the store worker. All of the
// categoriser itself runs in the worker (worker.ts, controller.ts), on a thread of its own, so nothing it does can hold up a viewer tab.
//
// The worker does not live for the whole browser session (TB5 code and security critic, finding 6: the model's runtime kept about 100 MB
// after the model was freed). When it has had nothing to do for a minute it says so and stops, and the host ends it. The host listens to
// the store's change events itself, and starts a new worker at the next change that matters (a reading, its first pages, the owner's
// tags). The new worker's back-fill finds what the old one had not done: every bit of the categoriser's state is in the store.
import { CHANGES_CHANNEL, isStoreChange } from '../store/change-bus';
import { STORE_PORT, type StorePortMessage } from '../store/transport';
import { mattersToCategoriser } from './changes';
import { isHostMessage, WORKER_IDLE, WORKER_PORT, WORKER_PORT_REQUEST } from './host-protocol';

/** A change that arrives this close before the worker said it was idle may not have reached it: the host starts it again to be sure. */
const IDLE_RACE_MS = 2000;

export interface CategoriseHost {
  /** Ends the worker and stops listening (the offscreen document is going). */
  close(): void;
}

export function startCategoriseHost(storeWorker: Worker): CategoriseHost {
  let worker: Worker | null = null;
  let lastChangeAt = 0;
  let closed = false;

  const start = (): void => {
    if (closed || worker !== null) return;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'sop-categorise' });
    worker = w;
    w.onerror = (e) => console.error('sickofpdfs: the categoriser worker failed', e.message);
    w.onmessage = (e: MessageEvent) => {
      if (isHostMessage(e.data, WORKER_IDLE)) {
        if (worker !== w) return;
        w.terminate();
        worker = null;
        const at = (e.data as { at?: unknown }).at;
        if (typeof at !== 'number' || lastChangeAt >= at - IDLE_RACE_MS) start();
        return;
      }
      if (!isHostMessage(e.data, WORKER_PORT_REQUEST)) return;
      // A new channel: one end goes to the store worker, the other to the categoriser worker.
      const { port1, port2 } = new MessageChannel();
      const toStore: StorePortMessage = { type: STORE_PORT };
      storeWorker.postMessage(toStore, [port2]);
      w.postMessage({ type: WORKER_PORT }, [port1]);
    };
  };

  const changes = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANGES_CHANNEL);
  if (changes !== null) {
    changes.onmessage = (e: MessageEvent) => {
      if (!isStoreChange(e.data) || !mattersToCategoriser(e.data)) return;
      lastChangeAt = Date.now();
      start(); // nothing happens while one runs: it hears the change itself
    };
  }

  start(); // the first back-fill after the browser starts
  return {
    close() {
      closed = true;
      changes?.close();
      worker?.terminate();
      worker = null;
    },
  };
}
