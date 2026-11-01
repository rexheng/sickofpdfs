// Which viewer tabs are alive right now (contracts §3, "no lost text").
//
// A tab that wants to adopt the drafts of tabs that are gone asks everyone on the BroadcastChannel `sop-tabs`, and the
// tabs that are alive answer. A tab that is closed, crashed or frozen cannot answer, so it is "gone" for that moment.
// The messages carry tab ids only, never text. The channel is same-origin, so web pages cannot join it.
//
// A tab whose page is busy can miss the 200 ms and look gone, and then another tab would adopt a draft that is still being
// typed. So every tab also holds a Web Lock named after its id for as long as it lives (the browser frees it the moment the
// tab dies, crash included), and the roll call counts the holders as live too. The lock is a second witness. The roll call
// stays the contract.

import type { TabId } from '@sop/core';

export const TABS_CHANNEL = 'sop-tabs';
const LOCK_PREFIX = 'sop-tab:';

/** Live tabs answer a roll call within this time. */
export const ROLL_CALL_MS = 200;

export interface TabPresence {
  readonly tabId: TabId;
  /** Every tab that answered within `timeoutMs`, including this one. */
  liveTabs(timeoutMs?: number /* 200 */): Promise<TabId[]>;
  close(): void;
}

type Message = { type: 'roll-call'; nonce: string } | { type: 'here'; nonce: string; tabId: string };

function parse(data: unknown): Message | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.nonce !== 'string' || m.nonce.length === 0 || m.nonce.length > 100) return null;
  if (m.type === 'roll-call') return { type: 'roll-call', nonce: m.nonce };
  if (m.type === 'here' && typeof m.tabId === 'string' && m.tabId.length > 0 && m.tabId.length <= 100) {
    return { type: 'here', nonce: m.nonce, tabId: m.tabId };
  }
  return null;
}

const newId = (): string => globalThis.crypto.randomUUID();

/** Web Locks, where there are any (not in Node tests, and not in a page the browser has blocked them for). */
const lockManager = (): LockManager | null => (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null);

async function tabsHoldingLocks(): Promise<string[]> {
  try {
    const held = (await lockManager()?.query())?.held ?? [];
    return held.flatMap((l) => (l.name?.startsWith(LOCK_PREFIX) ? [l.name.slice(LOCK_PREFIX.length)] : []));
  } catch {
    return [];
  }
}

const unique = (ids: Iterable<string>): TabId[] => [...new Set(ids)] as TabId[];

/**
 * Starts answering roll calls at once, so a tab that is still loading is already counted by the tabs that ask.
 * `o.tabId` is for tests; a viewer page makes a new random id each time it loads.
 */
export function createTabPresence(o?: { tabId?: TabId }): TabPresence {
  const tabId = o?.tabId ?? (newId() as TabId);
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(TABS_CHANNEL);
  const waiting = new Map<string, { seen: Set<string>; done: () => void }>();
  let closed = false;

  // Hold the lock until close(). If the browser refuses, the roll call alone still works.
  let releaseLock: (() => void) | null = null;
  void lockManager()
    ?.request(LOCK_PREFIX + tabId, () => (closed ? undefined : new Promise<void>((resolve) => (releaseLock = resolve))))
    .catch(() => undefined);

  if (channel) {
    channel.onmessage = (ev: MessageEvent) => {
      if (closed) return;
      const m = parse(ev.data);
      if (!m) return;
      if (m.type === 'roll-call') channel.postMessage({ type: 'here', nonce: m.nonce, tabId });
      else waiting.get(m.nonce)?.seen.add(m.tabId);
    };
  }

  return {
    tabId,
    liveTabs(timeoutMs = ROLL_CALL_MS) {
      if (closed) return Promise.resolve([]);
      const locked = tabsHoldingLocks();
      if (!channel) return locked.then((held) => unique([tabId, ...held]));
      return new Promise<TabId[]>((resolve) => {
        const nonce = newId();
        const seen = new Set<string>();
        const finish = (): void => {
          clearTimeout(timer);
          waiting.delete(nonce);
          if (closed) resolve([]);
          else void locked.then((held) => resolve(unique([tabId, ...seen, ...held])));
        };
        const timer = setTimeout(finish, timeoutMs);
        waiting.set(nonce, { seen, done: finish });
        channel.postMessage({ type: 'roll-call', nonce });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const w of [...waiting.values()]) w.done();
      channel?.close();
      releaseLock?.();
    },
  };
}
