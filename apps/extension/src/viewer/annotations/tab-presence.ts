// Which viewer tabs are alive right now (contracts §3, "no lost text").
//
// A tab that wants to adopt the drafts of tabs that are gone asks everyone on the BroadcastChannel `sop-tabs`, and the
// tabs that are alive answer. A tab that is closed, crashed or frozen cannot answer, so it is "gone" for that moment.
// The messages carry tab ids only, never text. The channel is same-origin, so web pages cannot join it.

import type { TabId } from '@sop/core';

export const TABS_CHANNEL = 'sop-tabs';

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

/**
 * Starts answering roll calls at once, so a tab that is still loading is already counted by the tabs that ask.
 * `o.tabId` is for tests; a viewer page makes a new random id each time it loads.
 */
export function createTabPresence(o?: { tabId?: TabId }): TabPresence {
  const tabId = o?.tabId ?? (newId() as TabId);
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(TABS_CHANNEL);
  const waiting = new Map<string, { seen: Set<string>; done: () => void }>();
  let closed = false;

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
      if (!channel) return Promise.resolve([tabId]);
      return new Promise<TabId[]>((resolve) => {
        const nonce = newId();
        const seen = new Set<string>();
        const finish = (): void => {
          clearTimeout(timer);
          waiting.delete(nonce);
          resolve(closed ? [] : [tabId, ...[...seen].filter((t) => t !== tabId)].map((t) => t as TabId));
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
    },
  };
}
