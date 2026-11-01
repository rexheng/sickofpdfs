// Does a newly opened PDF match a library document except for its download stamp? Used by `findStampAlias` only.
//
// Stand-in: Task 19 (packages/core/src/identity/stamps.ts: stripStamps, stampedTextSimilarity, ALIAS_THRESHOLD) is not on
// this base. This file follows Task 19's stripping rules, but it only has to answer one question: is the similarity at
// least ALIAS_MIN? When Task 19 lands, findStampAlias calls core's stampedTextSimilarity instead and this file is deleted.
//
// It errs towards "no": a missed alias only means a stamped re-download is kept as its own document, while a false one
// would put one paper's notes on another.

/** The lowest similarity that makes an alias (the spec's 99.5%, and the `aliases.similarity` CHECK). */
export const ALIAS_MIN = 0.995;

/** Below this many characters of text (after stamps are removed) there is too little to tell two papers apart. */
const MIN_TEXT = 200;

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?';
const CLOCK = '\\d{1,2}:\\d{2}(?::\\d{2})?';

/** Task 19's rules, in its order: stamp lines, then IP addresses, then dates and times. */
const STAMP_PATTERNS: RegExp[] = [
  /^This content downloaded from .*$/gim,
  /^All use subject to https?:\/\/about\.jstor\.org\/terms\s*$/gim,
  /^Downloaded from https?:\/\/\S+( by .+?)? on .+$/gim,
  /^Downloaded by \[.+?\] at .+$/gim,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b/gi,
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
  new RegExp(`\\b${DAY},?\\s+\\d{1,2}\\s+${MONTH}\\s+\\d{4}(?:\\s+${CLOCK}(?:\\s*(?:UTC|GMT))?)?`, 'gi'),
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2},\\s+\\d{4}\\b`, 'gi'),
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
  new RegExp(`\\b${CLOCK}(?:\\s*(?:AM|PM|UTC|GMT)\\b)?`, 'gi'),
];

/** A page's text with download stamps, IP addresses, dates and times removed, and whitespace collapsed. */
export function stripStampsForMatch(text: string): string {
  let out = text;
  for (const pattern of STAMP_PATTERNS) out = out.replace(pattern, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The similarity of two page lists after stamps are removed: 1 − (edit distance / characters). It is exact whenever it is
 * at least ALIAS_MIN. Below that it only means "not a match" (the comparison stops as soon as the answer is known), and
 * it is 0 when the page counts differ or there is too little text.
 */
export function stampedPagesSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const sa = a.map(stripStampsForMatch);
  const sb = b.map(stripStampsForMatch);
  let lenA = 0;
  let lenB = 0;
  let total = 0;
  for (let i = 0; i < sa.length; i++) {
    lenA += sa[i].length;
    lenB += sb[i].length;
    total += Math.max(sa[i].length, sb[i].length);
  }
  if (lenA < MIN_TEXT || lenB < MIN_TEXT) return 0;
  const budget = Math.floor(total * (1 - ALIAS_MIN) + 1e-9);
  const notAMatch = 1 - (budget + 1) / total;
  if (Math.abs(lenA - lenB) > budget) return notAMatch;
  // First a cheap pass with a narrow band: it gives each page's exact distance when it is small, and a lower bound when it is
  // not. Two different books fail here at once. Only pages above the band are then measured, within what is left.
  const low = sa.map((p, i) => boundedDistance(p, sb[i], QUICK_BAND));
  let distance = low.reduce((sum, d) => sum + d, 0);
  if (distance > budget) return notAMatch;
  for (let i = 0; i < sa.length; i++) {
    if (low[i] <= QUICK_BAND) continue;
    const others = distance - low[i];
    distance = others + boundedDistance(sa[i], sb[i], budget - others);
    if (distance > budget) return notAMatch;
  }
  return 1 - distance / total;
}

/** The first pass's band: a page within this many edits is measured exactly at once. */
const QUICK_BAND = 32;

/** The Levenshtein distance of `a` and `b` when it is at most `max`; otherwise some number above `max`. */
function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  let start = 0;
  while (start < a.length && start < b.length && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const gap = Math.abs(x.length - y.length);
  if (gap > max) return max + 1;
  if (x.length === 0 || y.length === 0) return gap;
  // Widen the band until the distance fits inside it, so the work follows the size of the difference, not of the page.
  for (let k = Math.max(1, gap); ; k = Math.min(max, k * 2)) {
    const d = bandedDistance(x, y, k);
    if (d <= k) return d;
    if (k >= max) return max + 1;
  }
}

/** Levenshtein distance computed only within |i − j| ≤ k: exact when the result is ≤ k, otherwise k + 1. */
function bandedDistance(x: string, y: string, k: number): number {
  const n = x.length;
  const m = y.length;
  const over = k + 1;
  let prev = new Int32Array(m + 2);
  let cur = new Int32Array(m + 2);
  for (let j = 0; j <= m + 1; j++) prev[j] = j <= k ? j : over;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(m, i + k);
    cur[lo - 1] = lo === 1 && i <= k ? i : over;
    let rowMin = cur[lo - 1];
    const xc = x.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const substitute = prev[j - 1] + (xc === y.charCodeAt(j - 1) ? 0 : 1);
      const remove = prev[j] + 1;
      const insert = cur[j - 1] + 1;
      let v = substitute < remove ? substitute : remove;
      if (insert < v) v = insert;
      if (v > over) v = over;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    cur[hi + 1] = over;
    if (rowMin > k) return over;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m] > over ? over : prev[m];
}
