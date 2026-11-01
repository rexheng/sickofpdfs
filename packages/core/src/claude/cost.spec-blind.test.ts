// Spec-blind tests for slice H, part 1: pricing and the decision to ask (packages/core/src/claude/{pricing,cost}.ts).
//
// Sources:
//   plan Phase 4, slice H: `priceFor(model)` "looks up `line` plus the version in `displayName` in a price table from research
//     06 section 6. An unknown version uses the highest price known for that line; a model with no line asks before sending";
//     `usdFromUsage(usage, price)`: "cache writes at 1.25x, cache reads at each model's rate, $0.01 per search, and Haiku's
//     higher rate for prompts over 100,000 tokens"; `estimate(pack, role, model)`; and
//     `decide({ estimateUsd, spentUsd, capUsd, confirmOverUsd, saved, scope }) -> 'send' | { ask: 'unsaved' | 'over-threshold'
//     | 'whole-document'; usd } | { block: 'over-cap' }`;
//   research 06 section 6 (prices per million tokens: in / 5-minute write / cache read / out) and section 8 (worked examples:
//     "One figure ... Haiku $0.0010, Opus $0.049; follow-up Haiku $0.0005, Opus $0.027");
//   plan done-when 3: any request over $0.25 asks first; the monthly cap blocks; Think harder costs about 3 to 5 cents;
//   contracts section 6 "Before sending": a PDF not in the library asks before anything is sent; over the cap the reply fails
//     with `over-cap`; settings `claude.monthlyCapUsd` defaults to null (no cap) and `claude.confirmOverUsd` to 0.25;
//   spec: "An estimate appears before any request over $0.25, and Settings has a monthly cap".
//
// Where the plan is silent the guesses are in the report: the shape of `usage` (both spellings are supplied below), whether
// the cap compares the spend plus the estimate or the spend alone, and what happens to a line that is not in the table.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL, SONNET_MODEL, THINK_MODEL, deepFreeze, makePack, modelChoice,
  type ContextPack, type ModelChoice, type Role,
} from '../../test/spec-blind/claude-kit';
import * as costModule from './cost';
import * as pricingModule from './pricing';

const api = Object.assign({}, pricingModule, costModule) as Record<string, unknown>;
const priceFor = api['priceFor'] as (m: ModelChoice) => unknown;
const usdFromUsage = api['usdFromUsage'] as (usage: unknown, price: unknown) => number;
const estimate = api['estimate'] as (pack: ContextPack, role: Role, model: ModelChoice) => unknown;
const decide = api['decide'] as (a: DecideArgs) => Decision;

interface DecideArgs { estimateUsd: number; priceKnown: boolean; spentUsd: number; capUsd: number | null; confirmOverUsd: number; saved: boolean; scope: 'passages' | 'whole-document' }
type Decision = 'send' | { ask: string; usd: number } | { block: string };

interface U { input?: number; output?: number; read?: number; write?: number; searches?: number }
/** A usage record. The contract's ClaudeReplyMeta.usage spells the fields in camelCase and the API in snake_case; the interface
 *  line does not say which one `usdFromUsage` takes, so both are present and the extra ones are ignored. */
const usage = ({ input = 0, output = 0, read = 0, write = 0, searches = 0 }: U): Record<string, unknown> => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write, webSearches: searches,
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write, server_tool_use: { web_search_requests: searches },
});
const usd = (model: ModelChoice, u: U): number => usdFromUsage(usage(u), priceFor(model));
const PER_M = (tokens: number, ratePerMTok: number): number => (tokens * ratePerMTok) / 1_000_000;

// Research 06 section 6, per million tokens.
const TABLE = [
  { name: 'Haiku 5.5', model: DEFAULT_MODEL, input: 0.1, write: 0.125, read: 0.01, output: 0.5 },
  { name: 'Sonnet 5.5', model: SONNET_MODEL, input: 2, write: 2.5, read: 0.1, output: 10 },
  { name: 'Opus 5.5', model: THINK_MODEL, input: 4, write: 5, read: 0.2, output: 20 },
];

describe('what a reply costs, token class by token class (slice H, research 06 section 6)', () => {
  describe.each(TABLE)('$name', ({ model, input, write, read, output }) => {
    it.each<{ what: string; u: U; want: number }>([
      { what: '100,000 fresh input tokens', u: { input: 100_000 }, want: PER_M(100_000, input) },
      { what: '100,000 cache-write tokens, 1.25x the input rate', u: { write: 100_000 }, want: PER_M(100_000, write) },
      { what: '100,000 cache-read tokens, at this model\'s own read rate', u: { read: 100_000 }, want: PER_M(100_000, read) },
      { what: '1,000,000 output tokens', u: { output: 1_000_000 }, want: PER_M(1_000_000, output) },
      { what: 'one web search, one cent whatever the model', u: { searches: 1 }, want: 0.01 },
      { what: 'three web searches', u: { searches: 3 }, want: 0.03 },
      { what: 'nothing at all', u: {}, want: 0 },
      { what: 'every class at once', u: { input: 1000, write: 2000, read: 3000, output: 4000, searches: 2 }, want: PER_M(1000, input) + PER_M(2000, write) + PER_M(3000, read) + PER_M(4000, output) + 0.02 },
    ])('$what', ({ u, want }) => {
      expect(usd(model, u)).toBeCloseTo(want, 9);
    });

    it('a cache write is exactly 1.25 times the same tokens as fresh input', () => {
      expect(usd(model, { write: 40_000 })).toBeCloseTo(1.25 * usd(model, { input: 40_000 }), 9);
    });
  });

  it.each([
    { what: 'Haiku, one figure, first turn written to the cache (research 06 section 8: $0.0010)', model: DEFAULT_MODEL, u: { write: 5200, output: 750 }, want: 0.001025 },
    { what: 'Opus, one figure, first turn (research 06 section 8: $0.049)', model: THINK_MODEL, u: { write: 5200, output: 1150 }, want: 0.049 },
    { what: 'Haiku follow-up, the prefix is read from the cache ($0.0005)', model: DEFAULT_MODEL, u: { read: 5200, input: 600, output: 750 }, want: 0.000487 },
    { what: 'Opus follow-up, prefix read from the cache ($0.027)', model: THINK_MODEL, u: { read: 5200, input: 600, output: 1150 }, want: 0.02644 },
    { what: 'a Haiku question that searched the web: the search costs more than the answer', model: DEFAULT_MODEL, u: { write: 5200, output: 750, searches: 1 }, want: 0.011025 },
  ])('worked example: $what', ({ model, u, want }) => {
    expect(usd(model, u)).toBeCloseTo(want, 6);
  });

  it('a cache read is far cheaper than the same tokens written or sent fresh (why the cache pays)', () => {
    for (const { model } of TABLE) {
      expect(usd(model, { read: 50_000 })).toBeLessThan(usd(model, { input: 50_000 }) / 5);
    }
  });
});

describe('Haiku\'s higher rate for prompts over 100,000 tokens (slice H)', () => {
  const base = (input: number, read = 0): number => PER_M(input, 0.1) + PER_M(read, 0.01);

  it('exactly 100,000 is still the base rate, one more token is not', () => {
    expect(usd(DEFAULT_MODEL, { input: 100_000 })).toBeCloseTo(base(100_000), 9);
    const over = usd(DEFAULT_MODEL, { input: 100_001 });
    expect(over).toBeGreaterThan(base(100_001) + 1e-9);
    expect(over).toBeGreaterThan(usd(DEFAULT_MODEL, { input: 100_000 }));
  });

  it('a long prompt costs more per token than a short one, and keeps getting dearer with length', () => {
    const perToken = (n: number) => usd(DEFAULT_MODEL, { input: n }) / n;
    expect(perToken(200_000)).toBeGreaterThan(perToken(100_000));
    expect(usd(DEFAULT_MODEL, { input: 300_000 })).toBeGreaterThan(usd(DEFAULT_MODEL, { input: 200_000 }));
  });

  it('[guess] the prompt is everything sent: fresh input plus cache reads plus cache writes', () => {
    expect(usd(DEFAULT_MODEL, { input: 50_000, read: 50_000 })).toBeCloseTo(base(50_000, 50_000), 9); // 100,000 in all
    expect(usd(DEFAULT_MODEL, { input: 60_000, read: 50_000 })).toBeGreaterThan(base(60_000, 50_000) + 1e-9); // 110,000 in all
    expect(usd(DEFAULT_MODEL, { input: 10_000, write: 95_000 })).toBeGreaterThan(PER_M(10_000, 0.1) + PER_M(95_000, 0.125) + 1e-9);
  });

  it('[guess] only Haiku has the step: Sonnet and Opus stay linear past 100,000', () => {
    expect(usd(SONNET_MODEL, { input: 150_000 })).toBeCloseTo(PER_M(150_000, 2), 9);
    expect(usd(THINK_MODEL, { input: 150_000 })).toBeCloseTo(PER_M(150_000, 4), 9);
  });
});

describe('priceFor: the line and the version, never the id (slice H; research: "do not infer a line from the id")', () => {
  const SAMPLE: U = { input: 50_000, write: 10_000, read: 30_000, output: 2000, searches: 1 };

  it.each([
    { name: 'an unknown newer Haiku version', model: modelChoice({ line: 'haiku', displayName: 'Claude Haiku 9.1' }), floor: DEFAULT_MODEL },
    { name: 'an unknown newer Sonnet version', model: modelChoice({ line: 'sonnet', displayName: 'Claude Sonnet 5.6' }), floor: SONNET_MODEL },
    { name: 'an unknown newer Opus version', model: modelChoice({ line: 'opus', displayName: 'Claude Opus 6' }), floor: THINK_MODEL },
    { name: 'a display name with no version at all', model: modelChoice({ line: 'opus', displayName: 'Claude Opus' }), floor: THINK_MODEL },
  ])('$name is priced at the highest price known for the line, never below the known one', ({ model, floor }) => {
    const price = priceFor(model);
    expect(price).toBeTruthy();
    const got = usdFromUsage(usage(SAMPLE), price);
    expect(Number.isFinite(got)).toBe(true);
    expect(got).toBeGreaterThanOrEqual(usd(floor, SAMPLE) - 1e-12);
  });

  it('the id is data and says nothing: an id that names another family does not change the price', () => {
    const lookalike = modelChoice({ id: 'lookalike-with-haiku-in-its-name', line: 'opus', displayName: 'Claude Opus 5.5' });
    expect(usd(lookalike, SAMPLE)).toBeCloseTo(usd(THINK_MODEL, SAMPLE), 12);
  });

  it('the same model always has the same price', () => {
    expect(usd(DEFAULT_MODEL, SAMPLE)).toBe(usd(DEFAULT_MODEL, SAMPLE));
    expect(usd(DEFAULT_MODEL, SAMPLE)).toBeLessThan(usd(SONNET_MODEL, SAMPLE));
    expect(usd(SONNET_MODEL, SAMPLE)).toBeLessThan(usd(THINK_MODEL, SAMPLE));
  });

  /** "Has no price": nothing, a throw, an object that says so, or a price whose `basis` says the line was unknown (the highest
   *  known price is then only a safe stand-in: triage G7). Anything else is a price the code made up. */
  const hasNoPrice = (model: ModelChoice): boolean => {
    let p: unknown;
    try { p = priceFor(model); } catch { return true; }
    if (p === null || p === undefined) return true;
    if (typeof p === 'object') {
      if ((p as Record<string, unknown>)['basis'] === 'unknown-line') return true;
      const flags = ['unknown', 'unpriced', 'noPrice', 'ask', 'askFirst', 'askBeforeSending', 'missing'];
      return flags.some((f) => (p as Record<string, unknown>)[f] === true);
    }
    return false;
  };

  it.each([
    { name: 'no line (null)', model: modelChoice({ line: null, displayName: 'Some Model 1.0' }) },
    { name: 'no line, though the display name says Opus and the id says Opus', model: modelChoice({ id: 'lookalike-with-opus-in-its-name', line: null, displayName: 'Claude Opus 5.5' }) },
  ])('$name: no price, so the caller asks before sending', ({ model }) => {
    expect(hasNoPrice(model)).toBe(true);
  });

  it('[spec gap] a line the table has never heard of is either unpriced or priced no lower than the dearest known model', () => {
    const model = modelChoice({ line: 'fable', displayName: 'Claude Fable 5.1' });
    if (hasNoPrice(model)) return;
    expect(usd(model, SAMPLE)).toBeGreaterThanOrEqual(usd(THINK_MODEL, SAMPLE) - 1e-12);
  });
});

describe('estimate(pack, role, model) (slice H; done-when 3, risks table)', () => {
  const usdOf = (e: unknown): number => (typeof e === 'number' ? e : (e as { usd: number }).usd);
  const est = (pack: ContextPack, role: Role, model: ModelChoice): number => usdOf(estimate(pack, role, model));
  const typical = makePack();
  const typicalFigure = makePack({ figures: 1 });
  const tiny = makePack({ passages: 1, focus: false });
  const wholeDocument = makePack({ passages: 5, extraPassageChars: 1_200_000 }); // about 300,000 tokens

  it('is a positive number from the pack itself (the pack\'s own estimate field starts at zero)', () => {
    for (const model of [DEFAULT_MODEL, SONNET_MODEL, THINK_MODEL]) {
      const v = est(typical, 'default', model);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    const e = estimate(typical, 'default', DEFAULT_MODEL);
    if (typeof e === 'object' && e !== null && 'inputTokens' in e) expect((e as { inputTokens: number }).inputTokens).toBeGreaterThan(3000);
  });

  it('a dearer model costs more for the same question: Haiku < Sonnet < Opus', () => {
    const [h, s, o] = [DEFAULT_MODEL, SONNET_MODEL, THINK_MODEL].map((m) => est(typical, 'default', m)) as [number, number, number];
    expect(h).toBeLessThan(s);
    expect(s).toBeLessThan(o);
  });

  it.each([{ name: 'Haiku', model: DEFAULT_MODEL, imageCost: PER_M(1000, 0.1) }, { name: 'Opus', model: THINK_MODEL, imageCost: PER_M(1000, 4) }])(
    'a bigger pack costs more, and a figure image is not free ($name)',
    ({ model, imageCost }) => {
      const [a, b, c] = [tiny, typical, typicalFigure].map((p) => est(p, 'default', model)) as [number, number, number];
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
      expect(c - b).toBeGreaterThanOrEqual(imageCost); // at least 1,000 of the picture's 972+ tokens, billed as input
    },
  );

  it('think harder never estimates below the default role on the same model', () => {
    for (const model of [DEFAULT_MODEL, THINK_MODEL]) expect(est(typical, 'think-harder', model)).toBeGreaterThanOrEqual(est(typical, 'default', model));
  });

  it('a typical question stays far below the $0.25 prompt: about a cent on Haiku, a few cents on Opus', () => {
    expect(est(typical, 'default', DEFAULT_MODEL)).toBeLessThan(0.01);
    expect(est(typicalFigure, 'default', DEFAULT_MODEL)).toBeLessThan(0.01);
    for (const pack of [typical, typicalFigure]) {
      const v = est(pack, 'think-harder', THINK_MODEL);
      expect(v).toBeGreaterThan(0.005); // not "free": the owner expects 3 to 5 cents
      expect(v).toBeLessThan(0.25); // and Think harder must not ask for confirmation every time
    }
  });

  it('the whole 600-page document on a dearer model is over the $0.25 line', () => {
    expect(est(wholeDocument, 'default', SONNET_MODEL)).toBeGreaterThan(0.25);
    expect(est(wholeDocument, 'default', THINK_MODEL)).toBeGreaterThan(0.25);
    expect(est(wholeDocument, 'default', DEFAULT_MODEL)).toBeGreaterThan(est(typical, 'default', DEFAULT_MODEL) * 5); // 50 times the text
  });

  it('says whether the price was known: true for a priced line, false for a model with no line', () => {
    const known = estimate(typical, 'default', DEFAULT_MODEL) as { priceKnown?: boolean };
    const none = estimate(typical, 'default', modelChoice({ line: null, displayName: 'Some Model 1.0' })) as { priceKnown?: boolean };
    expect(known.priceKnown).toBe(true);
    expect(none.priceKnown).toBe(false); // the caller passes this to decide(), which then asks
  });

  it('a model with no price is never a small, confident number', () => {
    const lineless = modelChoice({ line: null, displayName: 'Some Model 1.0' });
    let v: number | undefined;
    try { v = est(typical, 'default', lineless); } catch { return; } // a throw means "ask first" too
    expect(!Number.isFinite(v) || v >= est(typical, 'default', THINK_MODEL)).toBe(true);
  });

  it('is a plain function: the same pack gives the same number and the pack is left alone', () => {
    const frozen = deepFreeze(makePack({ figures: 1 }));
    expect(est(frozen, 'default', DEFAULT_MODEL)).toBe(est(frozen, 'default', DEFAULT_MODEL));
  });
});

describe('decide: when to send, ask, or block (slice H; contracts section 6 "Before sending", spec privacy table)', () => {
  const base: DecideArgs = { estimateUsd: 0.01, priceKnown: true, spentUsd: 0, capUsd: null, confirmOverUsd: 0.25, saved: true, scope: 'passages' };
  type Want = { kind: 'send' } | { kind: 'ask'; reasons?: string[] } | { kind: 'block' } | { kind: 'not-send' };
  const kindOf = (d: Decision): 'send' | 'ask' | 'block' | 'other' => (d === 'send' ? 'send' : typeof d === 'object' && d !== null && 'ask' in d ? 'ask' : typeof d === 'object' && d !== null && 'block' in d ? 'block' : 'other');

  const rows: { name: string; over: Partial<DecideArgs>; want: Want }[] = [
    // the plain path
    { name: 'a small question on a saved PDF with no cap is sent', over: {}, want: { kind: 'send' } },
    { name: 'exactly the threshold is not over it', over: { estimateUsd: 0.25 }, want: { kind: 'send' } },
    { name: 'a hair over the threshold asks', over: { estimateUsd: 0.2500001 }, want: { kind: 'ask', reasons: ['over-threshold'] } },
    { name: '30 cents asks', over: { estimateUsd: 0.3 }, want: { kind: 'ask', reasons: ['over-threshold'] } },
    { name: 'the owner\'s own threshold counts (a dollar: 50 cents is fine)', over: { confirmOverUsd: 1, estimateUsd: 0.5 }, want: { kind: 'send' } },
    { name: 'the owner\'s own threshold counts (a dollar: $1.50 asks)', over: { confirmOverUsd: 1, estimateUsd: 1.5 }, want: { kind: 'ask', reasons: ['over-threshold'] } },
    // privacy
    { name: 'a PDF that is not in the library asks first, however cheap', over: { saved: false }, want: { kind: 'ask', reasons: ['unsaved'] } },
    { name: 'an unsaved PDF that is also dear still asks (one prompt or the other, never a send)', over: { saved: false, estimateUsd: 0.4 }, want: { kind: 'ask' } },
    // the whole document
    { name: 'asking about the whole document shows its estimate first, however cheap', over: { scope: 'whole-document', estimateUsd: 0.02 }, want: { kind: 'ask', reasons: ['whole-document'] } },
    { name: 'the whole document, dear: still an ask', over: { scope: 'whole-document', estimateUsd: 0.6 }, want: { kind: 'ask' } },
    { name: 'the whole document of an unsaved PDF: an ask', over: { scope: 'whole-document', saved: false }, want: { kind: 'ask' } },
    // the monthly cap
    { name: 'no cap (null) never blocks, however much has been spent', over: { capUsd: null, spentUsd: 1_000_000 }, want: { kind: 'send' } },
    { name: 'under the cap is sent', over: { capUsd: 1, spentUsd: 0.5, estimateUsd: 0.01 }, want: { kind: 'send' } },
    { name: 'the cap reached blocks', over: { capUsd: 1, spentUsd: 1 }, want: { kind: 'block' } },
    { name: 'past the cap blocks', over: { capUsd: 1, spentUsd: 1.2 }, want: { kind: 'block' } },
    { name: 'a request that fits under the cap is sent', over: { capUsd: 1, spentUsd: 0.99, estimateUsd: 0.005 }, want: { kind: 'send' } },
    { name: '[guess] a request that would carry the month over the cap is blocked, not sent', over: { capUsd: 1, spentUsd: 0.99, estimateUsd: 0.02 }, want: { kind: 'block' } },
    { name: '[guess] a request that lands exactly on the cap is not over it', over: { capUsd: 1, spentUsd: 0.98, estimateUsd: 0.02 }, want: { kind: 'send' } },
    { name: 'the cap beats every question: blocked even on an unsaved PDF', over: { capUsd: 1, spentUsd: 1, saved: false }, want: { kind: 'block' } },
    { name: 'the cap beats the dear-request prompt', over: { capUsd: 1, spentUsd: 1, estimateUsd: 5 }, want: { kind: 'block' } },
    { name: 'the cap beats the whole-document prompt', over: { capUsd: 1, spentUsd: 1, scope: 'whole-document' }, want: { kind: 'block' } },
    { name: 'a dear request under a roomy cap still asks', over: { capUsd: 5, spentUsd: 0, estimateUsd: 1 }, want: { kind: 'ask', reasons: ['over-threshold'] } },
    // a model with no price asks (ruling after triage G7: `decide` requires `priceKnown`)
    { name: 'a model with no known price asks first, however small the guess', over: { priceKnown: false, estimateUsd: 0.01 }, want: { kind: 'ask' } },
    { name: 'a model with no known price asks first on a saved PDF with no cap', over: { priceKnown: false, estimateUsd: 0.13, saved: true, capUsd: null }, want: { kind: 'ask' } },
    { name: 'a model with no known price and an unsaved PDF is still an ask, never a send', over: { priceKnown: false, saved: false }, want: { kind: 'ask' } },
    // never send on a number that is not a number
    { name: 'an estimate that is not a number is never sent', over: { estimateUsd: Number.NaN }, want: { kind: 'not-send' } },
    { name: 'an estimate of infinity (an unpriced model) is never sent', over: { estimateUsd: Number.POSITIVE_INFINITY }, want: { kind: 'not-send' } },
    { name: 'infinity under a cap is never sent', over: { estimateUsd: Number.POSITIVE_INFINITY, capUsd: 3, spentUsd: 0.1 }, want: { kind: 'not-send' } },
  ];

  it.each(rows)('$name', ({ over, want }) => {
    const args = { ...base, ...over };
    const d = decide(args);
    if (want.kind === 'not-send') return void expect(kindOf(d)).not.toBe('send');
    expect(kindOf(d), JSON.stringify(d)).toBe(want.kind);
    if (want.kind === 'ask') {
      if (want.reasons) expect(want.reasons).toContain((d as { ask: string }).ask);
      // an unpriced model may carry a reason of its own: the ruling says it asks, not why
      if (args.priceKnown) expect((d as { ask: string }).ask).toMatch(/^(unsaved|over-threshold|whole-document)$/);
      else expect(typeof (d as { ask: string }).ask).toBe('string');
      if (Number.isFinite(args.estimateUsd)) expect((d as { usd: number }).usd).toBeCloseTo(args.estimateUsd, 9); // the dialog shows this number
    }
    if (want.kind === 'block') expect(d).toMatchObject({ block: 'over-cap' });
  });

  it('is a plain function: it leaves its argument alone and answers the same way twice', () => {
    const args = deepFreeze({ ...base, saved: false, estimateUsd: 0.4, capUsd: 3, spentUsd: 1 });
    expect(decide(args)).toEqual(decide(args));
  });
});
