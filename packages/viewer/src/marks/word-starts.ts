// Bold word starts (ruling R90): a reading aid that draws the first part of every word bold, to guide the eye. This file
// holds the word rule, as a pure function over a page's chars, and how a page's work is cut into engine calls. The
// drawing is BoldLayer's glyph-outline overlay with a heavier stroke (react/WordStartsLayer.tsx).
//
// The rule (R90, the Medium strength):
// - A word of 1 to 3 letters gets its first letter bold; a longer word its first half, rounded up ("Read·ing", 4 of 7;
//   "met·hod", 3 of 6; "facili·tating", 6 of 12).
// - Only letters count. A pure number, a maths symbol or punctuation is left alone. In a word that mixes letters and
//   digits ("2nd", "H2O"), the bold runs from the word's first char to its last bold letter.
// - Words are split on whitespace and punctuation, so each part of a hyphenated word is a word of its own. A word broken
//   at a line end is two words, one a line: PDFium's line breaks and its joined line-end hyphen (U+FFFE) split it.
// - An apostrophe between two letters ("don't", "it’s") does not split a word; it is not a letter, so it is not counted.
// - Combining marks (accents, Hebrew points, Arabic vowel signs) go with the letter before them and are not counted.
// - Scripts written without spaces between words (Chinese, Japanese, Thai, Lao, Khmer, Myanmar) have no word starts to
//   find in the chars, and are left alone; so are the maths alphabets (𝑥, ℝ), which are symbols here.
// - Right-to-left scripts: PDFium gives a page's chars in reading order (logical order; the tl-rtl fixture shows it), so
//   the first chars of a word are where its reading starts, at its right-hand end on the page.
//
// Ranges are PDFium char indices, `end` exclusive (BoldRange). An astral char is two chars (a surrogate pair) and counts
// as one letter. A ligature glyph stands for several chars; it is drawn bold when its first char is in a range
// (getGlyphShapes gives its outline at its first char).
import type { BoldRange } from './bold-painter';

/** What a char is to the word rule. */
const Kind = {
  /** Ends a word: whitespace, punctuation, a symbol, PDFium's line breaks and joined hyphen. */
  Break: 0,
  /** A letter: counted. */
  Letter: 1,
  /** Part of a word but not counted: a digit. */
  Digit: 2,
  /** Goes with the letter before it: a combining mark. */
  Mark: 3,
  /** Invisible and inside a word: a soft hyphen in mid-line, a zero-width joiner. Neither counted nor breaking. */
  Silent: 4,
  /** An apostrophe: inside a word when a letter is on both sides, otherwise a break. */
  Apostrophe: 5,
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];

const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const DIGIT = /^\p{N}$/u;
/** Scripts with no spaces between words: their runs of letters are not words, so they get no word starts. */
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]$/u;
/** Soft hyphen, zero-width space, non-joiner and joiner, word joiner, BOM. */
const SILENT = new Set([0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
/** ' and ’ (and the modifier letter apostrophe, which is a letter anyway). */
const APOSTROPHES = new Set([0x27, 0x2019]);

/** Whether `cp` is in a maths alphabet: Letterlike Symbols (ℝ, ℓ, ℏ) and Mathematical Alphanumeric Symbols (𝑥, 𝐀). */
const isMathsLetter = (cp: number): boolean => (cp >= 0x2100 && cp <= 0x214f) || (cp >= 0x1d400 && cp <= 0x1d7ff);

function kindOf(cp: number, ch: string): Kind {
  if (SILENT.has(cp)) return Kind.Silent;
  if (APOSTROPHES.has(cp)) return Kind.Apostrophe;
  if (LETTER.test(ch)) return isMathsLetter(cp) || UNSPACED.test(ch) ? Kind.Break : Kind.Letter;
  if (MARK.test(ch)) return Kind.Mark;
  if (DIGIT.test(ch)) return isMathsLetter(cp) ? Kind.Break : Kind.Digit;
  return Kind.Break; // whitespace, punctuation, symbols, U+FFFE / U+FFFF, private-use glyphs, lone surrogates
}

/** How many letters of a word of `letters` letters are bold (R90's Medium strength). */
export function boldLetterCount(letters: number): number {
  if (letters <= 0) return 0;
  return letters <= 3 ? 1 : Math.ceil(letters / 2);
}

/**
 * The word starts of a page: one range a word, in char order. `chars` is the page's chars as PDFium has them, one
 * UTF-16 unit each, so `chars[i]` is char `i` (PdfBackend.getPageChars, or the glyphs' texts joined).
 */
export function wordStartRanges(chars: string): BoldRange[] {
  const n = chars.length;
  // Per char: its kind. An astral char's high half is classified; its low half goes with it.
  const kinds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const cp = chars.codePointAt(i) ?? 0;
    const wide = cp > 0xffff;
    kinds[i] = kindOf(cp, wide ? chars.slice(i, i + 2) : chars[i]);
    if (wide) {
      // The low half goes with the high half: inside its word, or a break with it.
      kinds[i + 1] = kinds[i] === Kind.Break ? Kind.Break : Kind.Silent;
      i++;
    }
  }
  const prevLetter = (i: number): boolean => {
    for (let k = i - 1; k >= 0; k--) {
      const t = kinds[k] as Kind;
      if (t === Kind.Letter) return true;
      if (t !== Kind.Mark && t !== Kind.Silent) return false;
    }
    return false;
  };
  const nextLetter = (i: number): boolean => {
    for (let k = i + 1; k < n; k++) {
      const t = kinds[k] as Kind;
      if (t === Kind.Letter) return true;
      if (t !== Kind.Silent) return false;
    }
    return false;
  };
  const inWord = (i: number): boolean => {
    const t = kinds[i] as Kind;
    if (t === Kind.Break) return false;
    if (t === Kind.Apostrophe) return prevLetter(i) && nextLetter(i);
    return true;
  };

  const ranges: BoldRange[] = [];
  let i = 0;
  while (i < n) {
    if (!inWord(i)) {
      i++;
      continue;
    }
    // A word: [start, end).
    const start = i;
    let letters = 0;
    while (i < n && inWord(i)) {
      if (kinds[i] === Kind.Letter) letters++;
      i++;
    }
    const end = i;
    const bold = boldLetterCount(letters);
    if (bold === 0) continue; // a pure number
    // Through the bold-th letter, and the marks and silent chars that go with it (its accents, an astral letter's low half).
    let seen = 0;
    let k = start;
    while (k < end && seen < bold) {
      if (kinds[k] === Kind.Letter) seen++;
      k++;
    }
    while (k < end && (kinds[k] === Kind.Mark || (kinds[k] === Kind.Silent && (chars.charCodeAt(k) & 0xfc00) === 0xdc00))) k++;
    ranges.push({ start, end: k });
  }
  return ranges;
}

/** One engine call's worth of a page's word starts: chars [start, end) hold `ranges`. */
export interface WordStartChunk {
  start: number;
  end: number;
  ranges: BoldRange[];
}

/**
 * Cuts a page's word starts into engine calls of at most about `maxChars` chars each (a call holds the engine worker,
 * which also draws the pages, so it is kept short). A chunk starts at a word's first char, so no ligature is split
 * across two calls, and holds whole ranges; a range longer than `maxChars` is a chunk of its own.
 */
export function wordStartChunks(ranges: readonly BoldRange[], maxChars: number): WordStartChunk[] {
  const chunks: WordStartChunk[] = [];
  let open: WordStartChunk | null = null;
  for (const r of ranges) {
    if (open !== null && r.end - open.start <= maxChars) {
      open.end = r.end;
      open.ranges.push(r);
      continue;
    }
    open = { start: r.start, end: r.end, ranges: [r] };
    chunks.push(open);
  }
  return chunks;
}
