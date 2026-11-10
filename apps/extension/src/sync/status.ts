// What sync tells the rest of the extension (CL11): its status, for the library's "N not yet synced" and Settings → Cloud (CL12),
// and whether the toolbar icon needs a badge.
//
// The engine runs in the offscreen document (engine.ts). It posts every new status on the BroadcastChannel `sop-sync-status`, which
// every extension page hears, and answers a page that asks for it. It also tells the service worker when sync has stopped
// (`sop-sync:badge`), because only the service worker may set the badge (backup/badge.ts, where a waiting backup outranks it).
// Plain data both ways; never a token, a title, a file name or a note.
import type { EngineStatus } from '@sop/core/sync-client';

export const SYNC_STATUS_CHANNEL = 'sop-sync-status';
/** The service worker's message: show or clear the "sync has stopped" badge. */
export const SYNC_BADGE_MESSAGE = 'sop-sync:badge';
/** A page asks the service worker for a round now (it starts the offscreen document if a server is connected). */
export const SYNC_KICK_MESSAGE = 'sop-sync:kick';
/** The service worker tells the offscreen engine to run a round (`reason` only says why, for nothing but the delay). */
export const SYNC_RUN_MESSAGE = 'sop-sync:run';

export type { EngineStatus as SyncEngineStatus } from '@sop/core/sync-client';

type ChannelMessage = { type: 'status'; status: EngineStatus } | { type: 'ask' };

const STATES = new Set(['off', 'ok', 'syncing', 'offline', 'stopped', 'signed-out', 'quota']);

/** A status that is well formed; null for anything else. */
export function asSyncStatus(x: unknown): EngineStatus | null {
  if (typeof x !== 'object' || x === null) return null;
  const s = x as Partial<EngineStatus>;
  if (typeof s.state !== 'string' || !STATES.has(s.state) || typeof s.unsynced !== 'number' || !Number.isFinite(s.unsynced)) return null;
  const r = s.restoring;
  return {
    state: s.state,
    unsynced: Math.max(0, Math.floor(s.unsynced)),
    lastSyncAt: typeof s.lastSyncAt === 'number' ? s.lastSyncAt : null,
    message: typeof s.message === 'string' ? s.message.slice(0, 300) : null,
    restoring: r && typeof r === 'object' && typeof r.done === 'number' && typeof r.total === 'number' ? { done: r.done, total: r.total } : null,
    textWaiting: s.textWaiting === true,
  };
}

/** Sync needs the owner: it has stopped, or the sign-in ended. Offline and a busy cloud fix themselves, so they get no badge. */
export const needsOwner = (s: EngineStatus): boolean => s.state === 'stopped' || s.state === 'signed-out';

/** In the offscreen document: tell every page, and the service worker when the badge changes. */
export function createStatusAnnouncer(): { announce(s: EngineStatus): void; onAsk(f: () => EngineStatus): void; close(): void } {
  const channel = new BroadcastChannel(SYNC_STATUS_CHANNEL);
  let lastBadge: boolean | null = null;
  return {
    announce(status) {
      channel.postMessage({ type: 'status', status } satisfies ChannelMessage);
      const badge = needsOwner(status);
      if (badge === lastBadge) return;
      lastBadge = badge;
      try {
        const sent: unknown = chrome.runtime.sendMessage({ type: SYNC_BADGE_MESSAGE, stopped: badge, title: badge ? (status.message ?? 'Sync has stopped.') : null });
        if (sent instanceof Promise) sent.catch(() => (lastBadge = null)); // the service worker is starting: say it again next time
      } catch {
        lastBadge = null;
      }
    },
    onAsk(f) {
      channel.onmessage = (e: MessageEvent) => {
        if ((e.data as ChannelMessage | null)?.type === 'ask') channel.postMessage({ type: 'status', status: f() } satisfies ChannelMessage);
      };
    },
    close: () => channel.close(),
  };
}

/** For pages: every status the engine posts, starting with the current one (if the engine is running). Returns the unsubscribe. */
export function subscribeSyncStatus(f: (s: EngineStatus) => void): () => void {
  const channel = new BroadcastChannel(SYNC_STATUS_CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const m = e.data as ChannelMessage | null;
    if (m?.type !== 'status') return;
    const s = asSyncStatus(m.status);
    if (s !== null) f(s);
  };
  channel.postMessage({ type: 'ask' } satisfies ChannelMessage);
  return () => channel.close();
}

/** For pages (Settings → Cloud, after Connect): run a round now. Sends nothing anywhere when no server is connected. */
export function syncNow(): void {
  try {
    const sent: unknown = chrome.runtime.sendMessage({ type: SYNC_KICK_MESSAGE });
    if (sent instanceof Promise) sent.catch(() => {});
  } catch {
    // the extension context is gone
  }
}
