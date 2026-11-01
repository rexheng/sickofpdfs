// Download stamps, and "is this the same text with a new stamp?".
//
// Many sites print a stamp on every page of a download (JSTOR: "This content downloaded from <IP> on <date>"). Two
// downloads of one article have different bytes, so different fingerprints, but the same words. When a newly opened PDF
// is the same text as a known document apart from its stamps, its fingerprint becomes an alias of that document: same
// notes, nothing copied (spec, Identity rule 2). `isStampAlias` is the one rule that decides; the store calls it.
//
// Page text is the engine's raw page text, or getPageText's (without U+FFFE and U+FFFF). Each page is folded first, the
// way anchoring folds text (anchoring/text-fold.ts: marks that are not text dropped, runs of whitespace one space,
// ligature characters letters), and only then are the stamps looked for. So a stamp whose line has marks at its edges,
// or a date split across a line break, is found like any other.
import DiffMatchPatch from 'diff-match-patch';
import { foldText } from '../anchoring/text-fold';

/** The least that `stampedTextSimilarity` must reach for an alias (the spec's 99.5%). It is a floor, not the whole rule. */
export const ALIAS_THRESHOLD = 0.995;

/** Each side needs this many letters and digits in total (after stamps are removed) to count as having body text. */
export const MIN_ALIAS_CHARS = 200;
/** ... and this many per page on average. A scan whose text layer holds only page numbers has about 3. */
export const MIN_ALIAS_CHARS_PER_PAGE = 30;
/** The budget is `(1 − ALIAS_THRESHOLD) × characters` edits, kept in whole numbers so that the boundary is exact. */
const BUDGET_PER_THOUSAND = Math.round((1 - ALIAS_THRESHOLD) * 1000);
/** diff_match_patch's time limit per page, in seconds. When it runs out the diff is rougher, which only means "less alike". */
const DIFF_TIMEOUT_S = 0.1;

// ---- what is a stamp ----

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const WEEKDAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?';
const CLOCK = '\\d{1,2}:\\d{2}(?::\\d{2})?';

/**
 * The dates, longest forms first. Text is folded before these run, so a space is one space and a date that was split
 * across a line break is already whole.
 */
const DATE_FORMS: readonly string[] = [
  // ISO, with an optional time and zone: 2026-10-31, 2026-10-31T10:41:07Z, 2026-10-31 10:41:07+01:00.
  '\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?',
  // Tue, 31 Oct 2026 10:41:07 UTC.
  `${WEEKDAY},? \\d{1,2} ${MONTH} \\d{4}(?: ${CLOCK}(?: ?(?:UTC|GMT))?)?`,
  // 31 October 2026.
  `\\d{1,2} ${MONTH} \\d{4}`,
  // October 31, 2026.
  `${MONTH} \\d{1,2}, \\d{4}`,
  // 31/10/2026, 31-10-2026, 31.10.2026 ("Accessed: 21-02-2017" on a JSTOR cover page).
  '\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}(?!\\d)',
];
const DATE = `(?:${DATE_FORMS.join('|')})`;

/** What is removed, in this order. Each match becomes one space; the spaces are folded again at the end. */
const STAMP_PATTERNS: readonly RegExp[] = [
  // 1. JSTOR's two lines. The IP address and the date are removed by the patterns below.
  /This content downloaded(?: from \S+)? on\b/gi,
  /All use subject to https?:\/\/about\.jstor\.org\/terms/gi,
  // 2. Publisher and library lines: "Downloaded from <link> [by <who>] on [<date>]" and "Downloaded by [<who>] at <when>".
  //    <who> is the institution or user and changes with every download, so it goes too.
  new RegExp(`Downloaded from https?:\\/\\/\\S+(?: by .{1,150}?)? on \\[?${DATE}\\]?`, 'gi'),
  /Downloaded by \[[^\]]{1,150}\] at\b/gi,
  // 3. Dates, longest forms first. They go before the addresses: "10:41:07" also looks like the end of an IPv6 address.
  ...DATE_FORMS.map((form) => new RegExp(`\\b${form}`, 'gi')),
  // 4. Times that say they are times (with seconds, or AM, PM, UTC or GMT), then IP addresses: IPv4, then IPv6.
  /\b\d{1,2}:\d{2}:\d{2}(?: ?(?:AM|PM|UTC|GMT)\b)?/gi,
  /\b\d{1,2}:\d{2} ?(?:AM|PM|UTC|GMT)\b/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b/gi,
  // 5. Any time left: "20:48", "3:15".
  /\b\d{1,2}:\d{2}\b/g,
];

/**
 * A page's text with the marks that are not text dropped, the download stamp, IP addresses, dates and times removed, and
 * whitespace folded to single spaces. Two downloads of one page give the same string.
 */
export function stripStamps(pageText: string): string {
  let text = foldText(pageText).text;
  for (const pattern of STAMP_PATTERNS) text = text.replace(pattern, ' ');
  return text.replace(/ {2,}/g, ' ').trim();
}

// ---- comparing ----

/** The text with everything but letters and digits gone, and accents split off first so that "é" and "e" match. */
const lettersAndDigits = (text: string): string => text.normalize('NFD').replace(/[^\p{L}\p{N}]+/gu, '');
/** The count of letters and digits in `text`. */
const countLettersAndDigits = (text: string): number => text.replace(/[^\p{L}\p{N}]+/gu, '').length;

interface Comparison {
  /** 0 to 1; 0 when the pair cannot be compared or has too little text. Exact when at least ALIAS_THRESHOLD. */
  similarity: number;
  /** All of the alias rule holds. */
  alias: boolean;
}

const NOT_ALIKE: Comparison = { similarity: 0, alias: false };

function compare(a: readonly string[], b: readonly string[]): Comparison {
  if (a.length !== b.length || a.length === 0) return NOT_ALIKE;

  const sa: string[] = [];
  const sb: string[] = [];
  let lenA = 0;
  let lenB = 0;
  let total = 0; // the longer of each pair of pages, summed: what the edit count is a share of
  for (let i = 0; i < a.length; i++) {
    sa[i] = stripStamps(a[i]);
    sb[i] = a[i] === b[i] ? sa[i] : stripStamps(b[i]);
    lenA += sa[i].length;
    lenB += sb[i].length;
    total += Math.max(sa[i].length, sb[i].length);
  }
  // Too little to tell two PDFs apart (a blank scan is "the same" as every other blank scan). Counted by length first, which
  // is cheap and can only over-count; the letters and digits are counted below, when everything else has passed.
  const shortest = Math.min(lenA, lenB);
  if (shortest < MIN_ALIAS_CHARS || shortest < MIN_ALIAS_CHARS_PER_PAGE * a.length) return NOT_ALIKE;
  if (Math.abs(lenA - lenB) * 1000 > BUDGET_PER_THOUSAND * Math.max(lenA, lenB)) return NOT_ALIKE;

  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = DIFF_TIMEOUT_S;
  let edits = 0;
  let seen = 0; // `total` for the pages compared so far
  for (let i = 0; i < a.length; i++) {
    const longest = Math.max(sa[i].length, sb[i].length);
    seen += longest;
    if (sa[i] === sb[i]) continue;
    // No page needs more edits than its longer text has characters (diff_match_patch can count a few more on unlike text).
    edits += Math.min(dmp.diff_levenshtein(dmp.diff_main(sa[i], sb[i], false)), longest);
    // Already too many edits: stop here. What is returned is below ALIAS_THRESHOLD, and an upper bound on the true value.
    if (edits * 1000 > BUDGET_PER_THOUSAND * total) return { similarity: (seen - edits) / seen, alias: false };
  }
  const similarity = (total - edits) / total;

  // Alike enough by count. Now the letters and digits, which are what a person's notes are about.
  let letters = 0;
  let sameLetters = true;
  for (let i = 0; i < a.length; i++) {
    letters += countLettersAndDigits(sa[i]);
    if (sameLetters && sa[i] !== sb[i] && lettersAndDigits(sa[i]) !== lettersAndDigits(sb[i])) sameLetters = false;
  }
  if (letters < MIN_ALIAS_CHARS || letters < MIN_ALIAS_CHARS_PER_PAGE * a.length) return NOT_ALIKE;
  return { similarity, alias: sameLetters };
}

/**
 * How alike two PDFs' page texts are, from 0 to 1, after stamps are removed: 1 − (edits / characters), page by page. It
 * is 0 when the page counts differ or there is too little text to compare, and exact whenever it is at least
 * ALIAS_THRESHOLD; below that it only means "not alike" and the number is an upper bound, because the comparison stops
 * as soon as the answer is known.
 *
 * It is a score, not the decision: copies that score 0.9999 can still be different documents (see `isStampAlias`).
 */
export function stampedTextSimilarity(a: readonly string[], b: readonly string[]): number {
  return compare(a, b).similarity;
}

/**
 * Whether two PDFs, given as the text of each page, are one document that differs only by its download stamp. The store's
 * `findStampAlias` asks this of every candidate; where it is true, `stampedTextSimilarity` is the number to record.
 *
 * Ruling R59. All of these must hold:
 *  (a) the page counts are equal;
 *  (b) after the stamp lines are removed and the text is folded, the LETTERS AND DIGITS are the same, in the same order. The
 *      two texts may differ only in whitespace, punctuation and accents. One changed word or number is a different document;
 *  (c) `stampedTextSimilarity` is at least ALIAS_THRESHOLD, kept as a sanity floor;
 *  (d) each side has real body text (MIN_ALIAS_CHARS letters and digits, MIN_ALIAS_CHARS_PER_PAGE per page). A blank scan, or
 *      a scan whose text layer is page numbers, is the same "text" as every other one of that length and never aliases.
 *
 * Why (b): a percentage cannot tell a re-download from a new version. An arXiv v2 that corrects three numbers scores about
 * 0.9999 against v1 (real pairs scored 0.9991 and 0.99993), and would have shared v1's notes. A missed alias costs a
 * re-save; a wrong alias shows the wrong notes. So when in doubt, it is not an alias.
 */
export function isStampAlias(a: readonly string[], b: readonly string[]): boolean {
  return compare(a, b).alias;
}
