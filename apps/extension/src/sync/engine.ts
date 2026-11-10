// The sync engine's home in the extension (CL11): the offscreen document (entrypoints/offscreen/main.ts starts it). The engine itself
// is the shared one (`@sop/core/sync-client`, engine.ts), so the Android app and the web library run the same rules. This file only
// plugs it in: the store over a port to the store worker, the PDF copies (blobs.ts), the connection (client.ts), and when to run:
//   - when the offscreen document starts (the browser started, or a page opened the library);
//   - after a change the owner made (debounced: 5 s after the last one; page text 60 s);
//   - when the computer comes back online;
//   - when the service worker says so (the 5-minute alarm, the browser starting, right after Connect: scheduler.ts).
// With no server connected, each of these asks the service worker one question by message and stops: no request leaves (R110).
import { createSyncEngine, type SyncEngine } from '@sop/core/sync-client';
import { CHANGES_CHANNEL, isStoreChange } from '../store/change-bus';
import { createStoreClient } from '../store/client';
import { STORE_PORT, type StorePortMessage } from '../store/transport';
import { extensionFiles } from './blobs';
import { extensionConnection } from './client';
import { createStatusAnnouncer, SYNC_RUN_MESSAGE } from './status';

const EDIT_DELAY_MS = 5_000;
const TEXT_DELAY_MS = 60_000;
const START_DELAY_MS = 3_000;
const RECOUNT_DELAY_MS = 500;
/** The store answers a sync call in this long, or the round stops (a long pull page on a slow computer). */
const STORE_TIMEOUT_MS = 120_000;

/** Tables whose changes leave with a push. Page text leaves too, later and in bulk. */
const PUSHED: ReadonlySet<string> = new Set(['documents', 'aliases', 'locations', 'history', 'marks', 'threads', 'comments', 'settings', 'tags', 'reading_tags', 'auto_tag_removed']);

export function startSyncHost(storeWorker: Worker): SyncEngine {
  const store = createStoreClient(() => {
    const { port1, port2 } = new MessageChannel();
    const toStore: StorePortMessage = { type: STORE_PORT };
    storeWorker.postMessage(toStore, [port2]);
    return Promise.resolve(port1);
  }, STORE_TIMEOUT_MS);
  const status = createStatusAnnouncer();
  const engine = createSyncEngine({
    store,
    files: extensionFiles(),
    connection: extensionConnection,
    deviceName: 'Chrome',
    onStatus: (s) => status.announce(s),
  });
  status.onAsk(() => engine.status());

  // The owner's edits: changes written by sync or a restore are not the owner's, and never start a round
  const changes = new BroadcastChannel(CHANGES_CHANNEL);
  let recount: ReturnType<typeof setTimeout> | null = null;
  changes.onmessage = (e: MessageEvent) => {
    if (!isStoreChange(e.data) || e.data.origin === 'sync' || e.data.origin === 'restore') return;
    if (PUSHED.has(e.data.table)) engine.kick(EDIT_DELAY_MS);
    else if (e.data.table === 'page_text') engine.kick(TEXT_DELAY_MS);
    else return;
    // the count moves at once, even while offline (no round runs then)
    if (recount === null) recount = setTimeout(() => {
      recount = null;
      void engine.recount();
    }, RECOUNT_DELAY_MS);
  };
  addEventListener('online', () => engine.kick(0));
  chrome.runtime.onMessage.addListener((m: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || (m as { type?: unknown } | null)?.type !== SYNC_RUN_MESSAGE) return false;
    engine.kick(0);
    return false;
  });
  engine.kick(START_DELAY_MS);
  return engine;
}
