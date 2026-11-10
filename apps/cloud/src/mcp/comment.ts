// add_comment and update_comment (CL6). Claude writes only through `SyncService.push` as the `claude` device, so every write
// passes the same rules as every other: the merge accepts only `claude`-authored comments and threads, never edits a note
// Claude did not write, and the owner's delete beats Claude's edit (R57). Nothing here touches the owner's rows.
import { type Anchor, type CommentRow, Hlc, type ThreadRow } from '@sop/core';
import { foldText } from '@sop/core/text-fold';
import { CONNECTOR_LIMITS, type AddCommentInput, type AddCommentResult, type ConnectorErrorCode, type UpdateCommentInput, type UpdateCommentResult } from '@sop/core/connector';
import { type ChangeEntry, CLAUDE_DEVICE, type DbRow, type PushResponse, dbToWire, derivedId } from '@sop/core/sync';
import type { Env } from '../env';
import { pageText } from '../query/api';
import { visibleDocs } from '../query/api';
import type { AuthContext, QueryApi, SyncService } from '../seams';
import { iso } from './format';

export type Outcome<T> = { ok: true; data: T } | { ok: false; code: ConnectorErrorCode; message: string; retryable?: boolean };
const refuse = (code: ConnectorErrorCode, message: string, retryable = false): { ok: false; code: ConnectorErrorCode; message: string; retryable: boolean } => ({ ok: false, code, message, retryable });

export interface CommentDeps {
  env: Env;
  sync: SyncService;
  /** The connector's view of the library: private readings are not visible here. */
  query: QueryApi;
  auth: AuthContext;
  now?: () => number;
}

const clock = new Hlc(CLAUDE_DEVICE);

/** How Claude's comments are marked, so the viewer shows the "Claude" badge. */
const CONNECTOR_META = { kind: 'claude-reply', v: 1, role: null, status: 'done', error: null, questionId: null, citations: [], webSources: [], usage: null, scope: 'passages', figureLabels: [], via: 'connector' } as const;

/** A quote found in a page: raw character offsets in the page text (the same offsets the viewer uses). */
export function locateQuote(page: string, quote: string): { start: number; end: number } | 'missing' | 'ambiguous' {
  const hay = foldText(page);
  const needle = foldText(quote).text;
  if (needle.length === 0) return 'missing';
  const first = hay.text.indexOf(needle);
  if (first < 0) return 'missing';
  if (hay.text.indexOf(needle, first + 1) >= 0) return 'ambiguous'; // overlapping repeats count as repeats
  const start = hay.src[first] ?? 0;
  const end = (hay.src[first + needle.length - 1] ?? start) + 1;
  return { start, end };
}

function pushProblem(res: PushResponse, ids: Set<string>): Outcome<never> | null {
  const bad = res.rejected?.find((r) => ids.has(r.id));
  if (!bad) return null;
  if (bad.code === 'unknown_document' || bad.code === 'forgotten') return refuse('document_not_synced', 'That reading is not in your cloud library yet.');
  if (bad.code === 'claude_scope' || bad.code === 'claude_row_readonly' || bad.code === 'author_changed') return refuse('comment_not_yours', 'Claude can only change comments that Claude added.');
  return refuse('internal', 'The comment could not be saved. Try again in a moment.', true);
}

async function audit(env: Env, auth: AuthContext, action: string, target: string, batch: string | null, now: number): Promise<void> {
  // No bodies, no text, no tokens: only that Claude did something, to what, and when.
  await env.META.prepare('INSERT INTO audit (at, actor, client_id, action, target, batch) VALUES (?, ?, ?, ?, ?, ?)').bind(now, 'claude', auth.clientId, action, target, batch).run();
}

async function underHourlyLimit(env: Env, now: number): Promise<boolean> {
  const r = await env.META.prepare("SELECT count(*) AS n FROM audit WHERE actor = 'claude' AND action IN ('add_comment','update_comment','delete_comment') AND at > ?").bind(now - 3_600_000).first<{ n: number }>();
  return (r?.n ?? 0) < CONNECTOR_LIMITS.commentsPerHour;
}

export async function addComment(d: CommentDeps, input: AddCommentInput): Promise<Outcome<AddCommentResult & { documentId: string; pageIndex: number | null }>> {
  const now = (d.now ?? Date.now)();
  const body = input.body.trim();
  if (body.length === 0) return refuse('bad_input', 'The comment is empty.');
  // A comment is shown in the owner's viewer. An image or HTML in it could load from another site and carry text out with it.
  if (/!\[[^\]]*\][([]/.test(body) || /<\s*\/?\s*[a-z]/i.test(body)) return refuse('bad_input', 'Comments are plain Markdown text. Images and HTML are not allowed.');
  if (input.quote !== undefined && input.page === undefined && input.reply_to === undefined) return refuse('bad_input', 'Give the page that the quote is on.');

  const threadId = derivedId('mcp-thread', input.request_id);
  const commentId = derivedId('mcp-comment', input.request_id);

  // A retry: the same request_id has already been written (also after a crash between the write and its bookkeeping).
  const seen = await d.env.META.prepare(
    `SELECT c.id, c.thread_id, c.document_id, t.page_index, t.anchor FROM comments c JOIN threads t ON t.id = c.thread_id
     WHERE (c.mcp_request_id = ? OR c.id = ?)`,
  ).bind(input.request_id, commentId).first<{ id: string; thread_id: string; document_id: string; page_index: number | null; anchor: string }>();
  if (seen) {
    if (seen.document_id !== input.doc) return refuse('bad_input', 'That request_id was already used for another comment.');
    let kind: Anchor['kind'] = 'document';
    try {
      kind = (JSON.parse(seen.anchor) as Anchor).kind;
    } catch {
      /* document */
    }
    const anchored = input.reply_to !== undefined ? 'reply' : kind === 'text' ? 'quote' : kind === 'page' ? 'page' : 'document';
    return { ok: true, data: { thread_id: seen.thread_id, comment_id: seen.id, anchored, url: '', documentId: seen.document_id, pageIndex: seen.page_index } };
  }

  if (!(await underHourlyLimit(d.env, now))) return refuse('rate_limited', `Claude may add ${CONNECTOR_LIMITS.commentsPerHour} comments an hour. Wait a while.`, true);

  const info = await d.query.getDocument(input.doc);
  if (!info) return refuse('document_not_synced', 'That reading is not in the library that Claude can see.');
  const pageCount = info.doc.pageCount;

  let anchor: Anchor;
  let threadPage: number | null;
  let sortKey: number | null;
  let anchored: AddCommentResult['anchored'];
  const entries: ChangeEntry[] = [];

  if (input.reply_to !== undefined) {
    const t = await d.env.META.prepare('SELECT id, document_id, page_index FROM threads WHERE id = ? AND deleted_at IS NULL AND draft_of_tab IS NULL').bind(input.reply_to).first<{ id: string; document_id: string; page_index: number | null }>();
    if (!t || t.document_id !== input.doc) return refuse('thread_not_found', 'There is no such thread on that reading.');
    entries.push(commentEntry(commentId, t.id, input.doc, body, now));
    return finish(d, entries, new Set([commentId]), { thread_id: t.id, comment_id: commentId, anchored: 'reply', documentId: input.doc, pageIndex: t.page_index }, input, now);
  }

  if (input.page !== undefined) {
    if (!Number.isInteger(input.page) || input.page < 1 || (pageCount > 0 && input.page > pageCount)) return refuse('bad_input', `Page ${input.page} is outside this reading (it has ${pageCount} pages).`);
    const pageIndex = input.page - 1;
    threadPage = pageIndex;
    if (input.quote !== undefined) {
      const q = input.quote.trim();
      if (q.length < CONNECTOR_LIMITS.quoteMin) return refuse('bad_input', `The quote must be at least ${CONNECTOR_LIMITS.quoteMin} characters.`);
      const text = await pageText(d.env, input.doc, pageIndex);
      if (!text) return refuse('quote_not_found', 'This page has no text in the library. Comment on the page without a quote.', true);
      const found = locateQuote(text.text, q);
      if (found === 'missing') return refuse('quote_not_found', 'That quote is not on that page. Copy it exactly from read_pages and try again.', true);
      if (found === 'ambiguous') return refuse('quote_ambiguous', 'That quote appears more than once on the page. Use a longer quote.', true);
      anchor = {
        kind: 'text',
        quote: { quote: text.text.slice(found.start, found.end), prefix: text.text.slice(Math.max(0, found.start - 32), found.start), suffix: text.text.slice(found.end, found.end + 32) },
        start: { page: pageIndex, index: found.start },
        end: { page: pageIndex, index: found.end },
        rects: [], // the viewer works these out on open
        ...(text.source !== 'pdfium' ? { textSource: text.source } : {}),
      };
      sortKey = text.text.length > 0 ? found.start / text.text.length : 0;
      anchored = 'quote';
    } else {
      anchor = { kind: 'page', page: pageIndex };
      sortKey = 0;
      anchored = 'page';
    }
  } else {
    anchor = { kind: 'document' };
    threadPage = null;
    sortKey = null;
    anchored = 'document';
  }

  const threadRow: Omit<ThreadRow, 'rev' | 'hlc'> = {
    id: threadId as ThreadRow['id'], documentId: input.doc, anchor, pageIndex: threadPage, sortKey, placement: 'placed', draftOfTab: null, createdAt: now, updatedAt: now, deletedAt: null,
  };
  entries.push({ table: 'threads', id: threadId, baseRev: 0, hlc: clock.tick(), row: threadRow });
  entries.push(commentEntry(commentId, threadId, input.doc, body, now));
  return finish(d, entries, new Set([threadId, commentId]), { thread_id: threadId, comment_id: commentId, anchored, documentId: input.doc, pageIndex: threadPage }, input, now);
}

function commentEntry(id: string, threadId: string, doc: string, body: string, now: number): ChangeEntry {
  const row = { id, threadId, documentId: doc, author: 'claude', body, draftOfTab: null, meta: { ...CONNECTOR_META }, createdAt: now, editedAt: null, deletedAt: null } satisfies Record<string, unknown> & Partial<Omit<CommentRow, 'id' | 'threadId' | 'documentId' | 'author' | 'meta'>>;
  return { table: 'comments', id, baseRev: 0, hlc: clock.tick(), row };
}

async function finish(d: CommentDeps, entries: ChangeEntry[], ids: Set<string>, base: Omit<AddCommentResult, 'url'> & { documentId: string; pageIndex: number | null }, input: AddCommentInput, now: number): Promise<Outcome<AddCommentResult & { documentId: string; pageIndex: number | null }>> {
  let res: PushResponse;
  try {
    res = await d.sync.push(CLAUDE_DEVICE, entries);
  } catch (e) {
    console.error('connector push failed', e instanceof Error ? e.name : 'unknown');
    return refuse('internal', 'The comment could not be saved. Try again in a moment.', true);
  }
  const problem = pushProblem(res, ids);
  if (problem) return problem;
  try {
    await d.env.META.prepare('UPDATE comments SET mcp_request_id = ? WHERE id = ? AND mcp_request_id IS NULL').bind(input.request_id, base.comment_id).run();
  } catch {
    /* the id is derived from request_id too, so a retry still finds the comment */
  }
  await audit(d.env, d.auth, 'add_comment', base.comment_id, input.request_id, now);
  return { ok: true, data: { ...base, url: '' } };
}

export async function updateComment(d: CommentDeps, input: UpdateCommentInput): Promise<Outcome<UpdateCommentResult>> {
  const now = (d.now ?? Date.now)();
  const del = input.delete === true;
  const body = input.body?.trim();
  if (!del && (body === undefined || body.length === 0)) return refuse('bad_input', 'Give the new text, or set delete to true.');
  if (!del && body !== undefined && body.length > CONNECTOR_LIMITS.bodyMax) return refuse('bad_input', `The comment is longer than ${CONNECTOR_LIMITS.bodyMax} characters.`);

  // A comment in a reading the connector cannot see is the same as no comment.
  const raw = await d.env.META.prepare(`SELECT c.* FROM comments c JOIN documents d ON d.id = c.document_id WHERE c.id = ? AND ${visibleDocs('connector')}`).bind(input.id).first<DbRow>();
  if (!raw) return refuse('not_found', 'There is no such comment.');
  const wire = dbToWire('comments', raw);
  const row = wire.row;
  const meta = row.meta as { via?: unknown } | null;
  if (row.author !== 'claude' || meta?.via !== 'connector' || raw.draft_of_tab !== null) return refuse('comment_not_yours', 'Claude can only change comments that Claude added.');
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    if (del) return { ok: true, data: { comment_id: input.id, edited_at: null, deleted: true } }; // already gone
    return refuse('comment_not_yours', 'That comment was deleted. Claude cannot bring it back.');
  }
  if (!(await underHourlyLimit(d.env, now))) return refuse('rate_limited', `Claude may change ${CONNECTOR_LIMITS.commentsPerHour} comments an hour. Wait a while.`, true);

  const next = del ? { ...row, deletedAt: now } : { ...row, body, editedAt: now };
  const entry: ChangeEntry = { table: 'comments', id: input.id, baseRev: wire.rev, hlc: clock.receive(wire.hlc), row: next };
  let res: PushResponse;
  try {
    res = await d.sync.push(CLAUDE_DEVICE, [entry]);
  } catch (e) {
    console.error('connector push failed', e instanceof Error ? e.name : 'unknown');
    return refuse('internal', 'The change could not be saved. Try again in a moment.', true);
  }
  const problem = pushProblem(res, new Set([input.id]));
  if (problem) return problem;
  await audit(d.env, d.auth, del ? 'delete_comment' : 'update_comment', input.id, null, now);
  return { ok: true, data: del ? { comment_id: input.id, edited_at: iso(now), deleted: true } : { comment_id: input.id, edited_at: iso(now) } };
}
