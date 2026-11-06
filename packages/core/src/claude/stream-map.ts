// Turns the raw Messages stream back into contract events, a Markdown body and `ClaudeReplyMeta`.
//
// `push` takes the stream events exactly as the API sends them (the SDK's stream yields the same objects). `finish` takes the
// final message. The body cites with `[Page 4](cite:n)` and `[source](web:n)`; the chip for a cited text goes right after it.
// One mapper serves a whole turn: when Claude uses a tool and the runner sends a second request, keep pushing into the same
// mapper so numbering, text and cost carry on.
//
// This file never sees the key and never logs. Error text from the API is not copied into replies.
import { createCitationBook, pageLink, webLink, type ResolvedCitation } from './citations';
import { usdFromUsage, type UsageTokens } from './cost';
import type { ModelPrice } from './pricing';
import { describeToolUse, EXPLAIN_FIGURE_QUESTION } from './prompts';
import { replyError, type CitableBlock, type ClaudeReplyMeta, type ClaudeStreamEvent, type ModelRole, type ReplyError } from './types';

export { EXPLAIN_FIGURE_QUESTION };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object';
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface MapperOptions {
  role?: ModelRole | null;
  questionId?: ClaudeReplyMeta['questionId'];
  scope?: ClaudeReplyMeta['scope'];
  figureLabels?: string[];
  /** For the dollar figure in `usage`. Without it `usd` is 0, which means "not priced", so always pass it. */
  price?: ModelPrice | null;
}

export type ReplyResult = ClaudeReplyMeta & { body: string };

export interface StreamMapper {
  push(rawEvent: unknown): void;
  /** Ends the reply. Emits `done`, or `error` when Claude declined. */
  finish(finalMessage: unknown): ReplyResult;
  /** Ends the reply with an error and keeps the text so far (a dropped connection, Stop, a bad key). Emits `error`. */
  fail(error: ReplyError): ReplyResult;
  /** The reply as it stands, status `streaming`: for the row write every 500 ms. Emits nothing. */
  snapshot(): ReplyResult;
  /** The last stop reason seen: `end_turn`, `max_tokens`, `tool_use`, `pause_turn`, `refusal`... */
  stopReason(): string | null;
}

/** A stream `error` event or an HTTP failure, in plain words. The raw message is never copied. */
export function replyErrorFromApi(apiErrorType: string | null, httpStatus: number | null = null): ReplyError {
  // No HTTP status and no API error type: the connection itself failed (offline, cut off, timed out).
  if (apiErrorType === null && httpStatus === null) return replyError('network');
  if (apiErrorType === 'authentication_error' || apiErrorType === 'permission_error' || httpStatus === 401 || httpStatus === 403) return replyError('bad-key');
  // TB6 (R105 slice C1): an overloaded server (HTTP 529) is the same to the owner as a busy one: wait a moment, then Try again.
  if (apiErrorType === 'rate_limit_error' || apiErrorType === 'overloaded_error' || httpStatus === 429 || httpStatus === 529) return replyError('rate-limited');
  return replyError('server');
}

interface OpenBlock { type: string; name: string; json: string; input: unknown; citations: unknown[] }
interface MessageUsage extends UsageTokens { searchBlocks: number }

export function createStreamMapper(blocks: readonly CitableBlock[], onEvent: (e: ClaudeStreamEvent) => void, opts: MapperOptions = {}): StreamMapper {
  const book = createCitationBook(blocks);
  const open = new Map<number, OpenBlock>();
  const messages: MessageUsage[] = [];
  let body = '';
  let pendingWs = '';
  let needSeparator = false;
  let sawContent = false;
  let streaming = false;
  let stopReason: string | null = null;
  let ended = false;
  let failure: ReplyError | null = null;

  const emit = (e: ClaudeStreamEvent) => onEvent(e);

  function write(s: string) {
    if (s === '') return;
    body += s;
    emit({ type: 'text', delta: s });
  }

  /** Text goes out at once, except trailing white space, which waits so a chip can sit right after the words. */
  function pushText(delta: string) {
    if (delta === '') return;
    if (needSeparator) {
      needSeparator = false;
      if (body !== '' && !/\s$/.test(body + pendingWs)) write('\n\n');
    }
    const all = pendingWs + delta;
    const tail = /\s+$/.exec(all);
    pendingWs = tail ? tail[0] : '';
    write(tail ? all.slice(0, tail.index) : all);
  }

  function announce(r: ResolvedCitation) {
    if (!r.isNew) return;
    if (r.kind === 'page') emit({ type: 'citation', citation: r.citation });
    else emit({ type: 'web-source', source: r.source });
  }

  function closeText(b: OpenBlock) {
    const links: string[] = [];
    const seen = new Set<string>();
    for (const raw of b.citations) {
      for (const r of book.resolve(raw)) {
        announce(r);
        const key = r.kind === 'page' ? `p${r.citation.n}` : `w${r.source.n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push(r.kind === 'page' ? pageLink(r.citation) : webLink(r.source));
      }
    }
    const chips = links.join(' ');
    // A chip follows every cited stretch of text, even when the one before it was the same chip: a sentence with no chip reads as
    // unsourced. (Merging repeats for tidiness is the UI's job at render time, never the data's.)
    if (chips !== '') write(`${body !== '' ? ' ' : ''}${chips}`);
    // Trailing white space stays pending: it is written only if more text follows, so a reply never ends in a space.
  }

  function current(): MessageUsage {
    return messages[messages.length - 1] ?? startMessage(undefined);
  }

  function startMessage(usage: unknown): MessageUsage {
    const m: MessageUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, searchBlocks: 0 };
    messages.push(m);
    readUsage(m, usage);
    return m;
  }

  function readUsage(m: MessageUsage, usage: unknown) {
    if (!isRec(usage)) return;
    m.inputTokens = num(usage.input_tokens) ?? m.inputTokens;
    m.outputTokens = num(usage.output_tokens) ?? m.outputTokens;
    m.cacheReadTokens = num(usage.cache_read_input_tokens) ?? m.cacheReadTokens;
    m.cacheWriteTokens = num(usage.cache_creation_input_tokens) ?? m.cacheWriteTokens;
    const tool = usage.server_tool_use;
    if (isRec(tool)) m.webSearches = num(tool.web_search_requests) ?? m.webSearches;
  }

  function usageTotal(): ClaudeReplyMeta['usage'] {
    if (messages.length === 0) return null;
    let sum: UsageTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
    let usd = 0;
    for (const m of messages) {
      const one: UsageTokens = { ...m, webSearches: Math.max(m.webSearches, m.searchBlocks) };
      sum = {
        inputTokens: sum.inputTokens + one.inputTokens, outputTokens: sum.outputTokens + one.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + one.cacheReadTokens, cacheWriteTokens: sum.cacheWriteTokens + one.cacheWriteTokens,
        webSearches: sum.webSearches + one.webSearches,
      };
      if (opts.price) usd += usdFromUsage(one, opts.price);
    }
    return { ...sum, usd };
  }

  function metaOf(status: ClaudeReplyMeta['status'], error: ReplyError | null): ClaudeReplyMeta {
    return {
      kind: 'claude-reply', v: 1, role: opts.role ?? null, status, error,
      questionId: opts.questionId ?? null,
      citations: book.citations(), webSources: book.webSources(), usage: usageTotal(),
      scope: opts.scope ?? 'passages', figureLabels: opts.figureLabels ?? [], via: 'viewer',
    };
  }

  const result = (status: ClaudeReplyMeta['status'], error: ReplyError | null): ReplyResult => ({ ...metaOf(status, error), body });

  /** Ends the reply with an error, once. A second call (an `error` event, then the runner's own `fail`) changes nothing and emits nothing. */
  function failNow(error: ReplyError): ReplyResult {
    if (failure) return result('error', failure);
    failure = error;
    ended = true;
    emit({ type: 'error', error });
    return result('error', error);
  }

  function markStreaming() {
    if (streaming) return;
    streaming = true;
    emit({ type: 'status', status: 'streaming' });
  }

  function onBlockStart(index: number, cb: unknown) {
    if (!isRec(cb) || typeof cb.type !== 'string') return;
    sawContent = true;
    const b: OpenBlock = { type: cb.type, name: typeof cb.name === 'string' ? cb.name : '', json: '', input: cb.input, citations: [] };
    open.set(index, b);
    if (cb.type === 'text') {
      if (Array.isArray(cb.citations)) for (const c of cb.citations as unknown[]) b.citations.push(c);
      if (typeof cb.text === 'string' && cb.text !== '') pushText(cb.text);
    } else if (cb.type === 'web_search_tool_result') {
      emit({ type: 'tool', tool: 'web_search', state: 'done', label: Array.isArray(cb.content) ? 'Searched the web.' : "The web search didn't work." });
    }
  }

  function onBlockStop(index: number) {
    const b = open.get(index);
    open.delete(index);
    if (!b) return;
    if (b.type === 'text') return closeText(b);
    if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      let input = b.input;
      if (b.json !== '') {
        try {
          input = JSON.parse(b.json) as unknown;
        } catch {
          input = undefined; // a cut-off or invalid tool input: the label falls back to the plain form
        }
      }
      needSeparator = true;
      if (b.type === 'server_tool_use') {
        if (b.name !== 'web_search') return; // dynamic filtering runs code on the server: nothing to show
        current().searchBlocks += 1;
        emit({ type: 'tool', tool: 'web_search', state: 'running', label: describeToolUse('web_search', input) });
      } else if (b.name === 'search_document' || b.name === 'get_pages' || b.name === 'get_figure') {
        emit({ type: 'tool', tool: b.name, state: 'running', label: describeToolUse(b.name, input) });
      }
    }
  }

  function onDelta(index: number, delta: unknown) {
    if (!isRec(delta)) return;
    const b = open.get(index);
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      if (b?.type === 'text' || b === undefined) pushText(delta.text);
    } else if (delta.type === 'citations_delta' && b?.type === 'text') {
      b.citations.push(delta.citation);
    } else if (delta.type === 'input_json_delta' && b && typeof delta.partial_json === 'string') {
      b.json += delta.partial_json;
    }
  }

  function push(raw: unknown) {
    if (!isRec(raw) || ended) return;
    switch (raw.type) {
      case 'message_start': {
        markStreaming();
        startMessage(isRec(raw.message) ? raw.message.usage : undefined);
        return;
      }
      case 'content_block_start':
        markStreaming();
        if (typeof raw.index === 'number') onBlockStart(raw.index, raw.content_block);
        return;
      case 'content_block_delta':
        if (typeof raw.index === 'number') onDelta(raw.index, raw.delta);
        return;
      case 'content_block_stop':
        if (typeof raw.index === 'number') onBlockStop(raw.index);
        return;
      case 'message_delta': {
        const m = current();
        if (isRec(raw.delta) && typeof raw.delta.stop_reason === 'string') stopReason = raw.delta.stop_reason;
        readUsage(m, raw.usage);
        return;
      }
      case 'error': {
        const type = isRec(raw.error) && typeof raw.error.type === 'string' ? raw.error.type : null;
        failNow(replyErrorFromApi(type));
        return;
      }
      default:
        return; // ping, message_stop, and any event kind added later
    }
  }

  /** A message that did not arrive as a stream (the SDK's final message alone): play it through the same code. */
  function replay(message: Rec) {
    push({ type: 'message_start', message: { usage: message.usage } });
    (message.content as unknown[]).forEach((c, index) => {
      if (!isRec(c)) return;
      if (c.type === 'text') {
        push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: typeof c.text === 'string' ? c.text : '' } });
        if (Array.isArray(c.citations)) for (const citation of c.citations as unknown[]) push({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } });
      } else {
        push({ type: 'content_block_start', index, content_block: c });
      }
      push({ type: 'content_block_stop', index });
    });
    push({ type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: message.usage });
    push({ type: 'message_stop' });
  }

  return {
    push,
    finish(finalMessage) {
      if (failure) return result('error', failure); // an `error` event or `fail` already ended the reply: it is never `done`
      const final = isRec(finalMessage) ? finalMessage : {};
      if (!sawContent && Array.isArray(final.content) && final.content.length > 0) replay(final);
      else if (messages.length > 0) readUsage(current(), final.usage); // the final message is the authority on the last request's usage
      if (typeof final.stop_reason === 'string') stopReason = final.stop_reason;
      if (stopReason === 'refusal') return failNow(replyError('refused'));
      // No stop reason means the stream just stopped: a cut-off reply must keep its text and offer Try again, not look finished.
      if (stopReason === null) return failNow(replyError('interrupted'));
      ended = true;
      const meta = metaOf('done', null);
      emit({ type: 'done', meta });
      return { ...meta, body };
    },
    fail: failNow,
    snapshot: () => (failure ? result('error', failure) : result('streaming', null)),
    stopReason: () => stopReason,
  };
}
