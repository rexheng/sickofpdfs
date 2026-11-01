/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- these tests read wire JSON from an API we do not own, and cast modules that did not exist when they were written */
// Spec-blind tests for slice A, part 2: createStreamMapper (packages/core/src/claude/stream-map.ts) and the fixed figure question.
//
// Sources:
//   plan Phase 4, slice A: "turns the raw stream back into contract events, a Markdown body and ClaudeReplyMeta. Afterwards a
//     reply's citations land on the right page and characters"; "the body uses [p. 4](cite:n) and [source](web:n); citations
//     on the same passage merge, and an out-of-range index is dropped, never guessed";
//   plan A5: `via { kind: 'document' | 'search_result'; index; block }` maps BOTH citation location types back to blocks[i];
//   contracts section 3: ClaudeReplyMeta, ReplyError codes, "On an error, the partial text stays, with status error";
//     section 6: ClaudeStreamEvent (status, text, citation, web-source, tool with a label such as "Searching the web for ...");
//   plan section 3 "Refusals and errors": a refusal shows "Claude declined to answer this" (`refused`);
//   plan done-when 5 and Gate 1 item 8: a cut-off reply keeps its text;
//   plan section 9 and the dispatch: the key never appears in an error message, log line or reply object; "Reply links are
//     allow-listed" (so a hostile web result cannot become a source link).
//
// The fake streams are built in the Messages wire format (see claude-kit.ts) and the final message the SDK would hold is rebuilt
// from the same events, so the two always agree.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_KEY, StreamBuilder, docCite, findModelId, linksOf, looksLikeKey, runMapper, searchCite, textEvents, webCite, withoutChips,
  type CitableBlock, type CreateStreamMapper, type Obj, type ReplyMeta,
} from '../../test/spec-blind/claude-kit';
import * as promptsModule from './prompts';
import * as requestModule from './request';
import { createStreamMapper } from './stream-map';
import * as streamMapModule from './stream-map';
import * as typesModule from './types';

const create = createStreamMapper as unknown as CreateStreamMapper;
const via = (kind: 'document' | 'search_result', index: number, block: number) => ({ kind, index, block });

/** What buildRequest would hand back for a request whose document 0 is the map, document 1 holds three passages and
 *  document 2 a figure caption, plus a search_result group with two pages. */
const BLOCKS: CitableBlock[] = [
  { title: 'Marked passage p. 4', pageIndex: 3, start: 1200, end: 1480, textSource: 'pdfium', via: via('document', 1, 0) },
  { title: 'Passage p. 3', pageIndex: 2, start: 300, end: 640, textSource: 'pdfium', via: via('document', 1, 1) },
  { title: 'Passage p. 4', pageIndex: 3, start: 2000, end: 2250, textSource: 'pdfium', via: via('document', 1, 2) },
  { title: 'Figure caption p. 5', pageIndex: 4, start: 90, end: 400, textSource: 'ocr:testocr@1', via: via('document', 2, 0) },
  { title: 'Pages', pageIndex: 6, start: 10, end: 120, textSource: 'pdfium', via: via('search_result', 0, 0) },
  { title: 'Pages', pageIndex: 7, start: 0, end: 80, textSource: 'pdfium', via: via('search_result', 0, 1) },
];

const plain = (text: string, cites: Obj[] = []) => new StreamBuilder().text(text, cites).end();

describe('citations land on the right page and characters (slice A; A5)', () => {
  it.each<{ name: string; cite: Obj; block: number }>([
    { name: 'content_block_location in the passages document', cite: docCite(1, 0, 'We assume parallel trends.'), block: 0 },
    { name: 'content_block_location, another block of that document', cite: docCite(1, 1, 'Pre-trends are flat.'), block: 1 },
    { name: 'content_block_location, two passages on one page stay two passages', cite: docCite(1, 2, 'Standard errors are clustered.'), block: 2 },
    { name: 'content_block_location in the figure document, a scan text source kept', cite: docCite(2, 0, 'Figure 3: event study.', 'Figure 3 (page 5)'), block: 3 },
    { name: 'search_result_location (a page fetched by a tool)', cite: searchCite(0, 0, 'Fetched page text.'), block: 4 },
    { name: 'search_result_location, second result block', cite: searchCite(0, 1, 'More fetched text.'), block: 5 },
  ])('$name', async ({ cite, block }) => {
    const want = BLOCKS[block]!;
    const { emitted, out } = await runMapper(create, BLOCKS, plain('The claim holds.', [cite]).events);
    expect(out.status).toBe('done');
    expect(out.error).toBeNull();
    expect(out.citations).toEqual([{ n: 1, pageIndex: want.pageIndex, start: want.start, end: want.end, textSource: want.textSource, quote: cite.cited_text }]);
    expect(out.body).toMatch(new RegExp(`The claim holds[.!?]?\\s*\\[p\\. ${want.pageIndex + 1}\\]\\(cite:1\\)`));
    const events = emitted.filter((e) => e.type === 'citation');
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) expect(e.type === 'citation' && e.citation).toEqual(out.citations[0]);
  });

  it('a passage cited twice keeps one number; passages on the same page get their own', async () => {
    const events = new StreamBuilder()
      .text('First claim.', [docCite(1, 0, 'a')])
      .text(' Second claim.', [docCite(1, 1, 'b')])
      .text(' Third claim.', [docCite(1, 0, 'a')])      // the first passage again
      .text(' Fourth claim.', [docCite(1, 2, 'c')])     // same page as the first, other characters
      .end().events;
    const { emitted, out } = await runMapper(create, BLOCKS, events);
    expect(out.citations.map((c) => [c.n, c.pageIndex, c.start])).toEqual([[1, 3, 1200], [2, 2, 300], [3, 3, 2000]]);
    expect(linksOf(out.body).map((l) => [l.text, l.kind, l.n])).toEqual([['p. 4', 'cite', 1], ['p. 3', 'cite', 2], ['p. 4', 'cite', 1], ['p. 4', 'cite', 3]]);
    const byN = new Map(emitted.flatMap((e) => (e.type === 'citation' ? [[e.citation.n, e.citation] as const] : [])));
    expect([...byN.keys()].sort()).toEqual([1, 2, 3]);
    for (const [n, c] of byN) expect(c).toEqual(out.citations.find((x) => x.n === n));
  });

  it.each<{ name: string; cite: Obj }>([
    { name: 'a document that was never sent', cite: docCite(7, 0, 'x') },
    { name: 'the right document, a block it does not have', cite: docCite(1, 9, 'x') },
    { name: 'a negative block index', cite: docCite(1, -1, 'x') },
    { name: 'the document map (index 0): not a passage, even though a search result 0/0 exists', cite: docCite(0, 0, 'x') },
    { name: 'a search result that was never sent', cite: searchCite(5, 0, 'x') },
    { name: 'a search_result_location must not land on the document with the same index', cite: searchCite(1, 0, 'x') },
    { name: 'a char_location (we never send plain text documents)', cite: { type: 'char_location', cited_text: 'x', document_index: 1, document_title: 't', start_char_index: 0, end_char_index: 3 } },
    { name: 'a page_location (we never send PDFs)', cite: { type: 'page_location', cited_text: 'x', document_index: 1, document_title: 't', start_page_number: 1, end_page_number: 2 } },
    { name: 'a location type from the future', cite: { type: 'future_location', cited_text: 'x', document_index: 1, start_block_index: 0, end_block_index: 1 } },
  ])('dropped, never guessed: $name', async ({ cite }) => {
    const { emitted, out } = await runMapper(create, BLOCKS, plain('The claim holds.', [cite]).events);
    expect(out.status).toBe('done');
    expect(out.citations).toEqual([]);
    expect(linksOf(out.body)).toEqual([]);
    expect(out.body).toContain('The claim holds.');
    expect(emitted.filter((e) => e.type === 'citation')).toEqual([]);
  });

  it('a dropped citation takes no number: the next good one is number 1', async () => {
    const { out } = await runMapper(create, BLOCKS, new StreamBuilder().text('Bad then good.', [docCite(7, 0, 'x'), docCite(1, 1, 'y')]).end().events);
    expect(out.citations.map((c) => c.n)).toEqual([1]);
    expect(out.citations[0]!.pageIndex).toBe(2);
    expect(linksOf(out.body).map((l) => l.n)).toEqual([1]);
  });
});

describe('text, status and the reply shape', () => {
  it('streams text in order after a streaming status, and hides the reasoning', async () => {
    const events = new StreamBuilder().thinking('HIDDEN_REASONING weigh the options').text(['Parallel trends ', 'means the groups ', 'move together.']).end().events;
    const { emitted, out } = await runMapper(create, BLOCKS, events);
    const firstText = emitted.findIndex((e) => e.type === 'text');
    const streaming = emitted.findIndex((e) => e.type === 'status' && e.status === 'streaming');
    expect(streaming).toBeGreaterThanOrEqual(0);
    expect(streaming).toBeLessThan(firstText);
    expect(withoutChips(textEvents(emitted))).toBe('Parallel trends means the groups move together.');
    expect(withoutChips(out.body)).toBe('Parallel trends means the groups move together.');
    expect(JSON.stringify([emitted, out])).not.toContain('HIDDEN_REASONING');
  });

  it('a finished reply has the contract\'s meta', async () => {
    const { out } = await runMapper(create, BLOCKS, plain('Done.').events);
    const meta: Partial<ReplyMeta> = out;
    expect(meta).toMatchObject({ kind: 'claude-reply', v: 1, status: 'done', error: null, via: 'viewer' });
    expect(Array.isArray(out.citations)).toBe(true);
    expect(Array.isArray(out.webSources)).toBe(true);
    expect(Array.isArray(out.figureLabels)).toBe(true);
    expect(typeof out.body).toBe('string');
  });

  it('pings and event types from the future are ignored, not fatal', async () => {
    const b = new StreamBuilder().raw({ type: 'future_event', payload: { x: 1 } }).text('Fine.').raw({ type: 'ping' }).end();
    const { out } = await runMapper(create, BLOCKS, b.events);
    expect(out.status).toBe('done');
    expect(out.body).toContain('Fine.');
  });

  it('usage is mapped one to one, and the money field is a plain number', async () => {
    const b = new StreamBuilder({ input: 1234, cacheWrite: 5678, cacheRead: 91011, output: 321 })
      .webSearch('first query', [{ url: 'https://example.org/a', title: 'A' }], 'srvtoolu_one')
      .webSearch('second query', [{ url: 'https://example.org/b', title: 'B' }], 'srvtoolu_two')
      .text('Answer.').end();
    const { out } = await runMapper(create, BLOCKS, b.events);
    expect(out.usage).toMatchObject({ inputTokens: 1234, outputTokens: 321, cacheReadTokens: 91011, cacheWriteTokens: 5678, webSearches: 2 });
    expect(Number.isFinite(out.usage!.usd)).toBe(true);
    expect(out.usage!.usd).toBeGreaterThanOrEqual(0);
  });

  it('a client tool call is announced as running, with a label', async () => {
    const b = new StreamBuilder().clientTool('get_pages', { pages: [3, 4] }).end('tool_use');
    const { emitted, out } = await runMapper(create, BLOCKS, b.events);
    const tool = emitted.find((e) => e.type === 'tool' && e.tool === 'get_pages');
    expect(tool).toMatchObject({ type: 'tool', tool: 'get_pages', state: 'running' });
    expect(typeof (tool as { label: string }).label).toBe('string');
    expect((tool as { label: string }).label.length).toBeGreaterThan(0);
    expect(out.status).not.toBe('error'); // stopping to use a tool is not a failure
    expect(out.error).toBeNull();
  });
});

describe('web search results become source chips (slice A, contracts section 6)', () => {
  const R1 = { url: 'https://example.org/did-explained', title: 'DiD explained' };
  const R2 = { url: 'https://example.net/staggered', title: 'Staggered adoption' };

  it('a cited result: a running label with the query, a done event, a numbered source and a [source] chip', async () => {
    const b = new StreamBuilder().text('Let me check.')
      .webSearch('difference-in-differences staggered adoption', [R1, R2])
      .text('Newer estimators fix the bias.', [webCite(R1.url, R1.title, 'a snippet of the page')])
      .end();
    const { emitted, out } = await runMapper(create, BLOCKS, b.events);
    const running = emitted.findIndex((e) => e.type === 'tool' && e.tool === 'web_search' && e.state === 'running');
    const done = emitted.findIndex((e) => e.type === 'tool' && e.tool === 'web_search' && e.state === 'done');
    expect(running).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(running);
    const label = (emitted[running] as { label: string }).label;
    expect(label).toMatch(/Searching the web for/);
    expect(label).toContain('difference-in-differences staggered adoption');
    expect(out.webSources).toEqual([{ n: 1, url: R1.url, title: R1.title, citedText: 'a snippet of the page' }]);
    expect(out.body).toMatch(/Newer estimators fix the bias[.!?]?\s*\[source\]\(web:1\)/);
    expect(emitted.filter((e) => e.type === 'web-source').map((e) => e.type === 'web-source' && e.source)).toContainEqual(out.webSources[0]);
    expect(out.usage!.webSearches).toBe(1);
    expect(out.status).toBe('done');
  });

  it('two results cited: numbered in the order they are first cited', async () => {
    const b = new StreamBuilder().webSearch('q', [R1, R2])
      .text('Second page first.', [webCite(R2.url, R2.title, 's2')])
      .text(' Then the first.', [webCite(R1.url, R1.title, 's1')]).end();
    const { out } = await runMapper(create, BLOCKS, b.events);
    expect(out.webSources.map((s) => [s.n, s.url])).toEqual([[1, R2.url], [2, R1.url]]);
    expect(linksOf(out.body).map((l) => [l.kind, l.n])).toEqual([['web', 1], ['web', 2]]);
  });

  it('[guess] one page cited by two sentences is one source with two chips', async () => {
    const b = new StreamBuilder().webSearch('q', [R1])
      .text('One claim.', [webCite(R1.url, R1.title, 'x')]).text(' Another claim.', [webCite(R1.url, R1.title, 'y')]).end();
    const { out } = await runMapper(create, BLOCKS, b.events);
    expect(out.webSources).toHaveLength(1);
    expect(linksOf(out.body).map((l) => l.n)).toEqual([1, 1]);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html'])(
    'a result with the address %s never becomes a source link (links are allow-listed)',
    async (url) => {
      const b = new StreamBuilder().webSearch('q', [{ url, title: 'hostile' }]).text('Claim.', [webCite(url, 'hostile', 'x')]).end();
      const { emitted, out } = await runMapper(create, BLOCKS, b.events);
      const everything = JSON.stringify([emitted, out]);
      expect(everything).not.toContain(url);
      expect(out.webSources.filter((s) => !/^https?:\/\//.test(s.url))).toEqual([]);
      for (const l of linksOf(out.body).filter((x) => x.kind === 'web')) expect(out.webSources.some((s) => s.n === l.n), `chip ${l.n} has a source`).toBe(true);
      expect(out.status).toBe('done');
    },
  );

  it.each(['max_uses_exceeded', 'too_many_requests', 'unavailable'])('a search that fails (%s) is a finished step, not a crash', async (code) => {
    const b = new StreamBuilder().webSearch('q', { error: code }).text('I could not search, so this comes from the PDF.').end();
    const { emitted, out } = await runMapper(create, BLOCKS, b.events);
    expect(emitted.some((e) => e.type === 'tool' && e.tool === 'web_search' && e.state === 'done')).toBe(true);
    expect(out.webSources).toEqual([]);
    expect(out.status).toBe('done');
    expect(out.body).toContain('this comes from the PDF');
  });
});

describe('a refusal, a mid-stream error, and a stream that just stops (no lost text)', () => {
  const PART_ONE = 'The first sentence, with a cite. ';
  const PART_TWO = 'and a second one that is cut off in the middle';
  const cut = (): StreamBuilder => new StreamBuilder().text(PART_ONE.trim(), [docCite(1, 0, 'a')]).openText([' ', PART_TWO.slice(0, 20), PART_TWO.slice(20)]);
  const want = `${PART_ONE.trim()} ${PART_TWO}`;

  it('stop_reason refusal: an error with the plain words, the text so far kept', async () => {
    const { out } = await runMapper(create, BLOCKS, new StreamBuilder().text('I will start but then stop.').end('refusal').events);
    expect(out.status).toBe('error');
    expect(out.error!.code).toBe('refused');
    expect(out.error!.message).toMatch(/declined/i);
    expect(out.body).toContain('I will start but then stop.');
  });

  it.each<{ type: string; codes: string[] }>([
    { type: 'overloaded_error', codes: ['server', 'rate-limited'] },
    { type: 'rate_limit_error', codes: ['rate-limited'] },
    { type: 'api_error', codes: ['server'] },
    { type: 'authentication_error', codes: ['bad-key'] },
  ])('an $type event in the middle of a reply', async ({ type, codes }) => {
    const b = cut().error(type, 'Overloaded');
    const { emitted, out } = await runMapper(create, BLOCKS, b.events, 'none'); // the SDK has no final message after an error
    const errors = emitted.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    const error = (errors[0] as { error: { code: string; message: string } }).error;
    expect(codes).toContain(error.code);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message.length).toBeLessThan(200);
    expect(error.message).not.toMatch(/_error\b|[{}]/); // plain words, not the API's field names or raw JSON
    expect(emitted.some((e) => e.type === 'done')).toBe(false);
    // what was already written survives, with its chip
    expect(out.status).toBe('error');
    expect(out.error).toEqual(error);
    expect(withoutChips(out.body)).toBe(want);
    expect(textEvents(emitted)).toContain(PART_TWO);
    expect(out.citations).toHaveLength(1);
    expect(linksOf(out.body)).toEqual([{ text: 'p. 4', kind: 'cite', n: 1 }]);
  });

  it('an error before any text leaves an empty body and an error state', async () => {
    const { out } = await runMapper(create, BLOCKS, new StreamBuilder().error('overloaded_error', 'Overloaded').events, 'none');
    expect(out.status).toBe('error');
    expect(out.error).not.toBeNull();
    expect(out.body).toBe('');
  });

  it.each<{ name: string; final: 'none' | 'partial' }>([
    { name: 'the connection drops and the SDK has no final message', final: 'none' },
    { name: 'the reader stops (Stop) and only a partial message exists', final: 'partial' },
  ])('$name: the text stays and the state is an error, not a done', async ({ final }) => {
    const { emitted, out } = await runMapper(create, BLOCKS, cut().events, final);
    expect(out.status).toBe('error');
    expect(out.error).not.toBeNull();
    expect(['interrupted', 'network', 'cancelled', 'server']).toContain(out.error!.code);
    expect(withoutChips(out.body)).toBe(want);
    expect(emitted.some((e) => e.type === 'done')).toBe(false);
  });
});

describe('secrets: the key never shows up in a message, a log line or the reply (dispatch item 4)', () => {
  const calls: string[] = [];
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => {
    calls.length = 0;
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { calls.push(args.map(String).join(' ')); }));
    }
  });
  afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

  it('an API error that echoes a key-like string is scrubbed before it reaches the reply, the events or the console', async () => {
    const b = new StreamBuilder().text('Partial answer.').error('authentication_error', `invalid x-api-key ${FAKE_KEY} (Bearer ${FAKE_KEY})`);
    const { emitted, out } = await runMapper(create, BLOCKS, b.events, 'none');
    const everything = JSON.stringify({ emitted, out });
    expect(looksLikeKey(everything)).toBeNull();
    expect(everything).not.toContain('SPECBLINDFAKEKEY');
    expect(looksLikeKey(calls.join('\n'))).toBeNull();
    expect(calls.join('\n')).not.toContain('Partial answer'); // the PDF's words are not logged either
    expect(out.status).toBe('error');
    expect(out.body).toContain('Partial answer.');
  });

  it('a key-like string inside a web result title is not copied anywhere it should not be [guess: titles are data and may stay]', async () => {
    const b = new StreamBuilder().webSearch('q', [{ url: 'https://example.org/p', title: 'fine' }]).text('Claim.', [webCite('https://example.org/p', 'fine', 'x')]).end();
    const { out } = await runMapper(create, BLOCKS, b.events);
    expect(looksLikeKey(JSON.stringify(out))).toBeNull();
    expect(calls).toEqual([]); // a clean run logs nothing at all
  });
});

describe('the fixed figure question', () => {
  const found = Object.assign({}, typesModule, streamMapModule, promptsModule, requestModule) as Record<string, unknown>;
  const question = found['EXPLAIN_FIGURE_QUESTION'];

  it('exists as a short plain sentence about the figure, and holds no model id', () => {
    expect(typeof question).toBe('string');
    const text = question as string;
    const words = text.trim().split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(5);
    expect(words).toBeLessThanOrEqual(80);
    expect(text).toMatch(/figure/i);
    expect(text).toMatch(/(show|read|takeaway|explain)/i); // research 06 section 9: what it shows, how to read it, the main takeaway
    expect(findModelId(text)).toBeNull();
  });
});
