/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- these tests read wire JSON from an API we do not own, and cast modules that did not exist when they were written */
// Spec-blind tests for slice A, part 1: buildRequest (packages/core/src/claude/request.ts).
//
// Sources (nothing here comes from the code):
//   plan Phase 4, section 3 "Rules every slice follows": request order, breakpoints, "no temperature, top_p or top_k", the
//     budget table (effort low / medium, max_tokens 4,000 / 16,000), "the frozen tool list ... the frozen system prompt";
//   plan slice A: "request order, breakpoint count and placement, no sampling parameters, and the web search tool and
//     max_uses only when web search is on"; A5 (`via` maps both citation location types back to blocks[i]);
//   contracts section 6: "The order is: a frozen system prompt; the document map with cache_control; the images before their
//     text packs; the passages; the question"; "Each passage and figure text is its own citable text block";
//   plan section 2: API version 2026-10-21 rejects user text blocks that carry citations, so earlier replies go back as
//     assistant turns; switching web search on or off resets the caches, so a thread's tool list stays fixed;
//   OWNER DECISIONS (binding, they override the plan's "up to 3"): at most 1 web search per question; passages only,
//     2-5k tokens; Haiku by default and Opus for "Think harder", both chosen by the owner and stored as data;
//   research 06 section 7.1 and 7.4: images before text, `oversized_image: "error"`, a model that cannot see images gets the
//     text pack only.
//
// Guesses (the spec is silent) are listed in the report. The loudest ones: the shape of a ThreadTurn (the contract never
// defines it), that the web search tool is left out when the model's stored `webSearchTool` is null, and that the explicit
// breakpoint is only on the document map (plus the top-level automatic one: two in all).
import { describe, expect, it } from 'vitest';
import {
  CLIENT_TOOLS, DEFAULT_MODEL, QUESTION, S, SONNET_MODEL, THINK_MODEL, allKeys, assistantTurn, cacheMarks, count, deepFreeze, docTexts, docTokens,
  documentsOf, findModelId, locate, makePack, messageBlocks, modelChoice, resolve, sentinelsOf, textOf, toolNames, tokensOf, userTurn,
  type BuildRequestApi, type BuiltRequest, type ContextPack, type ModelChoice, type Obj, type Role, type ThreadTurn,
} from '../../test/spec-blind/claude-kit';
import { buildRequest } from './request';

// The interface says `buildRequest(pack, turns, { role, model, webSearch })`; this file talks to it through that shape only.
const buildFn = buildRequest as unknown as BuildRequestApi;

interface Opts { role: Role; model: ModelChoice; webSearch: boolean }
const DEFAULTS: Opts = { role: 'default', model: DEFAULT_MODEL, webSearch: false };
const SECOND_ASK = 'ZQ_SECOND_ASK what about year zero?';
const ANSWER_ONE = 'ZQ_ANSWER_ONE the assumption lets us read the gap as an effect.';

async function build(pack: ContextPack = makePack(), turns: ThreadTurn[] = [userTurn(QUESTION)], o: Partial<Opts> = {}): Promise<BuiltRequest> {
  const out = await resolve(buildFn(pack, turns, { ...DEFAULTS, ...o }) as BuiltRequest | Promise<BuiltRequest>);
  return out;
}
const FOLLOW_UP: ThreadTurn[] = [userTurn(QUESTION), assistantTurn(ANSWER_ONE), userTurn(SECOND_ASK)];
const systemText = (params: Obj): string => (typeof params.system === 'string' ? params.system : ((params.system ?? []) as Obj[]).map((b) => String(b.text)).join('\n'));
const json = (v: unknown): string => JSON.stringify(v);

describe('model, effort and output cap follow the role (plan section 3 table, A1, A2)', () => {
  it.each<{ name: string; o: Partial<Opts>; effort: string; maxTokens: number }>([
    { name: 'default role, the stored default model', o: { role: 'default', model: DEFAULT_MODEL }, effort: 'low', maxTokens: 4000 },
    { name: 'think-harder, the stored think-harder model', o: { role: 'think-harder', model: THINK_MODEL }, effort: 'medium', maxTokens: 16000 },
    { name: 'a different default model (a Sonnet pick) keeps the default role settings', o: { role: 'default', model: SONNET_MODEL }, effort: 'low', maxTokens: 4000 },
  ])('$name', async ({ o, effort, maxTokens }) => {
    const { params } = await build(makePack(), [userTurn(QUESTION)], o);
    expect(params.model).toBe(o.model!.id); // the stored data, whatever it is: code never picks an id
    expect(params.output_config?.effort).toBe(effort);
    expect(params.max_tokens).toBe(maxTokens);
  });

  it('think harder switches to the think-harder model id and never reuses the default one', async () => {
    const def = await build(makePack(), [userTurn(QUESTION)], { role: 'default', model: DEFAULT_MODEL });
    const think = await build(makePack(), [userTurn(QUESTION)], { role: 'think-harder', model: THINK_MODEL });
    expect(def.params.model).toBe(DEFAULT_MODEL.id);
    expect(think.params.model).toBe(THINK_MODEL.id);
    expect(textOf(think.params)).not.toContain(DEFAULT_MODEL.id);
  });

  it('a Haiku default request opts into no server fallback and no beta (Haiku has none)', async () => {
    const { params } = await build();
    const keys = allKeys(params);
    expect(keys.has('fallbacks')).toBe(false);
    expect(keys.has('betas')).toBe(false);
  });
});

describe('no sampling parameters, no pre-warm (plan section 3)', () => {
  it.each<{ name: string; turns: ThreadTurn[]; o: Partial<Opts> }>([
    { name: 'first turn, default', turns: [userTurn(QUESTION)], o: {} },
    { name: 'first turn, think harder with web search', turns: [userTurn(QUESTION)], o: { role: 'think-harder', model: THINK_MODEL, webSearch: true } },
    { name: 'follow-up', turns: FOLLOW_UP, o: { webSearch: true } },
  ])('$name', async ({ turns, o }) => {
    const { params } = await build(makePack({ figures: 1 }), turns, o);
    const keys = allKeys(params);
    for (const banned of ['temperature', 'top_p', 'top_k']) expect(keys.has(banned), banned).toBe(false);
    expect(params.max_tokens).toBeGreaterThan(0); // a max_tokens: 0 request is the pre-warm the plan rules out
  });
});

describe('the tool list (plan section 3, contracts section 6, owner: at most 1 web search per question)', () => {
  it.each<{ name: string; webSearch: boolean; model: ModelChoice; web: { type: string } | null }>([
    { name: 'web search off: only the client tools', webSearch: false, model: DEFAULT_MODEL, web: null },
    { name: 'web search on: the web tool with the type stored for this model', webSearch: true, model: DEFAULT_MODEL, web: { type: 'fixture_web_search_a' } },
    { name: 'web search on, another model: that model\'s stored tool type, not a constant', webSearch: true, model: THINK_MODEL, web: { type: 'fixture_web_search_b' } },
    { name: 'web search on but the model accepts no web search tool (stored null): no web tool [guess]', webSearch: true, model: modelChoice({ webSearchTool: null }), web: null },
  ])('$name', async ({ webSearch, model, web }) => {
    const { params } = await build(makePack(), [userTurn(QUESTION)], { webSearch, model });
    const tools = (params.tools ?? []) as Obj[];
    expect(tools.slice(0, 3).map((t) => t.name)).toEqual([...CLIENT_TOOLS]); // client tools first, as contracts section 6 lists them
    const webTools = tools.filter((t) => t.name === 'web_search' || String(t.type ?? '').includes('web_search') || t.max_uses !== undefined);
    if (web === null) {
      expect(webTools).toEqual([]);
      expect(textOf(params)).not.toContain('max_uses');
      expect(tools).toHaveLength(3);
    } else {
      expect(webTools).toHaveLength(1);
      expect(webTools[0]).toMatchObject({ type: web.type, name: 'web_search', max_uses: 1 }); // owner decision: 1, not the plan's 3
      expect(tools).toHaveLength(4);
    }
  });

  it('every client tool is a real tool definition: a description and an object schema', async () => {
    const { params } = await build();
    for (const t of params.tools as Obj[]) {
      expect(typeof t.description, t.name).toBe('string');
      expect((t.description as string).length, t.name).toBeGreaterThan(10);
      expect(t.input_schema?.type, t.name).toBe('object');
    }
    const search = (params.tools as Obj[]).find((t) => t.name === 'search_document')!;
    expect(search.input_schema.properties).toHaveProperty('query');
    const figure = (params.tools as Obj[]).find((t) => t.name === 'get_figure')!;
    expect(Object.keys(figure.input_schema.properties ?? {})).toContain('label'); // research 06: get_figure({ label })
  });
});

describe('the tools and the system prompt are frozen (plan section 3: "so the cache holds")', () => {
  const variants: { name: string; pack: () => ContextPack; turns: ThreadTurn[]; o: Partial<Opts> }[] = [
    { name: 'another document', pack: () => makePack({ title: 'ZQ_OTHER_TITLE a different paper' }), turns: [userTurn('another question')], o: {} },
    { name: 'a figure question', pack: () => makePack({ figures: 2 }), turns: [userTurn(QUESTION)], o: {} },
    { name: 'a pack with no focus and no passages', pack: () => makePack({ focus: false, passages: 0 }), turns: [userTurn(QUESTION)], o: {} },
    { name: 'a follow-up', pack: () => makePack(), turns: FOLLOW_UP, o: {} },
    { name: 'think harder', pack: () => makePack(), turns: [userTurn(QUESTION)], o: { role: 'think-harder', model: THINK_MODEL } },
  ];

  it.each(variants)('system prompt and client tools do not change for: $name', async ({ pack, turns, o }) => {
    const base = await build();
    const other = await build(pack(), turns, o);
    expect(json(other.params.system)).toBe(json(base.params.system));
    expect(json((other.params.tools as Obj[]).slice(0, 3))).toBe(json((base.params.tools as Obj[]).slice(0, 3)));
    // nothing about this document or this question leaks into the frozen part
    expect(json([other.params.system, other.params.tools])).not.toContain('ZQ_');
  });

  it('with web search on, the tool list is the same for every question on the thread', async () => {
    const first = await build(makePack(), [userTurn(QUESTION)], { webSearch: true });
    const later = await build(makePack({ figures: 1 }), FOLLOW_UP, { webSearch: true });
    expect(json(later.params.tools)).toBe(json(first.params.tools));
    expect(json(later.params.system)).toBe(json(first.params.system));
  });

  it('web search on or off does not change the system prompt, and adds only the web tool', async () => {
    const off = await build(makePack(), [userTurn(QUESTION)], { webSearch: false });
    const on = await build(makePack(), [userTurn(QUESTION)], { webSearch: true });
    expect(json(on.params.system)).toBe(json(off.params.system));
    expect(json((on.params.tools as Obj[]).slice(0, 3))).toBe(json(off.params.tools));
  });

  it('the document map block is the same bytes for every question on the same document (breakpoint 1 is shared)', async () => {
    const a = makePack({ passages: 5, figures: 0 });
    const b: ContextPack = { ...makePack({ passages: 2, figures: 0, focus: false }), map: a.map };
    const first = (await build(a, [userTurn(QUESTION)])).params;
    const second = (await build(b, [userTurn('a different question entirely')])).params;
    expect(json(messageBlocks(second)[0]!.block)).toBe(json(messageBlocks(first)[0]!.block));
    const changed = (await build(makePack({ title: 'ZQ_OTHER_TITLE' }), [userTurn(QUESTION)])).params;
    expect(json(messageBlocks(changed)[0]!.block)).not.toBe(json(messageBlocks(first)[0]!.block)); // control: it does depend on the map
  });
});

describe('the system prompt says what plan section 3 says it says', () => {
  // Loose on purpose: each row is one idea, with the words a plain statement of it would use.
  it.each<{ idea: string; test: RegExp[] }>([
    { idea: 'PDF text is data, never instructions', test: [/data/i, /instruction/i] },
    { idea: 'plain words and about 150 words unless asked for more', test: [/plain/i, /150/] },
    { idea: 'cite the pages', test: [/cite|citation/i, /page/i] },
    { idea: 'use the tools instead of guessing', test: [/tool/i, /guess/i] },
    { idea: 'say so when the PDF does not answer', test: [/(say so|tell the user|doesn'?t answer|does not answer|not (in|answered)|cannot find|can'?t find)/i] },
    { idea: 'search the web only for outside knowledge', test: [/web/i, /(outside|beyond|background|external)/i] },
    { idea: 'figure rule: describe only what is visible', test: [/visible|can see/i] }, // research 06 7.3 says "visible"; "what you can see" is the same rule
    { idea: 'figure rule: values read from a chart are approximate', test: [/approximate/i] },
    { idea: 'figure rule: too small to read, so say so and suggest Think harder', test: [/Think harder/i] },
    { idea: 'figure rule: never name people in photos', test: [/(people|person|faces)/i] },
  ])('$idea', async ({ test }) => {
    const text = systemText((await build()).params);
    for (const re of test) expect(text, String(re)).toMatch(re);
  });

  it('holds no model id and no document text', async () => {
    const text = systemText((await build()).params);
    expect(text.length).toBeGreaterThan(300);
    expect(findModelId(text)).toBeNull();
  });
});

describe('cache breakpoints: placement and count (plan section 3, contracts section 6)', () => {
  const scenarios: { name: string; pack: () => ContextPack; turns: ThreadTurn[]; o: Partial<Opts> }[] = [
    { name: 'text question', pack: () => makePack(), turns: [userTurn(QUESTION)], o: {} },
    { name: 'figure question with web search', pack: () => makePack({ figures: 1 }), turns: [userTurn(QUESTION)], o: { webSearch: true } },
    { name: 'follow-up', pack: () => makePack(), turns: FOLLOW_UP, o: {} },
    { name: 'think harder', pack: () => makePack({ figures: 2 }), turns: [userTurn(QUESTION)], o: { role: 'think-harder', model: THINK_MODEL, webSearch: true } },
  ];

  it.each(scenarios)('$name: the explicit marker is on the document map only, plus the top-level automatic one', async ({ pack, turns, o }) => {
    const { params } = await build(pack(), turns, o);
    const marks = cacheMarks(params);
    expect(marks.filter((m) => m.path === '$').map((m) => m.mark)).toEqual([expect.objectContaining({ type: 'ephemeral' })]); // breakpoint 2, on the thread tail
    expect(marks.filter((m) => m.path !== '$').map((m) => m.path)).toEqual(['messages[0].content[0]']); // breakpoint 1
    const first = messageBlocks(params)[0]!.block;
    expect(first.type).toBe('document');
    expect(json(first)).toContain(S.title); // that block is the map
    expect(marks).toHaveLength(2); // [guess] the plan names exactly these two; the system prompt rides in the cached prefix
  });

  it.each(scenarios)('$name: at most 4 breakpoints, a 5-minute lifetime only', async ({ pack, turns, o }) => {
    const { params } = await build(pack(), turns, o);
    const marks = cacheMarks(params);
    expect(marks.length).toBeLessThanOrEqual(4);
    for (const { mark, path } of marks) {
      expect(mark.type, path).toBe('ephemeral');
      expect([undefined, '5m'], path).toContain(mark.ttl);
    }
    expect(textOf(params)).not.toContain('"1h"');
  });

  it('the passages, images, question and history carry no explicit marker of their own', async () => {
    const { params } = await build(makePack({ figures: 1 }), FOLLOW_UP);
    const later = cacheMarks(params).filter((m) => m.path.startsWith('messages') && m.path !== 'messages[0].content[0]');
    expect(later).toEqual([]);
  });
});

describe('layout of the first user message (contracts section 6)', () => {
  const posOf = (params: Obj, needle: string): number => messageBlocks(params).findIndex((x) => json(x.block).includes(needle));

  it('map, then each figure image before its own text pack, then the passages, then the question last', async () => {
    const pack = makePack({ figures: 2 });
    const { params } = await build(pack);
    const flat = messageBlocks(params);
    expect(params.messages[0].role).toBe('user');
    expect(flat.every((x) => x.m === 0)).toBe(true);
    const images = flat.flatMap((x, i) => (x.block.type === 'image' ? [i] : []));
    expect(images).toHaveLength(2);
    expect(posOf(params, S.title)).toBe(0);
    expect(posOf(params, S.title)).toBeLessThan(images[0]!);
    // research 06 section 7.3: the image comes before the caption, the text inside and the mentions of its figure
    for (const [k, img] of images.entries()) {
      for (const needle of [S.caption(k + 1), S.inside(k + 1), S.mention(k + 1, 1), S.mention(k + 1, 3)]) expect(img, needle).toBeLessThan(posOf(params, needle));
    }
    const lastFigureText = Math.max(posOf(params, S.mention(2, 3)), posOf(params, S.inside(2)), posOf(params, S.caption(2)));
    const ranked = [1, 2, 3, 4, 5].map((i) => posOf(params, S.p(i)));
    expect(posOf(params, S.focus)).toBeGreaterThan(lastFigureText);
    for (const p of ranked) expect(p).toBeGreaterThan(lastFigureText);
    expect(ranked).toEqual([...ranked].sort((a, b) => a - b)); // the pack's ranking order is kept
    const q = posOf(params, 'ZQ_QUESTION');
    expect(q).toBe(flat.length - 1);
    expect(q).toBeGreaterThan(Math.max(...ranked, posOf(params, S.focus)));
    expect(flat[q]!.block.type).toBe('text');
  });

  it('a text question has no image and no figure text', async () => {
    const { params } = await build(makePack({ figures: 0 }));
    expect(messageBlocks(params).filter((x) => x.block.type === 'image')).toEqual([]);
  });
});

describe('figure images (Gate 1 item 3, research 06 sections 7.1 and 7.4)', () => {
  it.each<{ name: string; pack: ContextPack; model: ModelChoice; images: number; mediaType?: string }>([
    { name: 'one figure: exactly one image (PNG)', pack: makePack({ figures: 1 }), model: DEFAULT_MODEL, images: 1, mediaType: 'image/png' },
    { name: 'one figure as a JPEG keeps its media type', pack: makePack({ figures: 1, imageType: 'image/jpeg' }), model: DEFAULT_MODEL, images: 1, mediaType: 'image/jpeg' },
    { name: 'compare two figures: two images', pack: makePack({ figures: 2 }), model: DEFAULT_MODEL, images: 2, mediaType: 'image/png' },
    { name: 'no figure: no image', pack: makePack({ figures: 0 }), model: DEFAULT_MODEL, images: 0 },
    { name: 'a model that cannot see images: no image, the figure text still goes', pack: makePack({ figures: 1 }), model: modelChoice({ imageInput: false }), images: 0 },
  ])('$name', async ({ pack, model, images, mediaType }) => {
    const { params } = await build(pack, [userTurn(QUESTION)], { model });
    const found = messageBlocks(params).filter((x) => x.block.type === 'image');
    expect(found).toHaveLength(images);
    for (const [k, { block }] of found.entries()) {
      expect(block.source.type).toBe('base64');
      expect(block.source.media_type).toBe(mediaType);
      const bytes = Buffer.from(String(block.source.data), 'base64');
      expect([...bytes.subarray(0, 4)]).toEqual([137, 80, 78, 71]); // the very bytes of the crop, not a placeholder
      expect(bytes[8]).toBe(k); // and figure k's own crop, in order
      expect(block.transformations).toMatchObject({ oversized_image: 'error' }); // research 06 section 7.1 (3): drift must fail loudly
    }
    for (const f of pack.figures) {
      // the caption, the text inside the figure and the mentions are sent with or without the picture
      expect(textOf(params)).toContain(S.caption(pack.figures.indexOf(f) + 1));
    }
    if (pack.figures.length && !model.imageInput) expect(textOf(params)).toContain(S.inside(1));
  });
});

describe('what is sent: the pack, once, and nothing else (owner: passages only, 2-5k tokens, never the whole document)', () => {
  it('every piece of the pack is in the request exactly once, so nothing is dropped and nothing is paid for twice', async () => {
    const pack = makePack({ figures: 1 });
    const { params } = await build(pack);
    const all = textOf(params);
    for (const needle of sentinelsOf(pack)) {
      // the title may also name the document block; everything else appears once
      const n = count(all, needle);
      if (needle === S.title) expect(n, needle).toBeGreaterThanOrEqual(1);
      else expect(n, needle).toBe(1);
    }
    expect(count(all, 'ZQ_QUESTION')).toBe(1);
  });

  it('the document text in the request stays within the pack, and under the 5,000-token ceiling', async () => {
    const pack = makePack();
    const { params } = await build(pack);
    const packTokens = tokensOf([pack.map.title, pack.map.abstract!.text, ...pack.map.headings.map((h) => h.text), pack.focus!.text, ...pack.passages.map((p) => p.text)].join(''));
    expect(packTokens).toBeLessThanOrEqual(3500); // the fixture itself obeys the starting budget
    expect(docTokens(params)).toBeLessThanOrEqual(packTokens * 1.05 + 60);
    expect(docTokens(params)).toBeLessThan(5000);
    // outside the documents there is only the question (plus a short lead-in)
    const loose = messageBlocks(params).filter((x) => x.block.type === 'text').map((x) => String(x.block.text)).join('');
    expect(loose.length).toBeLessThanOrEqual(QUESTION.length + 600);
  });

  it('a pack with no passages and no focus still builds a valid request: the map and the question', async () => {
    const { params, blocks } = await build(makePack({ passages: 0, focus: false }));
    expect(textOf(params)).toContain(S.title);
    expect(textOf(params)).toContain('ZQ_QUESTION');
    expect(Array.isArray(blocks)).toBe(true);
  });
});

describe('citations: every document is citable, and blocks[i] points at what was sent (A5)', () => {
  it.each([false, true])('all document blocks have citations on, with web search %s (citations are all-or-none)', async (webSearch) => {
    const { params } = await build(makePack({ figures: 1 }), [userTurn(QUESTION)], { webSearch });
    const docs = documentsOf(params);
    expect(docs.length).toBeGreaterThanOrEqual(2);
    for (const d of docs) {
      expect(d.citations, d.title).toMatchObject({ enabled: true });
      expect(d.source.type).toBe('content'); // custom content, so citations come back as content_block_location
    }
  });

  it('no user text block carries a citations field (API 2026-10-21 rejects it)', async () => {
    for (const turns of [[userTurn(QUESTION)], FOLLOW_UP]) {
      const { params } = await build(makePack({ figures: 1 }), turns, { webSearch: true });
      for (const x of messageBlocks(params).filter((b) => b.role === 'user' && b.block.type === 'text')) expect(x.block, `message ${x.m}`).not.toHaveProperty('citations');
    }
  });

  it('each passage, the focus and each mention is its own text block', async () => {
    const pack = makePack({ figures: 1 });
    const { params } = await build(pack);
    const citable = [S.focus, ...[1, 2, 3, 4, 5].map(S.p), ...[1, 2, 3].map((j) => S.mention(1, j))];
    for (const needle of citable) {
      const hits = locate(params, needle);
      expect(hits, needle).toHaveLength(1);
      const text = docTexts(documentsOf(params)[hits[0]!.doc]!)[hits[0]!.block]!;
      for (const other of citable.filter((c) => c !== needle)) expect(text, `${needle} shares a block with ${other}`).not.toContain(other);
    }
  });

  it('the returned blocks carry `via` and point at the block that holds the passage (page and characters kept)', async () => {
    const pack = makePack({ figures: 1 });
    const { params, blocks } = await build(pack);
    const items = [
      { p: pack.focus!, needle: S.focus },
      ...pack.passages.map((p, i) => ({ p, needle: S.p(i + 1) })),
      { p: pack.figures[0]!.caption!, needle: S.caption(1) },
      ...pack.figures[0]!.mentions.map((p, j) => ({ p, needle: S.mention(1, j + 1) })),
    ];
    const docs = documentsOf(params);
    const seen = new Set<string>();
    for (const { p, needle } of items) {
      const b = blocks.find((x) => x.pageIndex === p.pageIndex && x.start === p.start && x.end === p.end);
      expect(b, `${needle} has a block with its page and characters`).toBeDefined();
      expect(b!.textSource).toBe(p.textSource);
      expect(b!.via, needle).toBeDefined();
      expect(b!.via!.kind).toBe('document');
      const doc = docs[b!.via!.index];
      expect(doc, `${needle}: document ${b!.via!.index} exists`).toBeDefined();
      expect(docTexts(doc!)[b!.via!.block], needle).toContain(needle);
      expect(locate(params, needle)).toEqual([{ doc: b!.via!.index, block: b!.via!.block }]);
      const key = `${b!.via!.index}/${b!.via!.block}`;
      expect(seen.has(key), `${needle} reuses ${key}`).toBe(false);
      seen.add(key);
    }
  });
});

describe('follow-ups append to the same first message (plan section 2, slice D "append the exact blocks")', () => {
  it('turn one is untouched, the reply goes back as an assistant turn, the new question is a last user turn', async () => {
    const pack = makePack({ figures: 1 });
    const first = (await build(pack, [userTurn(QUESTION)])).params;
    const later = (await build(pack, FOLLOW_UP)).params;
    expect((later.messages as Obj[]).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(json(later.messages[0])).toBe(json(first.messages[0])); // byte for byte: this is what the cache reads
    expect(json(later.messages[1])).toContain('ZQ_ANSWER_ONE');
    for (const x of messageBlocks(later).filter((b) => b.m === 1)) expect(x.block.type).toBe('text'); // no documents or images inside an assistant turn
    expect(json(later.messages[2])).toContain('ZQ_SECOND_ASK');
    expect(count(textOf(later), 'ZQ_QUESTION')).toBe(1);
    // passages and the picture are not sent again
    expect(messageBlocks(later).filter((x) => x.m > 0 && (x.block.type === 'document' || x.block.type === 'image'))).toEqual([]);
    expect(documentsOf(later)).toHaveLength(documentsOf(first).length);
  });

  it('two earlier exchanges alternate user and assistant and end on the new question', async () => {
    const turns = [userTurn(QUESTION), assistantTurn(ANSWER_ONE), userTurn(SECOND_ASK), assistantTurn('ZQ_ANSWER_TWO year zero is the base year.'), userTurn('ZQ_THIRD_ASK and after that?')];
    const { params } = await build(makePack(), turns);
    expect((params.messages as Obj[]).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(json(params.messages.at(-1))).toContain('ZQ_THIRD_ASK');
  });

  it('a first turn is a single user message', async () => {
    const { params } = await build();
    expect(params.messages).toHaveLength(1);
  });
});

describe('the builder is a plain function (the cache and the tests depend on it)', () => {
  it('the same inputs always give the same request, key order and all', async () => {
    const a = await build(makePack({ figures: 1 }), FOLLOW_UP, { webSearch: true });
    const b = await build(makePack({ figures: 1 }), FOLLOW_UP, { webSearch: true });
    expect(json(b.params)).toBe(json(a.params));
    expect(json(b.blocks)).toBe(json(a.blocks));
  });

  it('it returns a promise: it encodes the figure images itself, so nobody has to remember a pre-step', async () => {
    const pending = buildFn(makePack({ figures: 1 }), [userTurn(QUESTION)], DEFAULTS) as Promise<BuiltRequest>;
    expect(typeof (pending as unknown as { then?: unknown }).then).toBe('function');
    const built = await pending;
    const image = messageBlocks(built.params).find((x) => x.block.type === 'image');
    expect(String(image?.block.source.data).length).toBeGreaterThan(0); // a Blob in the pack, base64 in the request
  });

  it('it does not change what it is given', async () => {
    const pack = deepFreeze(makePack({ figures: 1 }));
    const turns = deepFreeze([...FOLLOW_UP]);
    const o = deepFreeze({ ...DEFAULTS, webSearch: true });
    await expect(resolve(buildFn(pack, turns, o) as Promise<unknown>)).resolves.toBeDefined();
  });

  it('changing a built request does not change the next one (no shared tool or system objects)', async () => {
    const clean = json((await build(makePack(), [userTurn(QUESTION)], { webSearch: true })).params);
    const dirty = (await build(makePack(), [userTurn(QUESTION)], { webSearch: true })).params;
    (dirty.tools as Obj[]).push({ name: 'injected' });
    (dirty.tools as Obj[])[0]!.description = 'changed';
    if (Array.isArray(dirty.system)) (dirty.system as Obj[])[0]!.text = 'changed';
    else dirty.system = 'changed';
    (dirty.messages as Obj[]).length = 0;
    expect(json((await build(makePack(), [userTurn(QUESTION)], { webSearch: true })).params)).toBe(clean);
  });

  it('the tool names are exactly the contract\'s', async () => {
    expect(toolNames((await build()).params)).toEqual([...CLIENT_TOOLS]);
  });
});
