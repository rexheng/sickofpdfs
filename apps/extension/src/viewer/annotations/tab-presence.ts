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
//
// One tab keeps one id across its own reloads (ruling R65). A renderer crash kills every viewer tab at once; when they come
// back, each must get back the draft it owned, not whichever tab starts first. So the viewer claims its id as its page starts
// (`claimTabIdentity`, before the PDF loads): the id kept in this tab's sessionStorage, if no live page holds its lock, or a
// new one. A duplicated tab copies sessionStorage, but the original still holds the lock, so the copy gets a new id.

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

/** The tabs alive now, by their locks alone (no roll call): what a page that is not a tab itself can ask. */
export async function tabsHoldingLocks(): Promise<string[]> {
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
 * `o.tabId` is the viewer's claimed id (`tabIdentity()`), or a test's; without it a new random id is made.
 * `o.lockHeld`: the page already holds this id's lock (`claimTabIdentity` did it), so the presence does not ask again.
 */
export function createTabPresence(o?: { tabId?: TabId; lockHeld?: boolean }): TabPresence {
  const tabId = o?.tabId ?? (newId() as TabId);
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(TABS_CHANNEL);
  const waiting = new Map<string, { seen: Set<string>; done: () => void }>();
  let closed = false;

  // Hold the lock until close(). If the browser refuses, the roll call alone still works.
  let releaseLock: (() => void) | null = null;
  if (!o?.lockHeld) {
    void lockManager()
      ?.request(LOCK_PREFIX + tabId, () => (closed ? undefined : new Promise<void>((resolve) => (releaseLock = resolve))))
      .catch(() => undefined);
  }

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

// ---------------------------------------------------------------------------------------------------------------
// The tab's own id, kept across its reloads (R65)

const IDENTITY_KEY = 'sop-tab-id';

export interface TabIdentity {
  tabId: TabId;
  /** True when this page holds the id's Web Lock for as long as it lives. */
  lockHeld: boolean;
}

let claimed: Promise<TabIdentity> | null = null;
let identity: TabIdentity | null = null;

/** Holds `sop-tab:<id>` for the life of the page if nobody holds it now. Resolves false if it is taken or locks fail. */
function holdIfFree(locks: LockManager, id: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    locks
      .request(LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock === null ? undefined : new Promise<void>(() => undefined); // freed by the browser when the page goes
      })
      .catch(() => resolve(false));
  });
}

function readStoredId(): string | null {
  try {
    const v = sessionStorage.getItem(IDENTITY_KEY);
    return v !== null && v.length > 0 && v.length <= 100 ? v : null;
  } catch {
    return null;
  }
}

function storeId(id: string): void {
  try {
    sessionStorage.setItem(IDENTITY_KEY, id);
  } catch {
    // without sessionStorage the tab gets a new id on each load, as before
  }
}

/** Claims this tab's id once per page. Call it as early as the page starts. */
export function claimTabIdentity(): Promise<TabIdentity> {
  claimed ??= (async () => {
    const locks = lockManager();
    const stored = readStoredId();
    if (locks && stored !== null && (await holdIfFree(locks, stored))) return (identity = { tabId: stored as TabId, lockHeld: true });
    const fresh = newId();
    storeId(fresh);
    const lockHeld = locks !== null && (await holdIfFree(locks, fresh));
    return (identity = { tabId: fresh as TabId, lockHeld });
  })();
  return claimed;
}

/** The id `claimTabIdentity` settled on, or null while it has not yet (the presence then makes a new id, as before). */
export const tabIdentity = (): TabIdentity | null => identity;
