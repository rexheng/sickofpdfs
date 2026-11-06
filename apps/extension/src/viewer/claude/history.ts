// A thread as Claude reads it: its turns (contract §6 `ThreadTurn`).
//
// - In memory, a thread keeps the EXACT blocks this tab sent and got back (the pack, the replies' content blocks, the tool
//   results), so a follow-up sends the same prefix and the prompt cache holds.
// - After a reload (or when another tab added to the thread), the thread is rebuilt from its stored comments as plain text
//   turns, and a cache miss is accepted. Claude's earlier replies go back only as assistant turns, never as user text with
//   citations (API version 2026-10-21 refuses that).
// - The tool list of a thread stays as it was on its first question (web search on or off), because changing it resets the
//   caches. Nothing large is stored in `meta`.
import { replyBodyToPlainText, type CommentId, type CommentRow, type ContextPack, type ModelRole, type ThreadId, type ThreadTurn } from '@sop/core';
import { isClaudeMeta } from './reply-rows';

/** "@Claude why does this matter?" asks "why does this matter?". The mention is how the owner calls Claude, not part of the question. */
export function questionText(body: string): string {
  return body.replace(/(^|\s)@claude\b[,:]?\s*/giu, '$1').trim();
}

/** Whether a note calls Claude. */
export function mentionsClaude(body: string): boolean {
  return /(^|\s)@claude\b/iu.test(body);
}

/** What this tab holds of one thread after a turn it ran. */
export interface HeldThread {
  /** The pack that went with the first question: sent again unchanged, so the cached prefix matches. */
  pack: ContextPack;
  /** Every turn as sent and received, ending with Claude's last reply (assistant content blocks). */
  turns: ThreadTurn[];
  /** The comments the turns stand for, in order: the thread may be followed up only while it still has exactly these. */
  commentIds: CommentId[];
  role: ModelRole;
  webSearch: boolean;
  figureLabels: string[];
}

export interface ThreadHistory {
  get(threadId: ThreadId): HeldThread | null;
  set(threadId: ThreadId, h: HeldThread): void;
  forget(threadId: ThreadId): void;
}

export function createThreadHistory(): ThreadHistory {
  const held = new Map<ThreadId, HeldThread>();
  return {
    get: (id) => held.get(id) ?? null,
    set: (id, h) => void held.set(id, h),
    forget: (id) => void held.delete(id),
  };
}

const done = (c: CommentRow) => c.author === 'claude' && isClaudeMeta(c.meta) && c.meta.status === 'done' && c.body.trim() !== '';

/**
 * The comments of a thread a question is answered from: everything up to and including the question, oldest first, without
 * Claude replies that are not finished and without `skip` (the reply being written, or the reply Think harder re-asks).
 *
 * The owner's earlier notes in the thread go too: they are the conversation (R105, "Claude reads the earlier notes in the
 * thread"; the reply box says so). Words the owner has not sent (a draft) never go.
 */
export function commentsUpTo(comments: readonly CommentRow[], questionId: CommentId, skip: ReadonlySet<CommentId> = new Set()): CommentRow[] {
  const sorted = [...comments].sort((a, b) => a.createdAt - b.createdAt);
  const at = sorted.findIndex((c) => c.id === questionId);
  const upTo = at >= 0 ? sorted.slice(0, at + 1) : sorted;
  return upTo.filter((c) => !skip.has(c.id) && c.deletedAt === null && (c.author === 'me' ? c.draftOfTab === null && c.body.trim() !== '' : done(c)));
}

/**
 * The thread as plain text turns: the owner's notes as user turns (the @Claude mention taken out), Claude's finished replies
 * as assistant turns (chips turned into "(Page 4)"). Turns of the same role next to each other are joined. The first turn is the
 * owner's, as the request builder needs; the last is the question.
 */
export function plainTurns(comments: readonly CommentRow[]): ThreadTurn[] {
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const c of comments) {
    const role = c.author === 'me' ? 'user' : 'assistant';
    const text = role === 'user' ? questionText(c.body) : replyBodyToPlainText(c.body);
    if (text === '') continue;
    const last = turns.at(-1);
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift();
  return turns;
}

/**
 * The turns for a question. When this tab holds the thread's exact blocks and the thread has gained only the owner's new
 * question(s) since, those blocks are reused and the new words appended. Otherwise the thread is rebuilt as plain text.
 */
export function turnsFor(o: {
  held: HeldThread | null;
  comments: readonly CommentRow[];
  questionId: CommentId;
  skip?: ReadonlySet<CommentId>;
  /** The question's words when it is a fixed one (Explain this figure). */
  presetQuestion?: string;
}): { turns: ThreadTurn[]; reused: boolean } {
  // A fixed question stands in for the note's own words (the note only says "@Claude Explain this figure.").
  const upTo = commentsUpTo(o.comments, o.questionId, o.skip).map((c) => (c.id === o.questionId && o.presetQuestion !== undefined ? { ...c, body: o.presetQuestion } : c));
  const h = o.held;
  if (h) {
    const prefix = upTo.slice(0, h.commentIds.length).map((c) => c.id);
    const same = prefix.length === h.commentIds.length && prefix.every((id, i) => id === h.commentIds[i]);
    const rest = upTo.slice(h.commentIds.length);
    if (same && rest.length > 0 && rest.every((c) => c.author === 'me')) {
      const words = rest.map((c) => questionText(c.body)).filter(Boolean).join('\n\n');
      if (words !== '') return { turns: [...h.turns, { role: 'user', content: words }], reused: true };
    }
  }
  return { turns: plainTurns(upTo), reused: false };
}
