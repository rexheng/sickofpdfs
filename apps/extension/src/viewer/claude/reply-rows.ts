// A Claude reply's row, through its whole life (contract §3, binding):
//   1. pending: the row is made first, `author 'claude'`, empty body, `draftOfTab` = this tab (a draft: never synced, never
//      searched, publishes no change event);
//   2. streaming: the text so far is written at most every 500 ms;
//   3. done: the final body, citations, sources and usage, and `draftOfTab = NULL`, in ONE write (`writeAnnotations` sends the
//      stored draft in place). Only now does it sync and become searchable;
//   4. error: the partial text stays, with status `error`, kept on this computer (still a draft) until Try again (same id) or
//      until the owner deletes it;
//   5. on open, a `pending` or `streaming` row whose tab is gone becomes `error: interrupted` (`sweep`).
//
// The tab shows the row while it is written through the annotation session's `holdReply` (the session never writes it). On a
// PDF the store does not keep, the row lives only there, in memory.
//
// Order: a reply's writes go one at a time, in order, and a newer streaming text replaces one still waiting. The first write
// waits for the question's own write to land (the store refuses a reply in a thread it does not have yet).
import { replyError, type ClaudeReplyMeta, type CommentId, type CommentRow, type DocumentId, type TabId, type ThreadId } from '@sop/core';
import type { AnnotationSession } from '../annotations/session';
import type { StoreClient } from '../../store/client';

/** At most one streaming write per reply in this time (contract §3). */
export const STREAM_WRITE_MS = 500;
/** How long the first write keeps trying while the question's own write (or the PDF's save) lands. */
const FIRST_WRITE_MAX_MS = 20_000;
const RETRY_MS = [100, 250, 500, 1000, 2000, 3000, 5000];

export type ReplyStore = Pick<StoreClient, 'saveDraft' | 'writeAnnotations' | 'discardDraft' | 'listDrafts'>;

export interface ReplyRowsDeps {
  session: Pick<AnnotationSession, 'state' | 'holdReply' | 'releaseReply' | 'adoptDrafts' | 'ready'>;
  /** The library store, or null (Incognito, or the store cannot be reached): then the rows live in memory only. */
  store: ReplyStore | null;
  tabId: TabId;
  /** The library id while the PDF is saved and its notes are written; null while they are not (rows then stay in memory). */
  storedDocumentId(): DocumentId | null;
  now(): number;
  onError?(e: unknown, where: string): void;
}

export interface ReplyWriter {
  readonly id: CommentId;
  readonly threadId: ThreadId;
  /** The text so far (status streaming). Written at most every 500 ms; the latest always lands. */
  stream(body: string, meta: ClaudeReplyMeta): void;
  /** Done: the final row, in one write. Resolves once it is written (or kept in memory when it cannot be). */
  finish(body: string, meta: ClaudeReplyMeta): Promise<void>;
  /** Error: the text so far stays, kept on this computer. */
  fail(body: string, meta: ClaudeReplyMeta): Promise<void>;
  /** The owner cancelled before anything was sent (a confirm answered No): the row goes, from view and from the store. */
  discard(): Promise<void>;
  /** Fields kept on the row's `meta` from now on, beside the contract's (`modelName`: the cost line names the model that answered). */
  note(extra: Record<string, unknown>): void;
}

export interface ReplyRows {
  /** Makes (or, for Try again, re-makes with the same id) the reply row, status pending, and shows it at once. */
  begin(o: { id: CommentId; threadId: ThreadId; documentId: DocumentId; meta: ClaudeReplyMeta; createdAt?: number; onRemove?: () => void }): ReplyWriter;
  /**
   * Contract §3 step 5: the replies this tab holds as drafts (its own, and those it adopted from tabs that are gone) are shown
   * again; one still `pending` or `streaming` that no turn here is writing becomes `error: interrupted`.
   */
  sweep(isRunning: (id: CommentId) => boolean, onRemove: (id: CommentId) => () => void): Promise<void>;
  /** The row as this tab last held it (for Try again and Think harder). */
  held(id: CommentId): CommentRow | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Store errors that mean "not yet": the question's write, or the PDF's save, has not landed. */
function notYet(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  // The question's own write is still on its way: its thread is not in the store yet, or is still a draft there.
  return /^(thread-missing|document-missing|no-store)\b/.test(m) || /thread that is still a draft|not available|did not answer|timed out|closed/i.test(m);
}

export function isClaudeMeta(meta: unknown): meta is ClaudeReplyMeta {
  return meta !== null && typeof meta === 'object' && (meta as { kind?: unknown }).kind === 'claude-reply';
}

export function createReplyRows(d: ReplyRowsDeps): ReplyRows {
  const rows = new Map<CommentId, CommentRow>();
  const report = (e: unknown, where: string) => {
    try {
      d.onError?.(e, where);
    } catch {
      /* a failing logger must not break a reply */
    }
  };

  function show(row: CommentRow, onRemove?: () => void): void {
    rows.set(row.id, row);
    d.session.holdReply?.(row, onRemove ? { onRemove } : undefined);
  }

  /** One write, tried again while the store says "not yet", for up to `maxMs`. */
  async function write(what: string, op: () => Promise<void>, maxMs: number): Promise<boolean> {
    const until = d.now() + maxMs;
    for (let i = 0; ; i++) {
      try {
        await op();
        return true;
      } catch (e) {
        if (!notYet(e) || d.now() > until) {
          report(e, what);
          return false;
        }
        await sleep(RETRY_MS[Math.min(i, RETRY_MS.length - 1)]);
      }
    }
  }

  function writer(row0: CommentRow, onRemove?: () => void): ReplyWriter {
    let row = row0;
    // One write at a time, in order. `latest` is the streaming text waiting to go; a newer one replaces it.
    let chain: Promise<void> = Promise.resolve();
    let latest: CommentRow | null = null;
    let lastStreamWrite = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stored = false; // the draft is in the store
    let ended = false;
    let extra: Record<string, unknown> = {};
    const withExtra = (meta: ClaudeReplyMeta, status?: ClaudeReplyMeta['status']): CommentRow['meta'] => ({ ...meta, ...extra, ...(status ? { status } : {}) });

    const docId = () => d.storedDocumentId();
    const canStore = () => d.store !== null && docId() !== null && docId() === row.documentId;

    const enqueue = (fn: () => Promise<void>) => {
      chain = chain.then(fn, fn);
      return chain;
    };

    /** Writes the row as a draft of this tab (pending, streaming, error). */
    const saveDraft = (r: CommentRow) => enqueue(async () => {
      if (!canStore()) return;
      const draft = { ...r, draftOfTab: d.tabId };
      const ok = await write('reply.saveDraft', () => d.store!.saveDraft(draft), stored ? 5000 : FIRST_WRITE_MAX_MS);
      if (ok) stored = true;
    });

    const flushStream = () => {
      timer = null;
      const r = latest;
      latest = null;
      if (r === null || ended) return;
      lastStreamWrite = d.now();
      void saveDraft(r);
    };

    // 1. pending: shown now, stored as this tab's draft as soon as the store has the thread.
    show(row0, onRemove);
    void saveDraft(row0);

    return {
      id: row0.id,
      threadId: row0.threadId,
      stream(body, meta) {
        if (ended) return;
        row = { ...row, body, meta: withExtra(meta, 'streaming'), draftOfTab: d.tabId };
        latest = row;
        const wait = Math.max(0, lastStreamWrite + STREAM_WRITE_MS - d.now());
        if (timer === null) timer = setTimeout(flushStream, wait);
        show(row);
      },
      async finish(body, meta) {
        ended = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        latest = null;
        const final: CommentRow = { ...row, body, meta: withExtra(meta), draftOfTab: null };
        row = final;
        // Shown as final at once; the store's own copy replaces it when it comes back (the change event of the write below).
        show(final);
        await enqueue(async () => {
          if (!canStore()) return; // a PDF the store does not keep: the reply stays in this tab's memory
          // No tabId on purpose: this tab's session then reads the sent row back like any other change.
          const ok = await write('reply.finish', () => d.store!.writeAnnotations([{ table: 'comments', op: 'upsert', row: final }]), FIRST_WRITE_MAX_MS);
          if (!ok) {
            // The store would not take it. The text must not go: keep it as this tab's draft (error), which survives a reload.
            const kept: CommentRow = { ...final, draftOfTab: d.tabId, meta: withExtra({ ...meta, error: replyError('interrupted') }, 'error') };
            row = kept;
            show(kept);
            await write('reply.keep', () => d.store!.saveDraft(kept as CommentRow & { draftOfTab: TabId }), 5000);
          }
        });
      },
      async fail(body, meta) {
        ended = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        latest = null;
        row = { ...row, body, meta: withExtra(meta, 'error'), draftOfTab: d.tabId };
        show(row);
        await saveDraft(row);
      },
      note(more) {
        extra = { ...extra, ...more };
      },
      async discard() {
        ended = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        latest = null;
        rows.delete(row.id);
        d.session.releaseReply?.(row.id);
        await enqueue(async () => {
          if (stored && d.store) await d.store.discardDraft(row.id).catch((e: unknown) => report(e, 'reply.discard'));
        });
      },
    };
  }

  return {
    begin(o) {
      const was = rows.get(o.id) ?? d.session.state().comments.find((c) => c.id === o.id) ?? null;
      const row: CommentRow = {
        id: o.id,
        threadId: o.threadId,
        documentId: o.documentId,
        author: 'claude',
        body: '',
        draftOfTab: d.tabId,
        meta: { ...o.meta, status: 'pending', error: null } as unknown as CommentRow['meta'],
        // Try again keeps the reply where it was in the thread.
        createdAt: was?.createdAt ?? o.createdAt ?? d.now(),
        editedAt: null,
        rev: was?.rev ?? 0,
        hlc: (was?.hlc ?? ''),
        deletedAt: null,
      };
      return writer(row, o.onRemove);
    },

    async sweep(isRunning, onRemove) {
      const docId = d.storedDocumentId();
      if (d.store === null || docId === null) return;
      await d.session.ready.catch(() => undefined);
      // The keeper's adoption claims the drafts of tabs that are gone for this tab, Claude's replies with them.
      await d.session.adoptDrafts().catch((e: unknown) => report(e, 'reply.adopt'));
      let drafts: CommentRow[];
      try {
        drafts = await d.store.listDrafts(docId, d.tabId);
      } catch (e) {
        report(e, 'reply.sweep');
        return;
      }
      for (const r of drafts) {
        if (r.author !== 'claude' || !isClaudeMeta(r.meta) || isRunning(r.id)) continue;
        const meta = r.meta;
        let row: CommentRow = r;
        if (meta.status === 'pending' || meta.status === 'streaming') {
          row = { ...r, meta: { ...meta, status: 'error', error: replyError('interrupted') } as unknown as CommentRow['meta'] };
          const fixed = row;
          await write('reply.interrupted', () => d.store!.saveDraft(fixed as CommentRow & { draftOfTab: TabId }), 5000);
        }
        rows.set(row.id, row);
        d.session.holdReply?.(row, { onRemove: onRemove(row.id) });
      }
    },

    held: (id) => rows.get(id) ?? null,
  };
}
