// The seam between Claude in the thread (slice F, this folder) and the turn runner (slice D).
//
// The UI never calls Anthropic and never sees the key. It asks the host to do things (ask, stop, try again, think harder)
// and draws what the host reports: the reply rows in the store, and the live stream events (ReplyStatus.tsx's claudeLive).
// Slice D's entry (entry.ts) sets the host once it exists; until then nothing is set, and every Claude item stays hidden
// (plan §8 A3: "keep those items hidden until it exists").
import type { Anchor, CommentId, ModelRole, ThreadId } from '@sop/core';
import { useSyncExternalStore } from 'react';

/** A fixed question instead of the owner's words (plan §8 A3). */
export type ClaudePreset = 'explain-figure' | 'whole-document';

/** What a question is about: a thread that exists, or a place to start one. */
export type ClaudeAskTarget = { threadId: ThreadId } | { anchor: Anchor };

/** Contract addition A3, `ClaudeEntry`, as the UI calls it. */
export interface ClaudeEntryLike {
  /**
   * Starts a Claude turn. With `{ threadId }` the thread's last comment from the owner is the question (an @Claude note or
   * reply that was just sent). Resolves with the thread; never rejects for a reply error (the reply row shows it).
   */
  ask(target: ClaudeAskTarget, o?: { preset?: ClaudePreset; question?: string }): Promise<ThreadId>;
  status(): 'ready' | 'no-key' | 'incognito';
}

/**
 * What a reply's buttons ask for, beyond A3. Slice D implements them; F's fake runner stood in for the screenshots. Each is
 * optional: a host that has only A3's `ask` and `status` plugs in as it is, and a button whose action is missing does
 * not show (Stop, Try again, Think harder), so nothing is offered that cannot be done.
 */
export interface ClaudeReplyActions {
  /** Stop: the reply ends as `cancelled`, and its text so far stays. */
  stop(replyId: CommentId): void;
  /** Try again: the same reply (the same id) is written again from the start (contract §3, step 4). */
  retry(replyId: CommentId): void;
  /** Think harder: a second reply from the Think harder model, to the question `replyId` answered. The first stays. */
  thinkHarder(threadId: ThreadId, replyId: CommentId): void;
  /** The owner's chosen model for a role, as Settings stored it (ModelChoice.displayName). Null before setup. */
  model(role: ModelRole): { displayName: string } | null;
  /** About what Think harder would cost for this thread, in dollars; null when there is no estimate. */
  thinkHarderUsd?(threadId: ThreadId): number | null;
}

export type ClaudeUiHost = ClaudeEntryLike & Partial<ClaudeReplyActions>;

let current: ClaudeUiHost | null = null;
let ownTab: string | null = null;
const listeners = new Set<() => void>();

/** The one host of this tab. Slice D's entry calls `set` when it is ready, and `set(null)` when it goes. */
export const claudeUi = {
  set: (host: ClaudeUiHost | null): void => {
    if (current === host) return;
    current = host;
    for (const cb of [...listeners]) cb();
  },
  get: (): ClaudeUiHost | null => {
    return current;
  },
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  /**
   * This tab's id (TabId), set by the Claude feature from the annotation session. A reply row being written carries its
   * tab in `draftOfTab` (contract §3), so the reply view knows whether this tab is writing it (and can stop it).
   */
  setTab: (tab: string | null): void => {
    ownTab = tab;
  },
  tab: (): string | null => ownTab,
};

/** The host, or null while there is none (the Claude items then stay hidden). */
export function useClaudeUi(): ClaudeUiHost | null {
  return useSyncExternalStore(claudeUi.subscribe, claudeUi.get, claudeUi.get);
}

/** Settings → Claude, in a new tab beside this one (the section slice G registers as `claude`). */
export const CLAUDE_SETTINGS_PATH = 'library.html#/settings/claude';

export function openClaudeSettings(): void {
  const url = chrome.runtime.getURL(CLAUDE_SETTINGS_PATH);
  void chrome.tabs.create({ url }).catch(() => window.open(url, '_blank', 'noopener'));
}

/**
 * About what something costs, in plain words: "0.07¢", "3¢", "31¢", "$1.20". Under a cent it keeps two figures, so a
 * Haiku question never reads "0¢". A cost that is not a number reads "an unknown amount".
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return 'an unknown amount';
  const cents = usd * 100;
  if (cents < 0.01) return 'under 0.01¢';
  if (cents < 1) return `${trim(cents.toFixed(2))}¢`;
  if (cents < 10) return `${trim(cents.toFixed(1))}¢`;
  if (cents < 100) return `${Math.round(cents)}¢`;
  return `$${usd.toFixed(2)}`;
}

const trim = (s: string): string => s.replace(/\.?0+$/u, '');
