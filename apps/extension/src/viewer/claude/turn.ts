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
//    sends the reply so far back and the server goes on. At most 1 web search per question: the tool allows 1 and is called
//    directly, so Anthropic counts every search of the question, and once a round has searched, later rounds offer no search.
// 6. The end: done (one write, and the cost is added to this month's spend) or an error (the text so far stays, and Try again uses the
//    same reply). Stop ends it as `cancelled`. A network or key failure loses nothing the owner wrote. An answer cut short by the
//    length limit keeps its text and says so; Try again then asks with more room.
//
// R105, a PDF the owner did not choose for Claude (not in the library, or saved only by a note or a mark): `saved: false`.
// - "Send … to Anthropic?" first (Cancel is the default), unless the owner already said Send for this reading in this tab.
// - The request holds the pack and nothing more: no client tools and no web search, so "Nothing else is sent" is true. A tool
//   call Claude makes anyway is answered without reading the PDF. Held blocks of an earlier answer are not reused.
// - Every page and the pack's words pass the R91 card, bank and ID check first; a hit refuses, and nothing is sent.
// The PDF's privacy is asked again, from the library's own row, right before anything leaves (a save, a Forget or "Never save"
// while the dialog was open). A refusal is a row in the thread that stays until the owner dismisses it.
//
// Network: only the client (client.ts) talks to Anthropic, and only from here, so only when the owner asked a question.
import {
  buildRequest, createStreamMapper, decide, EXPLAIN_FIGURE_QUESTION, MAX_TOKENS, priceFor, replyError,
  type Ask, type CitableBlock, type ClaudeReplyMeta, type ClaudeStreamEvent, type ClaudeTurnRequest, type CommentRow, type ContextPack,
  type ModelChoice, type ModelRole, type ReplyError, type ReplyResult, type ThreadTurn,
} from '@sop/core';
import type { ClaudeClient } from './client';
import { createToolRunner, isClientTool, TOOL_BUDGET, toolCallsOf, type ToolResultBlock } from './client-tools';
import type { ContextBuilder } from './context';
import { CUT_SHORT_MESSAGE, MODEL_GONE_MESSAGE, NOT_SENT_MESSAGE, PRIVATE_MESSAGES, replyErrorOf, type PrivateReason } from './errors';
import { commentsUpTo, earlierInThread, questionText, turnsFor, type ThreadHistory } from './history';
import type { ReplyRows } from './reply-rows';

/** Contract §6: viewer tab only. */
export interface ClaudeTurnRunner {
  run(req: ClaudeTurnRequest, onEvent: (e: ClaudeStreamEvent) => void, signal: AbortSignal): Promise<ClaudeReplyMeta>;
}

/** A turn request with what the entry adds: a fixed question, and the reply Think harder asks again (left out of the turns). */
export type TurnRequest = ClaudeTurnRequest & {
  preset?: 'explain-figure' | 'whole-document';
  skip?: readonly CommentRow['id'][];
  /**
   * False for a PDF the owner did not choose for Claude (R105): not in the library, or saved only by a note or a mark. The request
   * then holds only the pack (no client tools, no web search), after the R91 check. Default true.
   */
  saved?: boolean;
  /** "Send … to Anthropic?" before anything is sent. Default: when `saved` is false. False once the owner said Send on this reading. */
  askFirst?: boolean;
  /** The PDF is in the library (a note or a mark saved it), for the dialog's words. */
  inLibrary?: boolean;
  /** Try again on an answer cut short by the length limit: twice the room. */
  moreRoom?: boolean;
  /**
   * The cost estimate the owner was already shown for this question (Think harder's tooltip). The checks and the ask-first dialog
   * use it, so both say one amount. Without it, the pack's own estimate.
   */
  estimateUsd?: number;
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
  /**
   * R105, the "unsaved" question: the PDF is in the library, but only a note or a mark saved it (not the owner's choice for Claude).
   * The dialog must then not say "This PDF is not in your library".
   */
  inLibrary?: boolean;
  /**
   * R105b, the "unsaved" question: what of the thread goes too, besides the question (Claude reads the earlier notes in the thread).
   * Left out when nothing does. The dialog says "Your earlier notes in this thread go too."
   */
  earlier?: { notes: number; replies: number };
}

/** What the tab's live view of a reply is told (slice F's `claudeLive`): the status line and the text between row writes. */
export interface LiveSink {
  begin(replyId: CommentRow['id'], context?: { passages?: number; figures?: readonly string[]; scope?: 'passages' | 'whole-document'; pages?: number; preparing?: boolean }): void;
  feed(replyId: CommentRow['id'], e: ClaudeStreamEvent): void;
  /** A confirm dialog asks now: "Waiting for you to confirm…", no Stop. */
  waiting?(replyId: CommentRow['id']): void;
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
  /**
   * Why this PDF may not be read now, or null: asked at the start and again right before anything leaves. For a saved PDF it reads
   * the library's row again (D9 `indexText`, R102 `not-learning:saved-by-owner`).
   */
  privacy(): PrivateReason | null | Promise<PrivateReason | null>;
  /** The owner said Send to "Send … to Anthropic?" (R105): later questions on this reading do not ask again. */
  agreed?(): void;
  /** The first question in this paper: the status line says "Getting ready…" while the local search starts. */
  preparing?(): boolean;
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
/** Try again on an answer cut short: this many times the role's usual reply ceiling. */
const MORE_ROOM = 2;
/** What a tool call gets on a PDF the owner did not choose for Claude (the request offers no tools; this is the backstop). */
const NOT_AGREED_TOOL = 'Only the passages the student agreed to send can be read. Answer with what you have, and say what is missing.';

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

/**
 * The web searches in a message's content: `searched` once one has run (its call has a result block), `waiting` while a call has no
 * result yet. The API runs a waiting search at the start of the next request, so that request must still offer the tool.
 */
export function webSearchesIn(content: readonly { type: string; [k: string]: unknown }[]): { searched: boolean; waiting: boolean } {
  const calls = content.filter((b) => b.type === 'server_tool_use' && b.name === 'web_search' && typeof b.id === 'string').map((b) => b.id as string);
  const answered = new Set(content.filter((b) => b.type === 'web_search_tool_result' && typeof b.tool_use_id === 'string').map((b) => b.tool_use_id as string));
  return { searched: calls.some((id) => answered.has(id)) || answered.size > 0, waiting: calls.some((id) => !answered.has(id)) };
}

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
    // R105: a PDF the owner did not choose for Claude gets only the pack, after the owner says Send.
    const restricted = req.saved === false;
    const askFirst = req.askFirst ?? restricted;
    // 1. The row first: the card shows "Reading…" (or "Getting ready…" on the first question in this paper) at once.
    const writer = d.rows.begin({ id: replyId, threadId, documentId: req.documentId, meta: meta0 });
    const preparing = d.preparing?.() === true;
    d.live?.begin(replyId, { scope, ...(preparing ? { preparing } : {}) });
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
    /** The owner deleted the reply while it waited: nothing was sent, and the row goes. */
    const withdraw = async (): Promise<ClaudeReplyMeta> => {
      await writer.discard();
      d.live?.end(replyId);
      return { ...meta0, status: 'error', error: replyError('cancelled') };
    };
    /**
     * R105: Claude does not read this PDF. The thread says why, in a row of Claude's that stays until the owner dismisses it (it has
     * no model and no cost, and offers no Try again). Nothing was sent.
     */
    const refuse = (why: PrivateReason): Promise<ClaudeReplyMeta> => {
      if (removed()) return withdraw();
      const error: ReplyError = { code: 'refused', message: PRIVATE_MESSAGES[why] };
      emit({ type: 'error', error });
      return end({ ...meta0, role: null, status: 'error', error }, '');
    };
    /** R105: the owner pressed Cancel. Nothing was sent; the card says so and offers to ask again (Try again, the same reply). */
    const notSent = (extra: Partial<ClaudeReplyMeta> = {}): Promise<ClaudeReplyMeta> => {
      if (removed()) return withdraw();
      writer.note({ notSent: true });
      return failEarly({ code: 'cancelled', message: NOT_SENT_MESSAGE }, extra);
    };

    try {
      // 2. Checks that send nothing.
      const why = await d.privacy();
      if (why !== null) return await refuse(why);
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
      // R105: a PDF not chosen for Claude never reuses the blocks of an earlier answer (they may hold pages a tool read).
      const usable = held && held.role === role && !restricted ? held : null;
      const skip = new Set([replyId, ...(req.skip ?? [])]);
      // What of the thread goes with the question, for the ask-first dialog's words (its turns are always rebuilt as plain text).
      const earlier = earlierInThread(comments, questionId, skip);
      const { turns: firstTurns, reused } = turnsFor({
        held: usable, comments, questionId, skip,
        ...(req.preset === 'explain-figure' ? { presetQuestion: EXPLAIN_FIGURE_QUESTION } : {}),
      });
      if (firstTurns.length === 0 || firstTurns.at(-1)?.role !== 'user') return await failEarly({ code: 'server', message: 'There is no question to answer in this note.' });
      const webSearch = !restricted && (reused && usable ? usable.webSearch : settings.webSearch && model.webSearchTool !== null);

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
      // R105 and R91: a PDF not in the library is checked for card, bank and ID numbers, every page, before anything can go.
      if (restricted && (await d.context.privateNumbers(pack))) return await refuse('no-text');
      if (removed()) return await withdraw();
      const reading = { passages: sent.passages, figures: sent.figures, scope, ...(sent.pages !== null ? { pages: sent.pages } : {}) };
      d.live?.begin(replyId, reading);
      const meta1: ClaudeReplyMeta = { ...meta0, figureLabels };
      // The model that answered, kept on the row for the record, even after the owner picks another (R107: no card shows it).
      writer.note({ modelName: model.displayName });

      // 4. Cost: cap, "ask first", the whole document. One question at a time, in decide's order.
      const spent = (await d.spend.thisMonth()).usd;
      const estimateUsd = req.estimateUsd !== undefined && Number.isFinite(req.estimateUsd) ? req.estimateUsd : pack.estimate.usd;
      const confirmed: Ask[] = [];
      for (;;) {
        if (removed()) return await withdraw();
        const verdict = decide({
          estimateUsd, spentUsd: spent, capUsd: settings.capUsd, confirmOverUsd: settings.confirmOverUsd,
          saved: !askFirst, scope, priceKnown, confirmed,
        });
        if (verdict === 'send') break;
        if ('block' in verdict) return await failEarly(replyError('over-cap'), { figureLabels });
        // R105: while the dialog asks, the card says so, with no Stop.
        d.live?.waiting?.(replyId);
        const yes = await d.confirm({
          ask: verdict.ask, usd: verdict.usd, passages: sent.passages, figures: sent.figures.length, model: model.displayName,
          thresholdUsd: settings.confirmOverUsd, ...(sent.pages !== null ? { pages: sent.pages } : {}),
          ...(verdict.ask === 'unsaved' && req.inLibrary === true ? { inLibrary: true } : {}),
          ...(verdict.ask === 'unsaved' && earlier.notes > 0 ? { earlier } : {}),
        });
        if (!yes) return await notSent({ figureLabels });
        if (verdict.ask === 'unsaved') d.agreed?.();
        d.live?.begin(replyId, reading);
        confirmed.push(verdict.ask);
      }
      // Asked again right before anything leaves: a save, a Forget, "Never save" or an Undo, here or in another tab, while the
      // owner was answering. A save made meanwhile is read from the library's row, so a D9 or R102 reading is never sent.
      const late = await d.privacy();
      if (late !== null) return await refuse(late);
      if (removed()) return await withdraw();

      // 5. The stream.
      // The citable blocks the mapper reads. It is filled with the first request's blocks BEFORE the mapper is made: the citation
      // book decides once, from the list it is given, whether the blocks carry their place in the request (A5 `via`), and an empty
      // list would make it read every citation as an index into one flat list (all chips on the document map). Later rounds
      // replace the contents (same order, plus the search results the client tools sent), never the list.
      // The request: no client tools for a PDF not chosen for Claude; more room on Try again after a cut-short answer.
      const build = async (t: ThreadTurn[], search: boolean) => {
        const out = await buildRequest(pack, t, { role, model, webSearch: search, clientTools: !restricted });
        if (req.moreRoom === true) out.params.max_tokens = MAX_TOKENS[role] * MORE_ROOM;
        return out;
      };
      const firstRequest = await build(firstTurns, webSearch);
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
      // TB6 security 4: at most 1 web search per question. The tool is offered until a round has searched; a paused turn, or a
      // round whose search still waits to run, keeps the same tools (the API needs them to go on).
      let searchNow = webSearch;
      let searched = false;

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
          const built = turns.length === firstTurns.length && pausedTail === null ? firstRequest : await build(turns, searchNow);
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
          const searches = webSearchesIn(contentOf(final));
          searched = searched || searches.searched;
          if (stop === 'pause_turn' && pauses < MAX_PAUSES) {
            pauses += 1;
            pausedTail = content;
            continue;
          }
          pausedTail = null;
          // Once a search has run (and none waits for this next request), later rounds go without web search.
          if (searched && !searches.waiting) searchNow = false;
          const calls = toolCallsOf(content);
          if (stop === 'tool_use' && calls.length > 0 && toolRounds < TOOL_BUDGET[role].calls) {
            toolRounds += 1;
            turns.push({ role: 'assistant', content });
            if (stall !== null) clearTimeout(stall);
            // R105: the request offered no tools; a call Claude makes anyway reads nothing from the PDF.
            const answers: ToolResultBlock[] = restricted
              ? calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: NOT_AGREED_TOOL }))
              : await tools.run(calls, call.signal);
            for (const c of calls) if (isClientTool(c.name)) emit({ type: 'tool', tool: c.name, state: 'done', label: 'Writing…' });
            turns.push({ role: 'user', content: answers as unknown as { type: string; [k: string]: unknown }[] });
            continue;
          }
          finalContent = content;
          result = mapper.finish(final);
          // R105: the length limit stopped the answer. It keeps its text and says so; Try again asks with more room.
          if (result.status === 'done' && stop === 'max_tokens') {
            writer.note({ cutShort: true });
            result = mapper.fail({ code: 'interrupted', message: CUT_SHORT_MESSAGE });
          }
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

