// The web library's sync engine: it keeps this tab's copy of the library in step with the owner's cloud, with the same sync
// round as the extension and the phone app (`runSyncRound` from @sop/core/sync-client: push what is queued, then pull to the
// head). It signs in with the page's session cookie, never a token.
//
// When it runs: once at the start (the whole library comes down), a moment after every change made here, every 20 seconds
// while the page is in view (so a note made on the phone or in Chrome shows within about half a minute), when the browser comes
// back online, and when the page comes back into view.
//
// What the page is told (`SyncStatus`), in the words the top bar shows: "Saving…", "Saved", "Offline, not saved".
// While a change is not in the cloud yet, closing the tab asks first.
import { createSyncClient, runSyncRound, SyncHttpError } from '@sop/core/sync-client';
import type { StoreClient } from '@ext/store/client';
import { goToSignIn, ownFetch } from './api';

export type SyncState = 'loading' | 'saving' | 'saved' | 'offline' | 'busy' | 'refused';

export interface SyncStatus {
  state: SyncState;
  /** Changes made here that the cloud does not have yet. */
  unsynced: number;
  /** When the last round finished well (Unix ms), or null. */
  lastSyncedAt: number | null;
}

const EVERY_MS = 20_000;
const AFTER_CHANGE_MS = 300;

export interface WebSync {
  /** The first round: the library is filled from the cloud. Rejects when the cloud could not be reached. */
  ready: Promise<void>;
  status(): SyncStatus;
  subscribe(cb: () => void): () => void;
  /** Runs a round soon (after a change). */
  kick(): void;
  /** Runs a round now ("Try again"). */
  now(): Promise<void>;
}

export function startWebSync(store: StoreClient): WebSync {
  const client = createSyncClient({ server: location.origin, token: () => Promise.resolve('cookie-session'), fetch: ownFetch });
  let status: SyncStatus = { state: 'loading', unsynced: 0, lastSyncedAt: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<SyncStatus>) => {
    status = { ...status, ...next };
    for (const l of [...listeners]) l();
  };

  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let registered = false;
  /**
   * Readings forgotten in this tab ("Forget this PDF", "Delete forever"): the cloud forgets them too, with their PDF, text and
   * notes (D2), at the start of the next round. Kept until the cloud says so, and counted as not saved until then.
   */
  const forgetting = new Set<string>();

  async function round(): Promise<void> {
    const before = await store.unsyncedCount().catch(() => 0);
    if (status.state !== 'loading') set({ state: before > 0 ? 'saving' : status.state === 'saved' ? 'saved' : status.state, unsynced: before });
    try {
      if (!registered) {
        await client.registerDevice({});
        registered = true;
      }
      for (const sha of [...forgetting]) {
        await client.forget(sha);
        forgetting.delete(sha);
      }
      await runSyncRound(store, client);
      const unsynced = (await store.unsyncedCount().catch(() => 0)) + forgetting.size;
      set({ state: unsynced > 0 ? 'saving' : 'saved', unsynced, lastSyncedAt: Date.now() });
      // A batch waited on its reading: once more, but only while rounds still make progress (a PDF or its page text being
      // uploaded counts as not saved yet, and must not start a round every moment until it is done).
      if (unsynced > 0 && unsynced < before) again = true;
    } catch (e) {
      const unsynced = await store.unsyncedCount().catch(() => status.unsynced);
      if (e instanceof SyncHttpError) {
        if (e.failure === 'signed-out') {
          goToSignIn();
          return;
        }
        if (e.failure === 'device') registered = false;
        set({ state: e.failure === 'offline' ? 'offline' : e.failure === 'refused' ? 'refused' : 'busy', unsynced });
      } else {
        console.error('sickofpdfs: a sync round failed', e instanceof Error ? e.message : 'unknown');
        set({ state: 'busy', unsynced });
      }
      throw e;
    }
  }

  /** One round at a time; a request during a round runs one more after it. */
  function run(): Promise<void> {
    if (running !== null) {
      again = true;
      return running;
    }
    running = round().finally(() => {
      running = null;
      if (again) {
        again = false;
        schedule(AFTER_CHANGE_MS);
      }
    });
    return running;
  }

  function schedule(ms: number): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run().catch(() => {});
    }, ms);
  }

  // A change made in this tab (not one the sync itself applied): send it.
  store.onChange((c) => {
    if (c.origin === 'sync') return;
    if (c.table === 'documents' && c.op === 'delete') for (const id of c.ids) if (/^[0-9a-f]{64}$/.test(id)) forgetting.add(id);
    set({ unsynced: status.unsynced + 1, state: status.state === 'loading' ? 'loading' : 'saving' });
    schedule(AFTER_CHANGE_MS);
  });

  const ready = run();
  ready.catch(() => {});

  setInterval(() => {
    if (document.visibilityState === 'visible') void run().catch(() => {});
  }, EVERY_MS);
  addEventListener('online', () => schedule(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(0);
  });
  // A change the cloud does not have yet: the browser asks before the tab closes.
  addEventListener('beforeunload', (e) => {
    if (status.unsynced > 0) e.preventDefault();
  });

  return {
    ready,
    status: () => status,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    kick: () => schedule(0),
    now: run,
  };
}

let current: { store: StoreClient; sync: WebSync } | null = null;

export function setWebLibrary(v: { store: StoreClient; sync: WebSync }): void {
  current = v;
}

/** This tab's store and sync engine, once the library has started. */
export function webLibrary(): { store: StoreClient; sync: WebSync } {
  if (current === null) throw new Error('the web library has not started');
  return current;
}
