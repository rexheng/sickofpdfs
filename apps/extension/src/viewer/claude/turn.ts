// One Claude turn, end to end (contract §6 `ClaudeTurnRunner`; plan §4 D): the checks, the context pack, the stream, the client
// tools and the reply row. Viewer tab only.
//
// What happens, in order:
// 1. The reply row is made at once (pending), so the card says "Reading…" while the rest is worked out.
// 2. Checks that send nothing: a model is chosen, a key is saved, the PDF may be read (never an unsaved or private PDF).
// 3. The pack is built here (context.ts). A follow-up in a thread this tab has answered reuses the exact pack and blocks, so the
//    prompt cache holds.
// 4. Cost: `decide` (slice H) with this month's spend, the cap and "ask first". Each ask waits for the owner's answer; No sends
//    nothing and the reply goes. Over the cap, the reply says so and nothing is sent.
// 5. The stream: Anthropic's events go through slice A's mapper into contract events (the status line and the live text) and the
//    row (written at most every 500 ms). `tool_use` runs the client tools and asks again; `pause_turn` (the server's own loop paused)
//    sends the reply so far back and the server goes on. At most 1 web search per question (the request builder sets max_uses).
// 6. The end: done (one write, and the cost is added to this month's spend) or an error (the text so far stays, and Try again uses the
//    same reply). Stop ends it as `cancelled`. A network or key failure loses nothing the owner wrote.
//
// Network: only the client (client.ts) talks to Anthropic, and only from here, so only when the owner asked a question.
import {
  buildRequest, createStreamMapper, decide, EXPLAIN_FIGURE_QUESTION, priceFor, replyError,
  type Ask, type CitableBlock, type ClaudeReplyMeta, type ClaudeStreamEvent, type ClaudeTurnRequest, type CommentRow, type ContextPack,
  type ModelChoice, type ModelRole, type ReplyError, type ReplyResult, type ThreadTurn,
} from '@sop/core';
import type { ClaudeClient } from './client';
import { createToolRunner, isClientTool, TOOL_BUDGET, toolCallsOf } from './client-tools';
import type { ContextBuilder } from './context';
import { MODEL_GONE_MESSAGE, replyErrorOf, type PrivateReason } from './errors';
import { commentsUpTo, questionText, turnsFor, type ThreadHistory } from './history';
import type { ReplyRows } from './reply-rows';

/** Contract §6: viewer tab only. */
export interface ClaudeTurnRunner {
  run(req: ClaudeTurnRequest, onEvent: (e: ClaudeStreamEvent) => void, signal: AbortSignal): Promise<ClaudeReplyMeta>;
}

/** A turn request with what the entry adds: a fixed question, and the reply Think harder asks again (left out of the turns). */
export type TurnRequest = ClaudeTurnRequest & {
  preset?: 'explain-figure' | 'whole-document';
  skip?: readonly CommentRow['id'][];
  /** False for a PDF that is not in the library yet (the filter was not sure): nothing is sent before the owner says Send. Default true. */
  saved?: boolean;
};

/** The owner's Claude settings (contract §6 settings keys), as they are when the question is asked. */
export interface TurnSettings {
  models: Readonly<Record<ModelRole, ModelChoice | null>>;
  webSearch: boolean;
  capUsd: number | null;
  confirmOverUsd: number | null;
}

/** A question for the owner before anything is sent (the shape slice F's confirm dialog takes). */
export interface ConfirmRequest {
  ask: Ask;
  usd: number;
  passages?: number;
  figures?: number;
  pages?: number;
  model?: string | null;
  thresholdUsd?: number | null;
}

/** What the tab's live view of a reply is told (slice F's `claudeLive`): the status line and the text between row writes. */
export interface LiveSink {
  begin(replyId: CommentRow['id'], context?: { passages?: number; figures?: readonly string[]; scope?: 'passages' | 'whole-document'; pages?: number }): void;
  feed(replyId: CommentRow['id'], e: ClaudeStreamEvent): void;
  end(replyId: CommentRow['id']): void;
}

export interface TurnDeps {
  client(): Promise<ClaudeClient | { error: 'no-key' }>;
  context: ContextBuilder;
  rows: ReplyRows;
  history: ThreadHistory;
  settings(): Promise<TurnSettings>;
  spend: { thisMonth(): Promise<{ usd: number }>; addSpend(usd: number): Promise<unknown> };
  /** Asks the owner; true for Send. Nothing is sent before a yes. */
  confirm(r: ConfirmRequest): Promise<boolean>;
  /** Why this PDF may not be read now (checked again right before sending), or null. */
  privacy(): PrivateReason | null;
  /** The thread's comments as this tab shows them. */
  comments(threadId: ClaudeTurnRequest['threadId']): readonly CommentRow[];
  pageCount: number;
  live?: LiveSink | null;
  now(): number;
  onError?(e: unknown, where: string): void;
}

/** A stream that sends nothing for this long has failed (the connection is stuck). */
export const STALL_MS = 90_000;
/** How often the reply's row (and the card) follow the stream; the live text in between comes from the events. */
const SNAPSHOT_MS = 500;
/** `pause_turn` continuations allowed in one turn. */
const MAX_PAUSES = 3;

/** Why a turn was aborted, as the entry says it. */
export type AbortReason = 'stop' | 'removed';

const metaOf = (r: ReplyResult): ClaudeReplyMeta => {
  const { body: _body, ...meta } = r;
  void _body;
  return meta;
};

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const stopReasonOf = (m: unknown): string | null => (isRec(m) && typeof m.stop_reason === 'string' ? m.stop_reason : null);
const contentOf = (m: unknown): { type: string; [k: string]: unknown }[] => (isRec(m) && Array.isArray(m.content) ? (m.content as { type: string }[]) : []);

/** Held packs and the cost of Think harder on them, for the entry. */
export interface TurnMemory {
  lastPack(threadId: ClaudeTurnRequest['threadId']): ContextPack | null;
}

export function createTurnRunner(d: TurnDeps): ClaudeTurnRunner & TurnMemory {
  const packs = new Map<ClaudeTurnRequest['threadId'], ContextPack>();
  const report = (e: unknown, where: string) => {
    try {
      d.onError?.(e, where);
    } catch {
      /* never let a logger break a reply */
    }
  };

  async function run(req: TurnRequest, onEvent: (e: ClaudeStreamEvent) => void, signal: AbortSignal): Promise<ClaudeReplyMeta> {
    const { replyId, threadId, questionId, role, scope } = req;
    const emit = (e: ClaudeStreamEvent) => {
      try {
        d.live?.feed(replyId, e);
      } catch (err) {
        report(err, 'live.feed');
      }
      try {
        onEvent(e);
      } catch (err) {
        report(err, 'onEvent');
      }
    };
    const meta0: ClaudeReplyMeta = {
      kind: 'claude-reply', v: 1, role, status: 'pending', error: null, questionId, citations: [], webSources: [], usage: null,
      scope, figureLabels: [], via: 'viewer',
    };
    // 1. The row first: the card shows "Reading…" at once.
    const writer = d.rows.begin({ id: replyId, threadId, documentId: req.documentId, meta: meta0 });
    d.live?.begin(replyId, { scope });
    emit({ type: 'status', status: 'pending' });
    const removed = () => signal.aborted && signal.reason === 'removed';
    const stopped = () => signal.aborted && signal.reason !== 'removed';

    const end = async (meta: ClaudeReplyMeta, body: string): Promise<ClaudeReplyMeta> => {
      if (removed()) {
        await writer.discard();
      } else if (meta.status === 'done') {
        await writer.finish(body, meta);
      } else {
        await writer.fail(body, meta);
      }
      d.live?.end(replyId);
      return meta;
    };
    const failEarly = (error: ReplyError, extra: Partial<ClaudeReplyMeta> = {}) => {
      emit({ type: 'error', error });
      return end({ ...meta0, ...extra, status: 'error', error }, '');
    };
    /** The owner said No to a question: nothing was sent, and the reply goes. */
    const withdraw = async (): Promise<ClaudeReplyMeta> => {
      await writer.discard();
      d.live?.end(replyId);
      return { ...meta0, status: 'error', error: replyError('cancelled') };
    };

    try {
      // 2. Checks that send nothing.
      const why = d.privacy();
      if (why !== null) return await withdraw();
      // The key first: with no key there is nothing to set up but the key ("Add your Claude key in Settings").
      const client = await d.client();
      if ('error' in client) return await failEarly(replyError('no-key'));
      const settings = await d.settings();
      const model = settings.models[role];
      if (!model) return await failEarly({ code: 'no-model', message: role === 'think-harder' ? 'Choose a Think harder model in Settings.' : 'Choose your Claude model in Settings.' });
      if (stopped()) return await failEarly(replyError('cancelled'));
      if (removed()) return await withdraw();

      // 3. The turns and the pack. A follow-up in a thread this tab answered reuses the exact blocks and pack.
      const comments = d.comments(threadId);
      const question = comments.find((c) => c.id === questionId) ?? null;
      const words = req.preset === 'explain-figure' ? EXPLAIN_FIGURE_QUESTION : questionText(question?.body ?? '');
      const held = d.history.get(threadId);
      const usable = held && held.role === role ? held : null;
      const { turns: firstTurns, reused } = turnsFor({
        held: usable, comments, questionId, skip: new Set([replyId, ...(req.skip ?? [])]),
        ...(req.preset === 'explain-figure' ? { presetQuestion: EXPLAIN_FIGURE_QUESTION } : {}),
      });
      if (firstTurns.length === 0 || firstTurns.at(-1)?.role !== 'user') return await failEarly({ code: 'server', message: 'There is no question to answer in this note.' });
      const webSearch = reused && usable ? usable.webSearch : settings.webSearch && model.webSearchTool !== null;

      let pack: ContextPack;
      let figureLabels: string[];
      let sent: { passages: number; figures: string[]; pages: number | null };
      let priceKnown: boolean;
      if (reused && usable) {
        pack = usable.pack;
        figureLabels = usable.figureLabels;
        sent = { passages: (pack.focus ? 1 : 0) + pack.passages.length, figures: figureLabels, pages: null };
        priceKnown = priceFor(model).basis !== 'unknown-line';
      } else {
        const built = await d.context.build({ question: words || EXPLAIN_FIGURE_QUESTION, anchor: req.focus, role, model, scope, webSearch, ...(req.preset ? { preset: req.preset } : {}), signal });
        pack = built.pack;
        figureLabels = built.figureLabels;
        sent = built.sent;
        priceKnown = built.priceKnown;
      }
      packs.set(threadId, pack);
      d.live?.begin(replyId, { passages: sent.passages, figures: sent.figures, scope, ...(sent.pages !== null ? { pages: sent.pages } : {}) });
      const meta1: ClaudeReplyMeta = { ...meta0, figureLabels };
      // The cost line names the model that answered, even after the owner picks another (slice F reads `meta.modelName`).
      writer.note({ modelName: model.displayName });

      // 4. Cost: cap, "ask first", the whole document. One question at a time, in decide's order.
      const spent = (await d.spend.thisMonth()).usd;
      const confirmed: Ask[] = [];
      for (;;) {
        if (removed()) return await withdraw();
        const verdict = decide({
          estimateUsd: pack.estimate.usd, spentUsd: spent, capUsd: settings.capUsd, confirmOverUsd: settings.confirmOverUsd,
          saved: req.saved !== false, scope, priceKnown, confirmed,
        });
        if (verdict === 'send') break;
        if ('block' in verdict) return await failEarly(replyError('over-cap'), { figureLabels });
        const yes = await d.confirm({
          ask: verdict.ask, usd: verdict.usd, passages: sent.passages, figures: sent.figures.length, model: model.displayName,
          thresholdUsd: settings.confirmOverUsd, ...(sent.pages !== null ? { pages: sent.pages } : {}),
        });
        if (!yes) return await withdraw();
        confirmed.push(verdict.ask);
      }
      // Asked again right before anything leaves (a forget or an Undo in another tab while the owner was answering).
      if (d.privacy() !== null) return await withdraw();

      // 5. The stream.
      // The citable blocks the mapper reads. It is filled with the first request's blocks BEFORE the mapper is made: the citation
      // book decides once, from the list it is given, whether the blocks carry their place in the request (A5 `via`), and an empty
      // list would make it read every citation as an index into one flat list (all chips on the document map). Later rounds
      // replace the contents (same order, plus the search results the client tools sent), never the list.
      const firstRequest = await buildRequest(pack, firstTurns, { role, model, webSearch });
      const blocks: CitableBlock[] = [...firstRequest.blocks];
      let snapTimer: ReturnType<typeof setTimeout> | null = null;
      let finished = false;
      const mapper = createStreamMapper(
        blocks,
        (e) => {
          emit(e);
          if (!finished && snapTimer === null && (e.type === 'text' || e.type === 'citation' || e.type === 'web-source' || e.type === 'status')) {
            snapTimer = setTimeout(() => {
              snapTimer = null;
              if (finished) return;
              const snap = mapper.snapshot();
              writer.stream(snap.body, metaOf(snap));
            }, SNAPSHOT_MS);
          }
        },
        { role, questionId, scope, figureLabels, price: priceFor(model) },
      );
      const tools = createToolRunner({ context: d.context, role, model, pageCount: d.pageCount });
      const turns: ThreadTurn[] = [...firstTurns];
      let pausedTail: { type: string; [k: string]: unknown }[] | null = null;
      let pauses = 0;
      let toolRounds = 0;
      let result: ReplyResult;
      let finalContent: { type: string; [k: string]: unknown }[] = [];

      // The call stops on Stop, on a delete, and when the stream goes silent for too long.
      const call = new AbortController();
      const onAbort = () => call.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      let stall: ReturnType<typeof setTimeout> | null = null;
      const alive = () => {
        if (stall !== null) clearTimeout(stall);
        stall = setTimeout(() => call.abort('stall'), STALL_MS);
      };
      try {
        for (;;) {
          const built = turns.length === firstTurns.length && pausedTail === null ? firstRequest : await buildRequest(pack, turns, { role, model, webSearch });
          blocks.splice(0, blocks.length, ...built.blocks);
          const params = built.params;
          if (pausedTail) params.messages.push({ role: 'assistant', content: pausedTail });
          alive();
          const stream = client.stream(params, { signal: call.signal });
          for await (const ev of stream) {
            alive();
            mapper.push(ev);
          }
          const final = await stream.final();
          const stop = stopReasonOf(final);
          const content: { type: string; [k: string]: unknown }[] = [...(pausedTail ?? []), ...contentOf(final)];
          if (stop === 'pause_turn' && pauses < MAX_PAUSES) {
            pauses += 1;
            pausedTail = content;
            continue;
          }
          pausedTail = null;
          const calls = toolCallsOf(content);
          if (stop === 'tool_use' && calls.length > 0 && toolRounds < TOOL_BUDGET[role].calls) {
            toolRounds += 1;
            turns.push({ role: 'assistant', content });
            if (stall !== null) clearTimeout(stall);
            const answers = await tools.run(calls, call.signal);
            for (const c of calls) if (isClientTool(c.name)) emit({ type: 'tool', tool: c.name, state: 'done', label: 'Writing…' });
            turns.push({ role: 'user', content: answers as unknown as { type: string; [k: string]: unknown }[] });
            continue;
          }
          finalContent = content;
          result = mapper.finish(final);
          break;
        }
      } catch (e) {
        const error = removed() ? replyError('cancelled') : stopped() ? replyError('cancelled') : call.signal.reason === 'stall' ? replyError('network') : replyErrorOf(e);
        result = mapper.fail(error);
      } finally {
        finished = true;
        if (snapTimer !== null) clearTimeout(snapTimer);
        if (stall !== null) clearTimeout(stall);
        signal.removeEventListener('abort', onAbort);
      }

      // 6. The end: the row, the spend (real usage, even for a reply cut short: Anthropic bills what it sent), the held thread.
      const meta = metaOf(result);
      const usd = meta.usage?.usd ?? 0;
      if (usd > 0) await d.spend.addSpend(usd).catch((e: unknown) => report(e, 'spend'));
      if (meta.status === 'done' && !removed()) {
        // The comments the turns stand for, so a later follow-up can tell whether the held blocks still match the thread.
        const upTo = commentsUpTo(comments, questionId, new Set([replyId, ...(req.skip ?? [])])).map((c) => c.id);
        const ids = [...(reused && usable ? [...usable.commentIds, ...upTo.slice(usable.commentIds.length)] : upTo), replyId];
        d.history.set(threadId, { pack, turns: [...turns, { role: 'assistant', content: finalContent }], commentIds: ids, role, webSearch, figureLabels });
      }
      return await end({ ...meta1, ...meta }, result.body);
    } catch (e) {
      // Anything unexpected (the pack could not be built, the store went away): nothing more is sent, and the reply says so.
      report(e, 'turn');
      if (removed()) return await withdraw();
      const error = e instanceof Error && /model/i.test(e.message) ? { code: 'no-model' as const, message: MODEL_GONE_MESSAGE } : replyError('server');
      return await failEarly(error);
    }
  }

  return { run, lastPack: (id) => packs.get(id) ?? null };
}

