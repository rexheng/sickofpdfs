// The one place a search box's text becomes an FTS5 MATCH expression. Nothing typed ever reaches MATCH as it was typed.
//
// What it does:
// - Splits the text on whitespace. Every term becomes one quoted phrase, so FTS5 never reads a word as syntax: `AND`, `OR`,
//   `NOT`, `NEAR(`, `col:word`, `-word`, `word*`, `(`, `^` and the rest are only letters inside quotes.
// - Double quotes the person types are removed (not escaped), so no quote can close a phrase early. Control characters,
//   which could cut a bound string short, are removed too. So is punctuation at the two ends of a term (`-word`, `word*`,
//   `(word)`, `word,`): FTS5 reads the words the same without it, and the query stays plain.
// - The last term is a prefix (`"regr"*`), so results follow the typing. Pass `prefix: false` for exact words.
// - Terms with no letter or digit are dropped. The length is capped (characters, terms, and the size of one term), so one
//   huge paste cannot make a huge query. When nothing is left the answer is `null`: there is nothing to search for.
//
// The result is for a bound parameter (`MATCH ?`). It is never joined into SQL text.

/** The most characters of the typed text that are looked at. */
export const MAX_QUERY_CHARS = 256;
/** The most terms of a query that are used. */
export const MAX_QUERY_TERMS = 16;
/** The longest a single term can be. A longer one is cut. */
export const MAX_TERM_CHARS = 48;

export interface FtsQueryOptions {
  /** Make the last term a prefix, so a half-typed word already matches. Default true. */
  prefix?: boolean;
  /**
   * The shortest last term (in characters) that becomes a prefix. A shorter plain-letter term is matched as a whole word,
   * because a prefix of one or two letters matches a large part of the index. A term with any character beyond ASCII
   * (Chinese, say, where one character is a word) is always a prefix. Default 1: every last term is a prefix.
   */
  minPrefixChars?: number;
}

// Anything FTS5 or a C string could trip over: control characters (NUL included), the double quote, and a lone surrogate
// (half of an emoji, say), which UTF-8 cannot hold.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f"\p{Cs}]/gu;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
// Letters, digits and combining marks belong to a word (a vowel sign ends many Indic words); anything else at an edge goes.
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu;

/** Cuts to at most `max` characters (code points, so a pair of surrogates is never split). */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * A search box's text as an FTS5 expression, or null when it holds nothing to search for. All terms must match. The last
 * term is a prefix unless `o.prefix` is false.
 */
export function ftsQuery(text: string, o: FtsQueryOptions = {}): string | null {
  if (typeof text !== 'string') return null;
  const clean = cut(text.normalize('NFC'), MAX_QUERY_CHARS).replace(UNSAFE, ' ');
  const terms = clean
    .split(/\s+/u)
    .map((t) => cut(t.replace(EDGE_PUNCTUATION, ''), MAX_TERM_CHARS))
    .filter((t) => HAS_WORD_CHAR.test(t))
    .slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return null;
  const quoted = terms.map((t) => `"${t}"`);
  const last = terms[terms.length - 1];
  const short = Array.from(last).length < (o.minPrefixChars ?? 1) && /^\p{ASCII}*$/u.test(last);
  if (o.prefix !== false && !short) quoted[quoted.length - 1] += '*';
  return quoted.join(' ');
}

/** A query of one ASCII letter or digit matches nearly every page. Searching it only keeps the store busy for nothing. */
export function isTooBroad(text: string): boolean {
  return /^"[A-Za-z0-9]"$/.test(ftsQuery(text, { prefix: false }) ?? '');
}
