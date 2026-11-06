// Prices a request after the fact, estimates it before, and decides whether to send, ask or block.
// Money is added up in whole nano-dollars (integers), so sums never drift, and divided once at the end.
import { LONG_PROMPT_TOKENS, USD_PER_WEB_SEARCH, priceFor, type ModelPrice } from './pricing';
import { CLIENT_TOOLS, SYSTEM_PROMPT } from './prompts';
import type { ContextPack, ModelChoice, ModelRole } from './types';

/** One request's usage, as the API reports it. */
export interface UsageTokens {
  /** Fresh input, not read from or written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

const NANO = 1e9;
/** $ per MTok to nano-dollars per token: x 1e9 / 1e6. */
const nanoPerToken = (usdPerMTok: number) => Math.round(usdPerMTok * 1000);
const nano = (usd: number) => Math.round(usd * NANO);

/**
 * The cost of one request in US dollars. Cache writes cost 1.25x the input rate, cache reads each model's own rate, each web
 * search $0.01, and a prompt over 100,000 tokens (fresh + written + read) uses the model's long-prompt rates for the whole
 * request, where it has any. Pass one request at a time: the long-prompt rule is per request.
 */
export function usdFromUsage(usage: UsageTokens, price: ModelPrice): number {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const tier = price.longPrompt && prompt > LONG_PROMPT_TOKENS && price.longPrompt.input >= price.rates.input ? price.longPrompt : price.rates;
  const nano =
    usage.inputTokens * nanoPerToken(tier.input) +
    usage.cacheWriteTokens * nanoPerToken(tier.cacheWrite) +
    usage.cacheReadTokens * nanoPerToken(tier.cacheRead) +
    usage.outputTokens * nanoPerToken(tier.output) +
    usage.webSearches * Math.round(USD_PER_WEB_SEARCH * NANO);
  return nano / NANO;
}

// ---- Estimating before sending ----

/**
 * How many real tokens a line's tokenizer makes for each token the `chars / 4` rule predicts. The live check measures these
 * with free token counting and prints the numbers to put here. Haiku 5.5 counts about 30% more (plan, risks).
 */
export const CALIBRATION: Readonly<Record<string, number>> = { haiku: 1.3, sonnet: 1, opus: 1 };
/** For a line with no measurement: the highest known, so the estimate is not low. */
export const CALIBRATION_DEFAULT = 1.3;
export const calibrationFor = (line: string | null): number => (line ? CALIBRATION[line.toLowerCase()] ?? CALIBRATION_DEFAULT : CALIBRATION_DEFAULT);

/**
 * Tokens of fixed text sent with every request (the tool list and the system prompt), by the plain `chars / 4` rule and before
 * calibration. Worked out from the real text, so it can never go stale when the prompt changes. The web search tool adds a little.
 */
export const FIXED_PROMPT_TOKENS = Math.ceil((SYSTEM_PROMPT.length + JSON.stringify(CLIENT_TOOLS).length + 90) / 4);
/** What an answer plus its thinking usually adds up to, per role (research 06 §8). The live check tunes these. */
export const EXPECTED_OUTPUT_TOKENS: Readonly<Record<ModelRole, number>> = { 'default': 800, 'think-harder': 1400 };
/** A question with a few lines of the owner's own words. */
const QUESTION_TOKENS = 80;

const textTokens = (chars: number) => Math.ceil(chars / 4);

/** Tokens of the document text in a pack, by the plain `chars / 4` rule, before calibration. */
export function packTextTokens(pack: ContextPack): number {
  let t = 0;
  const m = pack.map;
  if (m.title) t += textTokens(m.title.length + 8);
  if (m.abstract) t += textTokens(m.abstract.text.length + 20);
  for (const h of m.headings) t += textTokens(h.text.length + 20);
  for (const f of m.figures) t += textTokens(f.label.length + f.caption.length + 20);
  const seen = new Set<string>();
  const add = (p: { pageIndex: number; start: number; end: number; textSource: string; text: string }) => {
    const k = `${p.textSource}|${p.pageIndex}|${p.start}|${p.end}`;
    if (seen.has(k)) return;
    seen.add(k);
    t += textTokens(p.text.length + 8);
  };
  if (pack.focus) add(pack.focus);
  for (const p of pack.passages) add(p);
  for (const f of pack.figures) {
    if (f.caption) add(f.caption);
    t += textTokens(f.insideText.length + 60);
    for (const p of f.mentions) add(p);
  }
  return t;
}

export interface Estimate {
  inputTokens: number;
  usd: number;
  /** False when the model could not be priced exactly. The caller asks before sending. */
  priceKnown: boolean;
}

/**
 * About what one question costs, worst case for the first turn: the whole prompt is written to the cache (1.25x), the answer
 * is the usual length for the role, and web search, if on, counts one search. A later turn in the same thread is cheaper,
 * because the prompt is read from the cache. Show it as "about".
 */
export function estimate(pack: ContextPack, role: ModelRole, model: ModelChoice, o: { webSearch?: boolean; questionTokens?: number } = {}): Estimate {
  const price = priceFor(model);
  const factor = calibrationFor(price.line);
  const text = Math.ceil((FIXED_PROMPT_TOKENS + packTextTokens(pack) + (o.questionTokens ?? QUESTION_TOKENS)) * factor);
  const images = model.imageInput ? pack.figures.reduce((sum, f) => sum + f.image.visualTokens + (f.more ?? []).reduce((n, m) => n + m.visualTokens, 0), 0) : 0;
  const inputTokens = text + images;
  const usd = usdFromUsage(
    { inputTokens: 0, cacheWriteTokens: inputTokens, cacheReadTokens: 0, outputTokens: EXPECTED_OUTPUT_TOKENS[role], webSearches: o.webSearch ? 1 : 0 },
    price,
  );
  return { inputTokens, usd, priceKnown: price.basis !== 'unknown-line' };
}

/** About what a typical question costs on this model, for Settings. Nominal pack: 3,500 tokens of document text, no figure. */
export function typicalQuestionUsd(model: ModelChoice, role: ModelRole): number {
  const price = priceFor(model);
  const factor = calibrationFor(price.line);
  const inputTokens = Math.ceil((FIXED_PROMPT_TOKENS + 800 + 3500 + QUESTION_TOKENS) * factor);
  return usdFromUsage({ inputTokens: 0, cacheWriteTokens: inputTokens, cacheReadTokens: 0, outputTokens: EXPECTED_OUTPUT_TOKENS[role], webSearches: 0 }, price);
}

// ---- Deciding ----

export type Ask = 'unsaved' | 'over-threshold' | 'whole-document';

export interface DecideInput {
  estimateUsd: number;
  /** This month's spend so far, from real usage. */
  spentUsd: number;
  /** The monthly cap; null means no cap. */
  capUsd: number | null;
  /** Ask first when the estimate is over this; null means never ask for cost. Default 0.25. */
  confirmOverUsd: number | null;
  /** Whether the PDF is in the library. Nothing from an unsaved PDF is sent until the owner confirms. */
  saved: boolean;
  scope: 'passages' | 'whole-document';
  /** Asks the owner has already said yes to in this send, so the next call moves on to the next question. */
  confirmed?: readonly Ask[];
  /**
   * `estimate().priceKnown`. Required, so a caller cannot forget it: when false (a model with no line, priced at the highest known)
   * the request always asks before it is sent.
   */
  priceKnown: boolean;
}

export type Decision = 'send' | { ask: Ask; usd: number } | { block: 'over-cap' };

/**
 * Send, ask, or block.
 * - Block when the cap is reached (spent is at or over it) or this request would take the month over it. Spending exactly up to
 *   the cap is allowed. A cap of 0 blocks everything.
 * - Then ask, one question at a time: an unsaved PDF first (it is about privacy), then "the whole document", then cost: an
 *   estimate strictly over the threshold, an estimate or spend that is not a number, or any estimate for an unpriced model.
 */
export function decide(i: DecideInput): Decision {
  const { estimateUsd: usd } = i;
  // Compared in whole nano-dollars, so 4.96 + 0.04 against a cap of 5 is exactly on the cap and not a hair over it.
  if (i.capUsd !== null && (nano(i.spentUsd) >= nano(i.capUsd) || nano(i.spentUsd + usd) > nano(i.capUsd))) return { block: 'over-cap' };
  const done = new Set(i.confirmed ?? []);
  if (!i.saved && !done.has('unsaved')) return { ask: 'unsaved', usd };
  if (i.scope === 'whole-document' && !done.has('whole-document')) return { ask: 'whole-document', usd };
  // A number we cannot read (NaN, Infinity) is never "cheap": `NaN > 0.25` is false, which would let the request through.
  const unreadable = !Number.isFinite(usd) || !Number.isFinite(i.spentUsd);
  const costly = unreadable || (i.confirmOverUsd !== null && usd > i.confirmOverUsd);
  if ((costly || !i.priceKnown) && !done.has('over-threshold')) return { ask: 'over-threshold', usd };
  return 'send';
}
