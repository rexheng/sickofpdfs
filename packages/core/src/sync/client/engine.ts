// The sync engine (CL11): notes, page text and PDFs flow both ways in the background, resume after any interruption, and a fresh
// install restores the whole library. The same engine runs on every client with a local library: the extension's offscreen
// document today, the Android app and others later. Everything platform-specific is given to it:
//   - `store`: the local library's sync side (the extension's `SyncStoreApi`);
//   - `files`: where this device keeps its PDF copies (re-hashing what it writes);
//   - `connection()`: the server the owner connected and a token for it, or null. Null means no server is connected: then the
//     engine does nothing and sends nothing at all (R109, R110);
//   - `fetch`, timers and the clock.
// When to run is the platform's choice (an alarm, a change, coming back online): it calls `kick()`. The engine debounces, never
// runs two rounds at once, honours the server's `Retry-After`, and backs off while offline.
//
// One round:
//   1. register this device once (the id is kept in `deviceRegistered`);
//   2. push what is queued, then pull to the head (round.ts);
//   3. upload the PDFs the server asked for (if the owner allows PDF uploads, and not "keep local"), then page text that changed;
//   4. restore: download, two at a time, the PDFs and page text of readings the cloud holds and this device lacks;
//   5. report: "N not yet synced", and a state in plain words.
// Every step keeps what it finished: the queue, the cursor and what was uploaded live in the store, and the server remembers the
// parts of a big upload. A round cut off anywhere simply starts again.

import type { SyncStatus } from '../protocol';
import { createSyncClient, SyncHttpError, type SyncClient } from './http';
import { type LocalSyncStore, runSyncRound } from './round';
import { createTransfers, type TextPage, type Transfers } from './transfer';

/** What a restore should fill in for one reading. */
export interface RestoreItem {
  documentId: string;
  byteSize: number;
  blob: boolean;
  text: boolean;
}

/** What the engine needs of the local library, beyond a sync round. */
export interface EngineStore extends LocalSyncStore {
  setSyncState(key: string, value: string | null): Promise<void>;
  unsyncedCount(): Promise<number>;
  pendingBlobs(): Promise<string[]>;
  pendingText(): Promise<{ documentId: string; source: string }[]>;
  pendingRestore(): Promise<RestoreItem[]>;
  textForSync(id: string): Promise<{ extractor: string; source: string; pages: TextPage[] } | null>;
  putSyncedText(id: string, extractor: string, pages: readonly TextPage[], complete: boolean): Promise<void>;
  /** The PDF of this reading is kept here now (its hash was checked as it was written). */
  markCopyRestored(id: string): Promise<boolean>;
}

/** This device's PDF copies. */
export interface EngineFiles {
  get(sha: string): Promise<Blob | null>;
  /**
   * Writes a downloaded PDF, checking its SHA-256 as it goes. 'mismatch': the bytes were not that file, and nothing was kept.
   * Throws when the stream broke off (nothing is kept then either).
   */
  put(sha: string, body: ReadableStream<Uint8Array>): Promise<'ok' | 'mismatch'>;
}

export interface EngineConnection {
  server: string;
  /** A fresh access token; `refresh` asks for a new one even if the old one looks fine. Null: signed out. */
  token(refresh?: boolean): Promise<string | null>;
}

export interface EngineStatus extends SyncStatus {
  /** While a restore downloads: how many readings of how many are done. */
  restoring: { done: number; total: number } | null;
  /** True while page text waits for the server's daily limit (notes still sync). */
  textWaiting: boolean;
}

export interface SyncEngineOptions {
  store: EngineStore;
  files: EngineFiles;
  connection(): Promise<EngineConnection | null>;
  /** The name the owner sees for this device in the web library's Settings, such as "Chrome". */
  deviceName: string;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  onStatus?(s: EngineStatus): void;
}

export interface SyncEngine {
  /** Run a round soon: after `delayMs` (debounced: the earliest asked-for time wins), and never before the server allows. */
  kick(delayMs?: number): void;
  /** Run a round now (or join the one running) and answer the status after it. */
  run(): Promise<EngineStatus>;
  status(): EngineStatus;
  /** Counts "not yet synced" again (after a change made while no round runs, such as offline). Sends nothing. */
  recount(): Promise<void>;
  stop(): void;
}

/** Downloads run two at a time (plan CL11). */
const RESTORE_PARALLEL = 2;
/** While offline or the server is busy, the next try waits this long, doubling up to the cap. */
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

/** The words the owner sees, one per state (plain, short; CL12 shows them). */
export const SYNC_MESSAGES = {
  off: null,
  ok: null,
  syncing: 'Syncing…',
  offline: 'Offline. Your changes are saved on this computer and sync when you are back online.',
  busy: 'Your cloud is busy. Trying again soon.',
  signedOut: 'Sync has stopped: you are signed out of your cloud. Sign in again in Settings.',
  quota: 'Your cloud reached its daily limit. Sync starts again after midnight (UTC).',
  textWaiting: 'Page text waits for tomorrow. Your notes still sync.',
  stopped: 'Sync has stopped. Open Settings to see why.',
} as const;

const errorOf = (e: unknown): SyncHttpError | null => (e instanceof SyncHttpError ? e : null);

export function createSyncEngine(o: SyncEngineOptions): SyncEngine {
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms));
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let current: EngineStatus = { state: 'off', unsynced: 0, lastSyncAt: null, message: null, restoring: null, textWaiting: false };
  let running: Promise<EngineStatus> | null = null;
  let again = false;
  let timer: unknown = null;
  let timerAt = Infinity;
  let notBefore = 0;
  let textNotBefore = 0;
  let backoff = 0;
  let stopped = false;
  /** Files and texts that failed for a reason a retry in this session will not fix (they are tried again next session). */
  const skip = new Set<string>();

  const publish = (s: Partial<EngineStatus>) => {
    current = { ...current, ...s };
    try {
      o.onStatus?.(current);
    } catch {
      // a listener's problem is not the engine's
    }
  };

  function kick(delayMs = 0): void {
    if (stopped) return;
    const at = Math.max(now() + Math.max(0, delayMs), notBefore);
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimer(timer);
    timerAt = at;
    timer = setTimer(() => {
      timer = null;
      timerAt = Infinity;
      void run();
    }, at - now());
  }

  function run(): Promise<EngineStatus> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await round();
        } while (again && !stopped);
      } finally {
        running = null;
      }
      return current;
    })();
    return running;
  }

  /** The failure of a round, as a state the owner can read, and when to try again. */
  function failed(e: unknown): void {
    const h = errorOf(e);
    const wait = h?.retryAfterMs ?? null;
    if (h === null) {
      publish({ state: 'stopped', message: SYNC_MESSAGES.stopped, restoring: null });
      return;
    }
    switch (h.failure) {
      case 'offline':
      case 'busy':
      case 'rate-limited': {
        backoff = Math.min(BACKOFF_MAX_MS, backoff === 0 ? BACKOFF_FIRST_MS : backoff * 2);
        // Only the server's own Retry-After holds every round back; while offline, coming back online runs one at once
        notBefore = now() + (wait ?? 0);
        publish({ state: h.failure === 'offline' ? 'offline' : 'syncing', message: h.failure === 'offline' ? SYNC_MESSAGES.offline : SYNC_MESSAGES.busy, restoring: null });
        kick(Math.max(wait ?? 0, backoff));
        return;
      }
      case 'quota':
        notBefore = now() + (wait ?? 3_600_000);
        publish({ state: 'quota', message: SYNC_MESSAGES.quota, restoring: null });
        kick(wait ?? 3_600_000);
        return;
      case 'signed-out':
        publish({ state: 'signed-out', message: SYNC_MESSAGES.signedOut, restoring: null });
        return;
      default:
        publish({ state: 'stopped', message: h.message ? `Sync has stopped: ${h.message}` : SYNC_MESSAGES.stopped, restoring: null });
    }
  }

  async function round(): Promise<void> {
    const conn = await o.connection();
    if (conn === null) {
      // No server connected: nothing is sent, ever. The count still shows nothing waiting for a cloud that is not there.
      publish({ state: 'off', unsynced: 0, message: null, restoring: null, textWaiting: false });
      return;
    }
    publish({ state: 'syncing', message: SYNC_MESSAGES.syncing });
    let refreshed = false;
    const token = async () => conn.token(false);
    const client = createSyncClient({ server: conn.server, token, fetch: o.fetch });
    const transfers = createTransfers({ server: conn.server, token, fetch: o.fetch });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await syncOnce(client, transfers);
          break;
        } catch (e) {
          const h = errorOf(e);
          // An access token can die early (a revoked sign-in, a server restart): ask for a fresh one once
          if (h?.failure === 'signed-out' && !refreshed) {
            refreshed = true;
            if ((await conn.token(true)) !== null) continue;
          }
          // This sign-in has no device on the server (a new sign-in, a server reset): register again, once
          if (h?.failure === 'device' && attempt === 0) {
            await registered(client, true); // with the stored id, so this computer keeps its device
            continue;
          }
          throw e;
        }
      }
      backoff = 0;
      notBefore = 0;
      publish({ state: 'ok', message: now() < textNotBefore ? SYNC_MESSAGES.textWaiting : null, lastSyncAt: now(), textWaiting: now() < textNotBefore, restoring: null });
    } catch (e) {
      failed(e);
    }
    try {
      publish({ unsynced: await o.store.unsyncedCount() });
    } catch {
      // the store is busy or closing: the next round counts again
    }
  }

  async function registered(client: SyncClient, force = false): Promise<void> {
    const known = await o.store.getSyncState('deviceRegistered');
    if (known !== null && !force) return;
    const r = await client.registerDevice({ id: known, name: o.deviceName });
    await o.store.setSyncState('deviceRegistered', r.device);
  }

  async function syncOnce(client: SyncClient, t: Transfers): Promise<void> {
    await registered(client);
    await runSyncRound(o.store, client);
    publish({ unsynced: await o.store.unsyncedCount() });
    await uploadBlobs(t);
    await uploadText(t);
    await restore(t);
  }

  // ─── Up ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** For one file or text: a refusal that a retry will not fix skips it for this session; anything else stops the round. */
  function refusedOnly(e: unknown, key: string): void {
    const h = errorOf(e);
    if (h === null || h.failure !== 'refused') throw e;
    skip.add(key);
  }

  async function uploadBlobs(t: Transfers): Promise<void> {
    for (const id of await o.store.pendingBlobs()) {
      if (skip.has(`blob:${id}`)) continue;
      try {
        if ((await t.headBlob(id)) === null) {
          const file = await o.files.get(id);
          if (file === null) {
            skip.add(`blob:${id}`);
            continue;
          }
          await t.putBlob(id, file);
        }
        await o.store.setSyncState(`needBlob:${id}`, null);
        publish({ unsynced: await o.store.unsyncedCount() });
      } catch (e) {
        const h = errorOf(e);
        // gone from the cloud (forgotten, or not pushed): nothing to upload
        if (h?.failure === 'refused' && (h.status === 404 || h.status === 410)) {
          await o.store.setSyncState(`needBlob:${id}`, null);
          continue;
        }
        refusedOnly(e, `blob:${id}`);
      }
    }
  }

  async function uploadText(t: Transfers): Promise<void> {
    if (now() < textNotBefore) return;
    for (const p of await o.store.pendingText()) {
      if (skip.has(`text:${p.documentId}`)) continue;
      try {
        const text = await o.store.textForSync(p.documentId);
        if (text === null) continue;
        await t.putText(p.documentId, text.extractor, text.pages);
        await o.store.setSyncState(`textSent:${p.documentId}`, text.source);
      } catch (e) {
        const h = errorOf(e);
        if (h?.failure === 'quota' && h.lane === 'text') {
          // The daily meter: text waits, notes go on (they have their own reserve)
          textNotBefore = now() + (h.retryAfterMs ?? 3_600_000);
          publish({ textWaiting: true });
          return;
        }
        // The cloud keeps no text for this reading (CD2 or not indexed): it is done
        if (h?.failure === 'refused' && h.code === 'text_stays_local') {
          await o.store.setSyncState(`textSent:${p.documentId}`, p.source);
          continue;
        }
        refusedOnly(e, `text:${p.documentId}`);
      }
    }
  }

  // ─── Down: restore ──────────────────────────────────────────────────────────────────────────────────────────────────

  async function restore(t: Transfers): Promise<void> {
    const wants = (await o.store.pendingRestore()).filter((w) => (w.blob && !skip.has(`get:${w.documentId}`)) || (w.text && !skip.has(`gettext:${w.documentId}`)));
    if (wants.length === 0) return;
    let done = 0;
    publish({ restoring: { done, total: wants.length } });
    const queue = [...wants];
    const worker = async () => {
      for (let w = queue.shift(); w !== undefined; w = queue.shift()) {
        await restoreOne(t, w);
        done++;
        publish({ restoring: { done, total: wants.length } });
      }
    };
    await Promise.all(Array.from({ length: Math.min(RESTORE_PARALLEL, wants.length) }, worker));
    publish({ restoring: null });
  }

  async function restoreOne(t: Transfers, w: RestoreItem): Promise<void> {
    if (w.text && !skip.has(`gettext:${w.documentId}`)) {
      try {
        const found = await t.getText(w.documentId, (extractor, pages, complete) => o.store.putSyncedText(w.documentId, extractor, pages, complete));
        if (!found) skip.add(`gettext:${w.documentId}`);
      } catch (e) {
        refusedOnly(e, `gettext:${w.documentId}`);
      }
    }
    if (w.blob && !skip.has(`get:${w.documentId}`)) {
      try {
        const body = await t.getBlob(w.documentId);
        if (body === null) {
          skip.add(`get:${w.documentId}`); // the cloud has no copy (the PDF upload was off on the other computer)
          return;
        }
        let put: 'ok' | 'mismatch';
        try {
          put = await o.files.put(w.documentId, body);
        } catch (e) {
          // The download broke off halfway: nothing was kept, and the next round starts it again
          throw new SyncHttpError('offline', 0, 'network', e instanceof Error ? e.message : 'The download broke off.');
        }
        if (put === 'mismatch') {
          // The bytes were not this PDF: nothing was kept. It is tried again next session, never kept wrong.
          skip.add(`get:${w.documentId}`);
          return;
        }
        await o.store.markCopyRestored(w.documentId);
      } catch (e) {
        refusedOnly(e, `get:${w.documentId}`);
      }
    }
  }

  return {
    kick,
    run,
    status: () => current,
    recount: async () => {
      if (current.state === 'off') return;
      try {
        publish({ unsynced: await o.store.unsyncedCount() });
      } catch {
        // the next round counts again
      }
    },
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

