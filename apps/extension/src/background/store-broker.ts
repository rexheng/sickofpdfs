// The service worker's part of the store transport: it hands a page's port to the offscreen document, which hands it to
// the store worker. Only the extension's own pages can post to its service worker, so only they reach the store.
// This file never imports the secrets store (ruling R14).
import { isMessageOf, OFFSCREEN_PATH, STORE_CONNECT, STORE_ERROR, STORE_PORT, type StoreBrokerError, type StoreConnectMessage, type StorePortMessage } from '../store/transport';
import { ensureOffscreen } from './offscreen';

// The DOM library has no service worker types; these are the few parts used here.
interface SwClient {
  url: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}
interface SwMessageEvent extends MessageEvent {
  waitUntil(p: Promise<unknown>): void;
}
interface SwScope {
  addEventListener(type: 'message', listener: (e: SwMessageEvent) => void): void;
  clients: { matchAll(o: { includeUncontrolled: boolean; type: 'all' }): Promise<readonly SwClient[]> };
}

const sw = globalThis as unknown as SwScope;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The offscreen document among the service worker's clients. Right after it is created it can take a moment to show. */
async function findOffscreen(): Promise<SwClient | null> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  for (let i = 0; i < 20; i++) {
    const found = (await sw.clients.matchAll({ includeUncontrolled: true, type: 'all' })).find((c) => c.url.split(/[?#]/)[0] === url);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

async function handOn(port: MessagePort): Promise<void> {
  try {
    // In Incognito the extension only views PDFs: there is no library, so no database is ever opened there.
    if (chrome.extension.inIncognitoContext) throw new Error('incognito: there is no library in an Incognito window');
    for (let attempt = 0; attempt < 2; attempt++) {
      await ensureOffscreen();
      const offscreen = await findOffscreen();
      if (offscreen) {
        const message: StorePortMessage = { type: STORE_PORT };
        offscreen.postMessage(message, [port]);
        return;
      }
    }
    throw new Error('the offscreen document did not start');
  } catch (error) {
    const message: StoreBrokerError = { type: STORE_ERROR, message: `store-unavailable: ${error instanceof Error ? error.message : String(error)}` };
    port.postMessage(message);
    port.close();
  }
}

/** Listens for `{ type: 'store:connect' }` with a port. Register it synchronously when the service worker starts. */
export function installStoreBroker(): void {
  sw.addEventListener('message', (e) => {
    const port = e.ports[0];
    if (!isMessageOf<StoreConnectMessage>(e.data, STORE_CONNECT) || !port) return;
    e.waitUntil(handOn(port));
  });
}
