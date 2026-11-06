// The shape of @Claude's entry (plan §8 A3) and of a reply's buttons, in a file of its own with no viewer imports, so the runtime
// registry (and the e2e hooks that read it) can name it without loading the viewer. entry.ts makes it.
import type { Anchor, CommentId, ModelRole, ThreadId } from '@sop/core';
import type { PrivateReason } from './errors';

/** Contract addition A3. */
export interface ClaudeEntry {
  ask(target: { threadId: ThreadId } | { anchor: Anchor }, o?: { preset?: 'explain-figure' | 'whole-document'; question?: string }): Promise<ThreadId>;
  status(): 'ready' | 'no-key' | 'incognito';
}

/** What a reply's buttons need (slice F's `ClaudeReplyActions`), and the tab's last word on privacy. */
export interface ClaudeEntryHost extends ClaudeEntry {
  /** Stop: the reply ends as `cancelled`; its text so far stays. */
  stop(replyId: CommentId): void;
  /** Try again: the same reply (the same id) is written again from the start. */
  retry(replyId: CommentId): void;
  /** Think harder: a second reply, from the Think harder model, to the question `replyId` answered. The first stays. */
  thinkHarder(threadId: ThreadId, replyId: CommentId): void;
  /** The owner's chosen model for a role (as Settings stored it), or null before setup. */
  model(role: ModelRole): { displayName: string } | null;
  /** About what Think harder would cost on this thread, in dollars; null when there is no estimate yet. */
  thinkHarderUsd(threadId: ThreadId): number | null;
  /** Why Claude will not read this PDF now, or null when it may. */
  privacy(): PrivateReason | null;
  /** Whether a turn of this tab is writing the reply. */
  running(replyId: CommentId): boolean;
  dispose(): void;
}

