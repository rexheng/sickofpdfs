// What Find matches against: a page's chars, folded the way anchoring folds them (text-fold.ts: the marks that are not
// text dropped, runs of whitespace and line breaks one space, ligatures as letters), then made loose the way Chrome's
// find is: no case, no accents, and compatibility forms as their plain letters. Every searchable char keeps the PDFium
// char index it came from, so a match maps back to the page's chars exactly.
//
// A word split at the end of a line matches as one word:
// - PDFium joins most such words itself and leaves U+FFFE where the hyphen was ("learn￾ing"). The fold drops it,
//   so "learning" matches; a JOIN mark is kept in its place, so "high-level" also matches "high￾level".
// - A hyphen PDFium left at the end of a line ("state-of-the-\r\nart") becomes the same JOIN mark, without the line
//   break: "state-of-the-art" and "stateoftheart" both match.
// The query is folded the same way. Between any two of its chars the text may hold a JOIN, and a hyphen in the query
// matches a JOIN, so neither form of a hyphenated word is lost.
import { foldText } from '@sop/core/text-fold';

/** JOIN (U+0000) in searchable text: a line-end hyphen that joined two parts of a word. */
const JOIN_CODE = 0;
const SPACE = 0x20;
const HYPHEN = 0x2d;
/** Chars turned into a string at once (an argument list must stay well under the engine's limit). */
const DECODE_CHUNK = 4096;
/** PDFium's mark for the line-end hyphen it joined (getPageChars keeps it; the fold drops it). */
const PDFIUM_JOIN = 0xfffe;
/** Some PDFium builds report the joined hyphen as U+0002 instead. */
const PDFIUM_JOIN_OLD = 0x0002;

/** Hyphens and minus signs that a typed "-" finds, and that find a typed "-". */
const DASHES = new Set(['-', '‐', '‑', '‒', '–', '−']);
/** Curly quotes and primes, so that "don't" finds "don’t". */
const QUOTES: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '‛': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '″': '"',
};

const MARKS = /\p{M}/gu;
const looseCache = new Map<string, string>();

/**
 * One char made loose: lower case, accents and other combining marks removed, compatibility forms (full-width letters,
 * superscripts) as their plain letters, hyphens and dashes as "-", curly quotes straight. May be '' (a combining mark
 * on its own) or several chars.
 */
function loose(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 0x80) {
    if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 32);
    return code < 0x20 ? '' : ch; // control chars are not text
  }
  let v = looseCache.get(ch);
  if (v === undefined) {
    if (DASHES.has(ch)) v = '-';
    else if (QUOTES[ch] !== undefined) v = QUOTES[ch];
    else v = ch.toLowerCase().normalize('NFKD').replace(MARKS, '').toLowerCase();
    looseCache.set(ch, v);
  }
  return v;
}

/** A page's chars, ready to search. */
export interface FindText {
  /** Loose folded text. JOIN (U+0000) stands where a line-end hyphen joined a word. */
  text: string;
  /** For each char of `text`, the PDFium char index it came from. */
  src: Uint16Array | Int32Array;
  /** How many chars of the page are text (not spaces): 0 on a page with no text, such as a scan without OCR. */
  letters: number;
  /**
   * Where a char's match ends when combining marks follow it ("e" + U+0301): the char index after its last mark. Only
   * chars followed by such marks are listed, so a match that ends on one keeps its accent.
   */
  tails?: Map<number, number>;
}

const isLineBreak = (c: number) => c === 0x0a || c === 0x0d;

/** Whether raw chars [from, to) hold a line break. */
function holdsLineBreak(raw: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (isLineBreak(raw.charCodeAt(i))) return true;
  return false;
}

/** The index of PDFium's joined-hyphen mark in raw chars [from, to), or −1. */
function joinIn(raw: string, from: number, to: number): number {
  for (let i = from; i < to; i++) if (raw.charCodeAt(i) === PDFIUM_JOIN) return i;
  return -1;
}

/**
 * The searchable form of a page's chars. `raw` is getPageChars: raw[i] is PDFium char i, with U+FFFE where PDFium joined
 * a line-end hyphen and its generated '\r\n' line breaks.
 */
export function buildFindText(raw: string): FindText {
  const f = foldText(raw, { trim: false });
  const folded = f.text;
  const n = folded.length;
  // Typed buffers, not arrays of strings: a 700-page book is 1.4 million chars, and this runs once per page.
  let cap = n + 16;
  let codes = new Uint16Array(cap);
  let srcs = new Int32Array(cap);
  let len = 0;
  const push = (code: number, at: number) => {
    if (len === cap) {
      cap *= 2;
      const c = new Uint16Array(cap);
      c.set(codes);
      codes = c;
      const s = new Int32Array(cap);
      s.set(srcs);
      srcs = s;
    }
    codes[len] = code;
    srcs[len] = at;
    len++;
  };
  const last = () => (len > 0 ? codes[len - 1] : -1);
  let letters = 0;
  let tails: Map<number, number> | undefined;
  let prevSrc = -1;
  for (let k = 0; k < n; k++) {
    const s = f.src[k];
    // PDFium joined a hyphenated word between the last char and this one: the fold dropped its mark.
    if (prevSrc >= 0 && s - prevSrc > 1) {
      const j = joinIn(raw, prevSrc + 1, s);
      if (j >= 0 && last() !== JOIN_CODE) push(JOIN_CODE, j);
    }
    prevSrc = s;
    const code = folded.charCodeAt(k);
    if (code === SPACE) {
      // A hyphen left at the end of a line: the hyphen joins the word, and the line break goes.
      const next = k + 1 < n ? f.src[k + 1] : raw.length;
      if (last() === HYPHEN && holdsLineBreak(raw, s, next)) codes[len - 1] = JOIN_CODE;
      else if (len > 0 && last() !== SPACE) push(SPACE, s);
      continue;
    }
    // Printable ASCII, nearly all of a page: lower case is the only change.
    if (code > 0x20 && code < 0x7f) {
      push(code >= 0x41 && code <= 0x5a ? code + 32 : code, s);
      letters++;
      continue;
    }
    if (code === PDFIUM_JOIN_OLD) {
      if (len > 0 && last() !== JOIN_CODE) push(JOIN_CODE, s);
      continue;
    }
    // An astral char (a maths italic letter, 𝑥) is two code units: made loose as one, so 𝑥 is found by "x".
    const low = k + 1 < n ? folded.charCodeAt(k + 1) : 0;
    const pair = code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff && f.src[k + 1] === s + 1;
    const l = loose(pair ? folded.slice(k, k + 2) : folded[k]);
    if (pair) {
      k++;
      prevSrc = s + 1;
    }
    // A combining mark on its own folds to nothing: a match ending on the char before it takes it along.
    if (l === '' && len > 0) (tails ??= new Map()).set(srcs[len - 1], (pair ? s + 1 : s) + 1);
    for (let i = 0; i < l.length; i++) push(l.charCodeAt(i), s);
    if (pair && l !== '') (tails ??= new Map()).set(s, s + 2);
    letters += l.length;
  }
  let text = '';
  for (let i = 0; i < len; i += DECODE_CHUNK) text += String.fromCharCode(...codes.subarray(i, Math.min(len, i + DECODE_CHUNK)));
  const t: FindText = { text, src: raw.length < 0xffff ? Uint16Array.from(srcs.subarray(0, len)) : srcs.slice(0, len), letters };
  if (tails) t.tails = tails;
  return t;
}

/** The query as it is matched: folded and loose like page text. '' when it holds nothing to find (only spaces). */
export function findKey(query: string): string {
  const f = foldText(query, { trim: false }).text;
  let out = '';
  for (const ch of f) out += ch === ' ' ? ' ' : loose(ch);
  out = out.replace(/ {2,}/gu, ' ');
  return out.trim() === '' ? '' : out;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/u;

/**
 * A pattern for a key (findKey's result): its chars in order, any of which may be followed by a JOIN in the text, with
 * a "-" also matching a JOIN on its own.
 */
export function findPattern(key: string): RegExp {
  const parts: string[] = [];
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    parts.push(ch === '-' ? '(?:-|\\0)' : REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch);
  }
  return new RegExp(parts.join('\\0?'), 'g');
}

/** One match on a page: PDFium chars [start, start + count). */
export interface FindMatch {
  start: number;
  count: number;
}

/** Every match of `pattern` (findPattern) in a page's FindText, in text order, none overlapping. */
export function matchFindText(t: FindText, pattern: RegExp): FindMatch[] {
  const out: FindMatch[] = [];
  pattern.lastIndex = 0;
  for (let m = pattern.exec(t.text); m !== null; m = pattern.exec(t.text)) {
    const i = m.index;
    const j = i + m[0].length;
    if (j === i) {
      pattern.lastIndex++;
      continue;
    }
    // A match that starts or ends on a JOIN covers it; one between two words never does.
    const start = t.src[i];
    const end = t.tails?.get(t.src[j - 1]) ?? t.src[j - 1] + 1;
    out.push({ start, count: end - start });
  }
  return out;
}
