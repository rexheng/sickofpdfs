// The backup worker: a module worker the offscreen document starts (host.ts). It runs the backup controller (controller.ts) on a thread of
// its own, so nothing the backup does can delay a viewer tab. A worker has no `chrome.*`: what needs it (the badge) goes through
// the offscreen document, and the port to the store worker comes from there too.
import { startBackupController } from './controller';
import { isHostMessage, WORKER_BADGE, WORKER_PORT, WORKER_PORT_REQUEST } from './host-protocol';

const waiting: ((port: MessagePort) => void)[] = [];

startBackupController({
  openStorePort: () =>
    new Promise<MessagePort>((resolve) => {
      waiting.push(resolve);
      self.postMessage({ type: WORKER_PORT_REQUEST });
    }),
  announceBadge: (on) => self.postMessage({ type: WORKER_BADGE, waiting: on }),
});

self.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (isHostMessage(e.data, WORKER_PORT) && port) waiting.shift()?.(port);
};
