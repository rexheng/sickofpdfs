// The sync engine's home in the app (R109, R110). The engine is the shared one (`@sop/core/sync-client`), with the rules the
// extension and the web library run. This file only plugs it in, in the page on screen (the app has no service worker or
// offscreen document):
//   - the store: a second port to this page's own store worker;
//   - the PDF copies: the extension's sync/blobs.ts over the app's blob store (OPFS, or the IndexedDB fallback);
//   - the connection: cloud-broker.ts (null until the owner connects a server, and then nothing is ever sent);
//   - when to run: when a page starts, 5 s after an edit (page text 60 s), when the app comes back to the front, when the phone is
//     back online, every 5 minutes while the app is open, and at once after Connect or "Sync now".
// The status goes out on the same channel as in the extension, so the library's sync chip and Settings → Cloud read it with
// `useSyncStatus()`.
import { createSyncEngine, type SyncEngine } from '@sop/core/sync-client';
import { CHANGES_CHANNEL, isStoreChange } from '@ext/store/change-bus';
import { createStoreClient } from '@ext/store/client';
import { extensionFiles } from '@ext/sync/blobs';
import { createStatusAnnouncer, SYNC_KICK_MESSAGE, SYNC_RUN_MESSAGE } from '@ext/sync/status';
import { onAppMessage } from './chrome-shim';
import { cloudEvents, cloudMessageAnswer, connectionHere } from './cloud-broker';
import { isNativeApp, SopPlatform } from './native';
import { openStorePort } from './store-transport';

const EDIT_DELAY_MS = 5_000;
const TEXT_DELAY_MS = 60_000;
/** A page has just started: let it draw first. */
const START_DELAY_MS = 2_000;
const RECOUNT_DELAY_MS = 500;
const EVERY_MS = 5 * 60_000;
/** The store answers a sync call in this long, or the round stops (a long pull page on a slow phone). */
const STORE_TIMEOUT_MS = 120_000;

/** Tables whose changes leave with a push. Page text leaves too, later and in bulk. */
const PUSHED: ReadonlySet<string> = new Set(['documents', 'aliases', 'locations', 'history', 'marks', 'threads', 'comments', 'settings', 'tags', 'reading_tags', 'auto_tag_removed']);

let engine: SyncEngine | null = null;

/** Starts sync for this page. Call once, after the chrome shim. With no server connected, it sends nothing. */
export function startSync(): SyncEngine {
  if (engine !== null) return engine;
  // The extension's cloud messages (status, Forget) are answered here, in the page.
  onAppMessage(cloudMessageAnswer);
  const store = createStoreClient(openStorePort, STORE_TIMEOUT_MS);
  const status = createStatusAnnouncer();
  const e = createSyncEngine({
    store,
    files: extensionFiles(),
    connection: connectionHere,
    deviceName: 'Android',
    onStatus: (s) => status.announce(s),
  });
  engine = e;
  status.onAsk(() => e.status());

  // "Sync now" (the sync chip, Settings → Cloud): the extension sends it to its service worker; here the page runs the round.
  onAppMessage((m) => {
    const type = (m as { type?: unknown } | null)?.type;
    if (type !== SYNC_KICK_MESSAGE && type !== SYNC_RUN_MESSAGE) return undefined;
    e.kick(0);
    return Promise.resolve(undefined);
  });
  cloudEvents.addEventListener('changed', () => e.kick(0));

  // The owner's edits: changes written by sync or a restore are not the owner's, and never start a round
  const changes = new BroadcastChannel(CHANGES_CHANNEL);
  let recount: ReturnType<typeof setTimeout> | null = null;
  changes.onmessage = (ev: MessageEvent) => {
    if (!isStoreChange(ev.data) || ev.data.origin === 'sync' || ev.data.origin === 'restore') return;
    if (PUSHED.has(ev.data.table)) e.kick(EDIT_DELAY_MS);
    else if (ev.data.table === 'page_text') e.kick(TEXT_DELAY_MS);
    else return;
    // the count moves at once, even while offline (no round runs then)
    recount ??= setTimeout(() => {
      recount = null;
      void e.recount();
    }, RECOUNT_DELAY_MS);
  };
  addEventListener('online', () => e.kick(0));
  // Back to the front: from the browser, another app or the home screen
  if (isNativeApp()) void SopPlatform.addListener('resume', () => e.kick(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') e.kick(0);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') e.kick(0);
  }, EVERY_MS);
  e.kick(START_DELAY_MS);
  return e;
}
