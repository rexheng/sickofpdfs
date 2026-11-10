// When sync runs, from the service worker's side (CL11). The engine lives in the offscreen document (engine.ts); the service worker
// owns the things a document cannot have: alarms, the browser starting, and the toolbar badge.
//   - a 5-minute alarm, the browser starting, and a page's "sync now" (after Connect) wake the offscreen document and tell it
//     to run a round;
//   - the engine says when sync has stopped (signed out, refused): the toolbar icon gets a badge (backup/badge.ts, where a
//     waiting backup outranks it).
// Every one of these first asks whether a server is connected (a look at this computer's own storage, no request). With none,
// nothing starts and nothing is sent (R110).
import { setSyncBadge } from '../backup/badge';
import { ensureOffscreen } from '../background/offscreen';
import { SYNC_BADGE_MESSAGE, SYNC_KICK_MESSAGE, SYNC_RUN_MESSAGE } from './status';

const SYNC_ALARM = 'sop-sync';
const SYNC_EVERY_MIN = 5;

/** Whether the owner connected a server (the token broker answers it from this computer's storage). Set by `installSyncScheduler`. */
let cloudConnected: () => Promise<boolean> = () => Promise.resolve(false);

/** Wakes the engine for a round, if a server is connected. Never throws. */
export async function wakeSync(): Promise<void> {
  try {
    if (!(await cloudConnected())) return;
    await ensureOffscreen();
    const sent: unknown = chrome.runtime.sendMessage({ type: SYNC_RUN_MESSAGE });
    if (sent instanceof Promise) await sent.catch(() => undefined);
  } catch {
    // the offscreen document is starting: it runs a round on its own when it starts
  }
}

/** Registers the listeners. Call it synchronously when the service worker starts. */
export function installSyncScheduler(o: { connected: () => Promise<boolean> }): void {
  cloudConnected = o.connected;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void wakeSync();
  });
  void chrome.alarms.get(SYNC_ALARM).then((a) => {
    if (a === undefined) void chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_EVERY_MIN });
  });
  chrome.runtime.onStartup.addListener(() => void wakeSync());
  chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || typeof raw !== 'object' || raw === null) return false;
    const m = raw as { type?: unknown; stopped?: unknown; title?: unknown };
    if (m.type === SYNC_KICK_MESSAGE) void wakeSync();
    else if (m.type === SYNC_BADGE_MESSAGE && typeof m.stopped === 'boolean') {
      setSyncBadge(m.stopped ? (typeof m.title === 'string' ? m.title.slice(0, 200) : 'Sync has stopped.') : null).catch(() => {});
    }
    return false; // no answer is sent
  });
}
