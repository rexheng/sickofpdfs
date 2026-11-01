import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

// The spike's service worker. Its presence is how the test fixtures know the extension loaded.
// P0-6: it brokers a MessagePort from a tab to the offscreen document.
//   tab → SW: postMessage({type:'connect-offscreen'}, [port])
//   SW → offscreen client: postMessage({type:'port'}, [port]), after making sure the document exists
// If that fails, the SW answers {type:'error', error} on the port, so the tab does not wait forever.

declare const self: ServiceWorkerGlobalScope;

const OFFSCREEN_PATH = 'offscreen.html';
let creating: Promise<void> | null = null;

/** Creates the offscreen document unless it exists; concurrent callers share one creation. */
async function ensureOffscreen(): Promise<void> {
  const existing = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  creating ??= browser.offscreen
    .createDocument({ url: OFFSCREEN_PATH, reasons: ['WORKERS'], justification: 'Receives large buffers from tabs (Phase 0 spike P0-6).' })
    .finally(() => (creating = null));
  await creating;
}

async function connectOffscreen(port: MessagePort): Promise<void> {
  try {
    await ensureOffscreen();
    const offscreen = (await self.clients.matchAll({ includeUncontrolled: true })).find((c) => c.url.endsWith(`/${OFFSCREEN_PATH}`));
    if (!offscreen) throw new Error('the offscreen document is not among the service worker clients');
    offscreen.postMessage({ type: 'port' }, [port]);
  } catch (err) {
    port.postMessage({ type: 'error', error: `connect-offscreen: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export default defineBackground(() => {
  self.addEventListener('message', (e) => {
    const port = e.ports[0];
    if (e.data?.type !== 'connect-offscreen' || !port) return;
    e.waitUntil(connectOffscreen(port));
  });
});
