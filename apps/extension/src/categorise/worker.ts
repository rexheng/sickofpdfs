// The categoriser worker: a module worker the offscreen document starts (host.ts). It runs the controller (controller.ts) on a thread of
// its own. A worker has no `chrome.*`; the port to the store worker comes from the offscreen document.
import { startCategoriseController } from './controller';
import { isHostMessage, WORKER_IDLE, WORKER_PORT, WORKER_PORT_REQUEST } from './host-protocol';

const waiting: ((port: MessagePort) => void)[] = [];

startCategoriseController({
  openStorePort: () =>
    new Promise<MessagePort>((resolve) => {
      waiting.push(resolve);
      self.postMessage({ type: WORKER_PORT_REQUEST });
    }),
  // The model and the runtime are files of the extension: the folder is this worker's own origin.
  assetBase: `${self.location.origin}/`,
  // Nothing to do: the controller has stopped; the offscreen document ends this worker, so its memory is given back.
  onIdle: () => self.postMessage({ type: WORKER_IDLE, at: Date.now() }),
});

self.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (isHostMessage(e.data, WORKER_PORT) && port) waiting.shift()?.(port);
};
