/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- these tests read wire JSON from an API we do not own, and cast modules that did not exist when they were written */
// Shared helpers for the spec-blind Phase 4 tests, slices A (request builder, stream mapper), H (cost) and E (replay double).
// Test code only: nothing in src/ imports this file.
//
// It declares the contract shapes it needs LOCALLY and imports nothing from src/claude, so every test file loads and fails for
// the real reason (a missing module, a wrong behaviour) and not because a type or a helper is absent. Each test imports its
// function straight from the module the plan names.
//
// No model id string appears here (CLAUDE.md, standing constraints). Model choices are fake data, as the owner decided:
// ids are only ever data from the Models API, never code.

// ---------------------------------------------------------------------------------------------------------------------
// Contract shapes, copied from contracts section 3, section 6 and plan section 8 (A1, A5)

export type Role = 'default' | 'think-harder';

export interface ModelChoice {
  id: string;
  displayName: string;
  line: string | null;
  imageInput: boolean;
  webSearchTool: string | null;
  maxInputTokens: number | null;
  checkedAt: number;
}

export interface Passage { documentId: string; pageIndex: number; start: number; end: number; textSource: string; text: string; rank: number; tokens: number }
export interface DocumentMap {
  title: string | null;
  abstract: Passage | null;
  headings: { text: string; pageIndex: number }[];
  figures: { label: string; pageIndex: number; caption: string }[];
}
export interface RegionImage { blob: Blob; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number; scale: number; visualTokens: number }
export interface FigurePack { label: string | null; pageIndex: number; image: RegionImage; caption: Passage | null; insideText: string; mentions: Passage[] }
export interface CitableBlock {
  title: string; pageIndex: number; start: number; end: number; textSource: string;
  via?: { kind: 'document' | 'search_result'; index: number; block: number };
}
export interface ContextPack {
  map: DocumentMap; focus: Passage | null; passages: Passage[]; figures: FigurePack[]; blocks: CitableBlock[];
  estimate: { inputTokens: number; usd: number };
}
/** The contract names `ThreadTurn` but never defines it. GUESS: a role and the turn's text. `content` repeats the text so a
 *  builder that reads `content` as a string works too. See the report. */
export interface ThreadTurn { role: 'user' | 'assistant'; text: string; content: string }
export const userTurn = (text: string): ThreadTurn => ({ role: 'user', text, content: text });
export const assistantTurn = (text: string): ThreadTurn => ({ role: 'assistant', text, content: text });

export interface PageCitation { n: number; pageIndex: number; start: number; end: number; textSource: string; quote: string }
export interface WebSource { n: number; url: string; title: string; citedText: string | null }
export interface ReplyError { code: string; message: string }
export interface ReplyMeta {
  kind: 'claude-reply'; v: 1; role: Role | null; status: 'pending' | 'streaming' | 'done' | 'error'; error: ReplyError | null;
  questionId: string | null; citations: PageCitation[]; webSources: WebSource[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearches: number; usd: number } | null;
  scope: string; figureLabels: string[]; via: string;
}
export type StreamEvent =
  | { type: 'status'; status: 'pending' | 'streaming' } | { type: 'text'; delta: string }
  | { type: 'citation'; citation: PageCitation } | { type: 'web-source'; source: WebSource }
  | { type: 'tool'; tool: string; state: 'running' | 'done'; label: string }
  | { type: 'done'; meta: ReplyMeta } | { type: 'error'; error: ReplyError };

export interface BuildRequestApi {
  (pack: ContextPack, turns: ThreadTurn[], o: { role: Role; model: ModelChoice; webSearch: boolean }): unknown;
}
export interface StreamMapper { push(raw: unknown): void; finish(finalMessage: unknown): ReplyMeta & { body: string } }
export type CreateStreamMapper = (blocks: CitableBlock[], onEvent: (e: StreamEvent) => void) => StreamMapper;

/** Anything a request or a stream is made of: JSON. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- wire JSON from an API we do not own

// ---------------------------------------------------------------------------------------------------------------------
// Fake model choices (data from a pretend Models API). The ids carry misleading words on purpose: nothing may infer a line
// or a price from an id ("do not infer a line from the id").

export const checkedAt = 1_762_000_000_000;
export const DEFAULT_MODEL: ModelChoice = { id: 'fixture-model-default-0001', displayName: 'Claude Haiku 5.5', line: 'haiku', imageInput: true, webSearchTool: 'fixture_web_search_a', maxInputTokens: 200_000, checkedAt };
export const THINK_MODEL: ModelChoice = { id: 'fixture-model-think-0002', displayName: 'Claude Opus 5.5', line: 'opus', imageInput: true, webSearchTool: 'fixture_web_search_b', maxInputTokens: 1_000_000, checkedAt };
export const SONNET_MODEL: ModelChoice = { id: 'fixture-model-middle-0003', displayName: 'Claude Sonnet 5.5', line: 'sonnet', imageInput: true, webSearchTool: 'fixture_web_search_a', maxInputTokens: 1_000_000, checkedAt };
export const modelChoice = (over: Partial<ModelChoice>): ModelChoice => ({ ...DEFAULT_MODEL, ...over });

// ---------------------------------------------------------------------------------------------------------------------
// A context pack made of passages with unique sentinels, so a test can count how often a piece of the pack reaches the request.

const FILLER = [
  'The estimator compares units that adopt the policy with units that never do.',
  'Standard errors are clustered at the level of the treated group.',
  'Section headings in the paper follow the usual order of an applied study.',
  'We report the point estimate together with a ninety five percent interval.',
  'The sample covers eleven years of administrative records.',
  'Robustness checks vary the window and the set of control units.',
];

/** About `chars` characters of plain sentences, starting with `lead`. Deterministic. */
export function prose(lead: string, chars: number): string {
  let out = lead;
  for (let i = 0; out.length < chars; i++) out += ` ${FILLER[i % FILLER.length]}`;
  return out;
}

export const DOC_ID = 'a'.repeat(64);
export const QUESTION = 'ZQ_QUESTION why does this assumption matter?';

export const S = {
  title: 'ZQ_TITLE', abstract: 'ZQ_ABSTRACT', head1: 'ZQ_HEAD_ONE', head2: 'ZQ_HEAD_TWO', figList: 'ZQ_FIGURE_LIST_CAPTION',
  focus: 'ZQ_FOCUS', p: (i: number) => `ZQ_PASSAGE_${i}`, caption: (k: number) => `ZQ_CAPTION_${k}`, inside: (k: number) => `ZQ_INSIDE_${k}`,
  mention: (k: number, j: number) => `ZQ_MENTION_${k}_${j}`,
} as const;

const passage = (text: string, pageIndex: number, start: number, rank: number, textSource = 'pdfium'): Passage => ({
  documentId: DOC_ID, pageIndex, start, end: start + text.length, textSource, text, rank, tokens: Math.ceil(text.length / 4),
});

export interface PackOptions {
  passages?: number;       // 0..5
  figures?: number;        // 0..4
  focus?: boolean;
  title?: string;
  imageType?: 'image/png' | 'image/jpeg';
  /** Extra passages of this size, to make a big pack. */
  extraPassageChars?: number;
}

/** A pack that obeys the starting budgets: map ~600 tokens, focus ~250, five passages ~500 each. */
export function makePack(o: PackOptions = {}): ContextPack {
  const nPass = o.passages ?? 5;
  const nFig = o.figures ?? 0;
  const mapAbstract = passage(prose(`${S.abstract} We study staggered adoption.`, 900), 0, 40, 0);
  const map: DocumentMap = {
    title: o.title ?? `${S.title} Event studies of wages`,
    abstract: mapAbstract,
    headings: [{ text: `${S.head1} Introduction`, pageIndex: 0 }, { text: `${S.head2} Empirical strategy`, pageIndex: 2 }],
    figures: Array.from({ length: nFig }, (_, k) => ({ label: `Figure ${k + 1}`, pageIndex: 4 + k, caption: `${S.figList}_${k + 1} event study estimates` })),
  };
  const focus = o.focus === false ? null : passage(prose(`${S.focus} We assume treated and control units would have followed parallel trends.`, 1000), 3, 1200, 0);
  const pages = [3, 2, 6, 4, 0];
  const passages = Array.from({ length: nPass }, (_, i) => passage(prose(`${S.p(i + 1)} A passage about identification.`, 2000), pages[i]!, 5000 + 1000 * i, i + 1));
  if (o.extraPassageChars) passages.push(passage(prose('ZQ_EXTRA', o.extraPassageChars), 9, 90_000, 9));
  const figures: FigurePack[] = Array.from({ length: nFig }, (_, k) => ({
    label: `Figure ${k + 1}`,
    pageIndex: 4 + k,
    image: { blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, k, 1, 2, 3])], { type: o.imageType ?? 'image/png' }), mediaType: o.imageType ?? 'image/png', width: 1000, height: 750, scale: 4.16, visualTokens: 972 },
    caption: passage(`Figure ${k + 1}: ${S.caption(k + 1)} Event study estimates of the effect on log wages.`, 4 + k, 300 + 100 * k, 0),
    insideText: `[below] Years relative to treatment ${S.inside(k + 1)}; [left, rotated] Effect on log wages; [inside] Treated, Control`,
    mentions: [1, 2, 3].map((j) => passage(prose(`${S.mention(k + 1, j)} As Figure ${k + 1} shows, pre-trends are flat.`, 500), 3 + j, 700 * j + 50 * k, 0)),
  }));
  // pack.blocks in the order the contract sends them: figure texts, then the focus, then the ranked passages.
  const cb = (p: Passage, title: string): CitableBlock => ({ title, pageIndex: p.pageIndex, start: p.start, end: p.end, textSource: p.textSource });
  const blocks: CitableBlock[] = [
    ...figures.flatMap((f) => [...(f.caption ? [cb(f.caption, `Figure caption p. ${f.pageIndex + 1}`)] : []), ...f.mentions.map((m) => cb(m, `Mention p. ${m.pageIndex + 1}`))]),
    ...(focus ? [cb(focus, `Marked passage p. ${focus.pageIndex + 1}`)] : []),
    ...passages.map((p) => cb(p, `Passage p. ${p.pageIndex + 1}`)),
  ];
  // estimate is zero on purpose: an estimator that just hands it back would price every pack at nothing.
  return { map, focus, passages, figures, blocks, estimate: { inputTokens: 0, usd: 0 } };
}

/** Every sentinel a pack should put into a request, once. */
export function sentinelsOf(pack: ContextPack): string[] {
  const out: string[] = [S.title, S.abstract, S.head1, S.head2];
  pack.map.figures.forEach((_, k) => out.push(`${S.figList}_${k + 1}`));
  if (pack.focus) out.push(S.focus);
  pack.passages.forEach((p) => { const m = /ZQ_(PASSAGE_\d|EXTRA)/.exec(p.text); if (m) out.push(`ZQ_${m[1]}`); });
  pack.figures.forEach((_, k) => out.push(S.caption(k + 1), S.inside(k + 1), S.mention(k + 1, 1), S.mention(k + 1, 2), S.mention(k + 1, 3)));
  return out;
}

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !(v instanceof Blob) && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
export const clone = <T>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------------------------------------------------------------
// Reading a built request. A request is plain JSON; none of this knows how the builder lays it out.

export const resolve = async <T>(v: T | Promise<T>): Promise<T> => v;

export interface BuiltRequest { params: Obj; blocks: CitableBlock[] }

/** All content blocks of all messages, in order, with where they sit. A string `content` counts as one text block. */
export function messageBlocks(params: Obj): { m: number; b: number; role: string; block: Obj }[] {
  const out: { m: number; b: number; role: string; block: Obj }[] = [];
  (params.messages as Obj[]).forEach((msg, m) => {
    const content: Obj[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
    content.forEach((block, b) => out.push({ m, b, role: msg.role, block }));
  });
  return out;
}

/** The document blocks in request order: the index here is the `document_index` a citation uses. */
export const documentsOf = (params: Obj): Obj[] => messageBlocks(params).filter((x) => x.block.type === 'document').map((x) => x.block);

/** The text blocks inside a custom-content document. */
export function docTexts(doc: Obj): string[] {
  const content = doc.source?.content;
  if (typeof content === 'string') return [content];
  return Array.isArray(content) ? content.map((c: Obj) => (typeof c === 'string' ? c : String(c.text ?? ''))) : [];
}

/** Where a sentinel sits among documents: its document index and its block index inside it. */
export function locate(params: Obj, needle: string): { doc: number; block: number }[] {
  const hits: { doc: number; block: number }[] = [];
  documentsOf(params).forEach((d, doc) => docTexts(d).forEach((t, block) => { if (t.includes(needle)) hits.push({ doc, block }); }));
  return hits;
}

export const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
export const textOf = (params: Obj): string => JSON.stringify(params);

/** Every place that carries a `cache_control`, as a path, with the marker itself. */
export function cacheMarks(params: Obj): { path: string; mark: Obj }[] {
  const out: { path: string; mark: Obj }[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'cache_control' && x) out.push({ path: path || '$', mark: x as Obj });
        else walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(params, '');
  return out;
}

/** Every key anywhere in a JSON value. */
export function allKeys(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); allKeys(x, acc); }
  return acc;
}

export const toolNames = (params: Obj): string[] => ((params.tools ?? []) as Obj[]).map((t) => String(t.name));
export const CLIENT_TOOLS = ['search_document', 'get_pages', 'get_figure'] as const;

/** Rough tokens, the contract's own formula. */
export const tokensOf = (s: string): number => Math.ceil(s.length / 4);

export function docTokens(params: Obj): number {
  return documentsOf(params).reduce((sum, d) => sum + docTexts(d).reduce((s, t) => s + tokensOf(t), 0), 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fake streams in the Messages wire format

export interface UsageSpec { input: number; cacheWrite: number; cacheRead: number; output: number }

export const docCite = (documentIndex: number, block: number, cited: string, title = 'Relevant passages'): Obj => ({
  type: 'content_block_location', cited_text: cited, document_index: documentIndex, document_title: title, start_block_index: block, end_block_index: block + 1,
});
export const searchCite = (searchResultIndex: number, block: number, cited: string): Obj => ({
  type: 'search_result_location', cited_text: cited, search_result_index: searchResultIndex, source: 'viewer', title: 'Pages', start_block_index: block, end_block_index: block + 1,
});
export const webCite = (url: string, title: string, cited: string): Obj => ({ type: 'web_search_result_location', cited_text: cited, url, title, encrypted_index: 'fixture-opaque' });

export class StreamBuilder {
  readonly events: Obj[] = [];
  private index = 0;
  private searches = 0;
  constructor(private readonly usage: UsageSpec = { input: 1200, cacheWrite: 0, cacheRead: 0, output: 321 }, model = 'fixture-model-default-0001') {
    this.events.push({
      type: 'message_start',
      message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite, cache_read_input_tokens: usage.cacheRead, output_tokens: 1 } },
    });
    this.events.push({ type: 'ping' });
  }

  private block(content_block: Obj, deltas: Obj[]): this {
    const index = this.index++;
    this.events.push({ type: 'content_block_start', index, content_block });
    for (const delta of deltas) this.events.push({ type: 'content_block_delta', index, delta });
    this.events.push({ type: 'content_block_stop', index });
    return this;
  }

  thinking(text: string): this {
    return this.block({ type: 'thinking', thinking: '', signature: '' }, [{ type: 'thinking_delta', thinking: text }, { type: 'signature_delta', signature: 'fixture-signature' }]);
  }
  /** One text block: the chunks stream as text deltas, then each citation arrives as a citations_delta (as the API sends them). */
  text(chunks: string | string[], citations: Obj[] = []): this {
    const list = typeof chunks === 'string' ? [chunks] : chunks;
    return this.block({ type: 'text', text: '' }, [...list.map((text) => ({ type: 'text_delta', text })), ...citations.map((citation) => ({ type: 'citations_delta', citation }))]);
  }
  /** A web search: the tool call (its input streams as JSON pieces) and then its result block. */
  webSearch(query: string, results: { url: string; title: string }[] | { error: string }, id = 'srvtoolu_fixture'): this {
    this.searches++;
    const json = JSON.stringify({ query });
    const mid = Math.floor(json.length / 2);
    this.block({ type: 'server_tool_use', id, name: 'web_search', input: {} }, [{ type: 'input_json_delta', partial_json: json.slice(0, mid) }, { type: 'input_json_delta', partial_json: json.slice(mid) }]);
    const content = Array.isArray(results)
      ? results.map((r) => ({ type: 'web_search_result', url: r.url, title: r.title, page_age: 'April 30, 2026', encrypted_content: 'fixture-opaque' }))
      : { type: 'web_search_tool_result_error', error_code: results.error };
    return this.block({ type: 'web_search_tool_result', tool_use_id: id, content }, []);
  }
  /** A text block that is started and streamed but never closed: where a stream is cut off. */
  openText(chunks: string[]): this {
    const index = this.index++;
    this.events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const text of chunks) this.events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
    return this;
  }
  clientTool(name: string, input: Obj, id = 'toolu_fixture'): this {
    return this.block({ type: 'tool_use', id, name, input: {} }, [{ type: 'input_json_delta', partial_json: JSON.stringify(input) }]);
  }
  raw(event: Obj): this { this.events.push(event); return this; }
  end(stop: string | null = 'end_turn'): this {
    this.events.push({
      type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: this.usage.output, ...(this.searches ? { server_tool_use: { web_search_requests: this.searches } } : {}) },
    });
    this.events.push({ type: 'message_stop' });
    return this;
  }
  error(type: string, message: string): this {
    this.events.push({ type: 'error', error: { type, message } });
    return this;
  }
}

/** What the SDK's `finalMessage()` would hold after these events: blocks rebuilt from the deltas, usage from start and delta. */
export function accumulate(events: Obj[]): Obj {
  const message: Obj = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model-default-0001', content: [], stop_reason: null, stop_sequence: null, usage: {} };
  const json = new Map<number, string>();
  for (const ev of events) {
    if (ev.type === 'message_start') Object.assign(message, { ...ev.message, content: [] });
    else if (ev.type === 'content_block_start') {
      const b = structuredClone(ev.content_block) as Obj;
      if (b.type === 'text') b.citations = null;
      message.content[ev.index] = b;
    } else if (ev.type === 'content_block_delta') {
      const b = message.content[ev.index] as Obj; const d = ev.delta as Obj;
      if (d.type === 'text_delta') b.text += d.text;
      else if (d.type === 'thinking_delta') b.thinking += d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'input_json_delta') json.set(ev.index, (json.get(ev.index) ?? '') + d.partial_json);
      else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
    } else if (ev.type === 'content_block_stop') {
      if (json.has(ev.index)) message.content[ev.index].input = JSON.parse(json.get(ev.index)!);
    } else if (ev.type === 'message_delta') {
      Object.assign(message, ev.delta);
      message.usage = { ...message.usage, ...ev.usage };
    }
  }
  return message;
}

/** The wire form: `event: <type>` and `data: <json>`, a blank line after each. */
export const toSse = (events: Obj[]): string => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** Reads a whole SSE body back into events, and checks that every `event:` name matches the data's own `type`. */
export function parseSse(text: string): { events: Obj[]; mismatches: string[] } {
  const events: Obj[] = []; const mismatches: string[] = [];
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    if (!chunk.trim()) continue;
    let name = ''; const data: string[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    const ev = JSON.parse(data.join('\n')) as Obj;
    if (name && name !== ev.type) mismatches.push(`${name} != ${String(ev.type)}`);
    events.push(ev);
  }
  return { events, mismatches };
}

// ---------------------------------------------------------------------------------------------------------------------
// Running a mapper

export type FinalKind = 'accumulated' | 'none' | 'partial';

export async function runMapper(create: CreateStreamMapper, blocks: CitableBlock[], events: Obj[], final: FinalKind = 'accumulated'): Promise<{ emitted: StreamEvent[]; out: ReplyMeta & { body: string } }> {
  const emitted: StreamEvent[] = [];
  const mapper = create(blocks, (e) => emitted.push(e));
  for (const ev of events) mapper.push(ev);
  const msg = accumulate(events);
  const arg = final === 'none' ? undefined : final === 'partial' ? { ...msg, stop_reason: null } : msg;
  const out = await resolve(mapper.finish(arg));
  return { emitted, out };
}

/** The cite and source links a body carries, as `{ text, kind, n }`. */
export const LINK_RE = /\[([^\]]+)\]\((cite|web):(-?\d+)\)/g;
export const linksOf = (body: string): { text: string; kind: string; n: number }[] => [...body.matchAll(LINK_RE)].map((m) => ({ text: m[1]!, kind: m[2]!, n: Number(m[3]) }));
/** The body without its chips and with runs of spaces folded, so it can be compared with the plain streamed text. */
export const withoutChips = (s: string): string => s.replace(/\[(?:p\. \d+|source)\]\((?:cite|web):-?\d+\)/g, '').replace(/\s+/g, ' ').trim();
export const textEvents = (emitted: StreamEvent[]): string => emitted.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

// ---------------------------------------------------------------------------------------------------------------------
// Key-like text

/** The shapes of an Anthropic key and of other long secrets. A fake one is built from parts so this file holds no key. */
export const FAKE_KEY = ['sk', 'ant', 'api03', 'SPECBLINDFAKEKEY0123456789abcdefghij'].join('-');
export const KEY_SHAPES: RegExp[] = [/sk-ant-[A-Za-z0-9_-]{6,}/, /\bsk-[A-Za-z0-9]{20,}/, /\bBearer\s+[A-Za-z0-9._-]{16,}/i];
export const looksLikeKey = (s: string): string | null => { for (const re of KEY_SHAPES) { const m = re.exec(s); if (m) return m[0]; } return null; };

/** A model id by shape, built from parts so this file holds none. Family words alone ("Haiku") are fine; ids are not. */
const FAMILY = '(?:opus|sonnet|haiku|fable|instant)';
export const MODEL_ID_SHAPES: RegExp[] = [
  new RegExp(`\\bclaude-(?:${FAMILY}|\\d)[\\w.-]*`, 'i'),
  new RegExp(`\\b${FAMILY}-\\d[\\w.-]*`, 'i'),
];
export const findModelId = (s: string): string | null => { for (const re of MODEL_ID_SHAPES) { const m = re.exec(s); if (m) return m[0]; } return null; };
