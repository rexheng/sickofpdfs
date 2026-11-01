// What Claude costs. Prices are data keyed by the model's `line` (from the Models API, never read off the id) and the
// version number in its display name. Sources: research 06 §6 (Haiku 5.5, Sonnet 5.5, Opus 5.5) and the platform price list
// for the older versions. List prices are USD per million tokens (MTok); cache writes are the 5-minute kind (1.25x).
//
// Rules (plan, slice H):
// - A version we do not know uses the HIGHEST price known for its line, so an estimate is never low.
// - A model with no line cannot be priced: it gets the highest price of all, flagged `unknown-line`, and the caller asks first.
import type { ModelChoice } from './types';

/** US dollars per million tokens, as list prices. */
interface Rates { input: number; cacheWrite: number; cacheRead: number; output: number }

interface Row {
  /** The version as printed in a display name, for example "5.5". */
  version: string;
  rates: Rates;
  /**
   * Some models cost more once the whole prompt (fresh input + cache writes + cache reads) is over 100,000 tokens. The higher
   * rates apply to the whole request. Haiku 5.5 only; the cache rates there follow its usual ratios (an assumption the live
   * check cannot reach cheaply, flagged in the report).
   */
  longPrompt?: Rates;
}

const r = (input: number, output: number, cacheRead: number): Rates => ({ input, cacheWrite: input * 1.25, cacheRead, output });

const PRICE_TABLE: Readonly<Record<string, readonly Row[]>> = {
  haiku: [
    { version: '5.5', rates: r(0.1, 0.5, 0.01), longPrompt: r(0.5, 2.5, 0.05) },
    { version: '4.5', rates: r(1, 5, 0.1) },
  ],
  sonnet: [
    { version: '5.5', rates: r(2, 10, 0.1) },
    { version: '5', rates: r(2, 10, 0.1) },
    { version: '4.6', rates: r(3, 15, 0.3) },
  ],
  opus: [
    { version: '5.5', rates: r(4, 20, 0.2) },
    { version: '5', rates: r(5, 25, 0.25) },
    { version: '4.8', rates: r(5, 25, 0.5) },
    { version: '4.7', rates: r(5, 25, 0.5) },
    { version: '4.6', rates: r(5, 25, 0.5) },
  ],
  fable: [
    { version: '5.1', rates: r(10, 50, 0.25) },
    { version: '5', rates: r(10, 50, 1) },
  ],
  mythos: [
    { version: '5.1', rates: r(10, 50, 0.25) },
  ],
};

/** Web search is billed per search, on top of the tokens: $10 per 1,000. */
export const USD_PER_WEB_SEARCH = 0.01;
/** A prompt over this many tokens costs the long-prompt rates where a model has them. */
export const LONG_PROMPT_TOKENS = 100_000;

export interface ModelPrice {
  line: string | null;
  /** The version found in the display name; null when there was none. */
  version: string | null;
  /**
   * exact: this line and version are in the table.
   * highest-for-line: the line is known, the version is not, so the highest price of that line is used.
   * unknown-line: no line (or one we have no prices for), so the highest price of all is used. Ask before sending.
   */
  basis: 'exact' | 'highest-for-line' | 'unknown-line';
  rates: Rates;
  longPrompt: Rates | null;
}

/** "Claude Haiku 5.5" gives "5.5"; "Claude Opus 5" gives "5". The first number in the name that looks like a version. */
export function versionOf(displayName: string): string | null {
  const m = /(\d+(?:\.\d+)?)/.exec(displayName);
  return m?.[1] ?? null;
}

/** Dearer by input plus output; a tie goes to the higher cache read, so "the highest known price" is never the cheaper way to read. */
const dearer = (a: Row, b: Row): Row => {
  const sa = a.rates.input + a.rates.output;
  const sb = b.rates.input + b.rates.output;
  if (sa !== sb) return sa > sb ? a : b;
  return a.rates.cacheRead >= b.rates.cacheRead ? a : b;
};

function highestOf(rows: readonly Row[]): { rates: Rates; longPrompt: Rates | null } {
  const top = rows.reduce(dearer);
  return { rates: top.rates, longPrompt: top.longPrompt ?? null };
}

export function priceFor(model: Pick<ModelChoice, 'line' | 'displayName'>): ModelPrice {
  const line = model.line?.trim().toLowerCase() || null;
  const version = versionOf(model.displayName);
  const rows = line ? PRICE_TABLE[line] : undefined;
  if (!line || !rows) {
    const top = highestOf(Object.values(PRICE_TABLE).flat());
    return { line, version, basis: 'unknown-line', rates: top.rates, longPrompt: null };
  }
  const exact = version ? rows.find((row) => row.version === version) : undefined;
  if (exact) return { line, version, basis: 'exact', rates: exact.rates, longPrompt: exact.longPrompt ?? null };
  const top = highestOf(rows);
  return { line, version, basis: 'highest-for-line', rates: top.rates, longPrompt: top.longPrompt };
}

/** Every line we have prices for, so Settings can group and warn. */
export const KNOWN_LINES: readonly string[] = Object.keys(PRICE_TABLE);
