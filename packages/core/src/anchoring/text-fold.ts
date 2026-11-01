// Matching text. Anchors compare "folded" text, never the raw page text, so that a note survives the things that change
// between two copies of one paper without changing its words:
//  - line breaks and runs of spaces ("training\r\nof" and "training of" are the same words);
//  - the marks PDFium puts in a page's chars that are not text (U+FFFE where it joins a line-end hyphen, soft hyphens,
//    zero-width spaces, word joiners, byte-order marks), the same set the engine strips from getPageText;
//  - ligature characters (U+FB00–U+FB06), which copy-paste turns back into letters.
// Letters keep their case and accents. Every folded char remembers the source offset it came from, so a match in folded
// text maps back to PDFium char indices.

/** Not text. The engine strips the same set from getPageText (backend/types.ts); backend.ts keeps the marks in chars. */
const IGNORABLE = new Set(['­', '​', '⁠', '﻿', '￾', '￿']);

const LIGATURES: Readonly<Record<string, string>> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
};

const WHITESPACE = /\s/;

export function isIgnorable(ch: string): boolean {
  return IGNORABLE.has(ch);
}

/** `s` without the marks that are not text. Whitespace stays as it is. */
export function stripIgnorable(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) if (!IGNORABLE.has(s[i])) out += s[i];
  return out;
}

export interface Folded {
  /** The folded text. */
  text: string;
  /** For each char of `text`, the index in the source string of the char it came from. */
  src: Int32Array;
}

/**
 * Folds `source`: marks that are not text are dropped, every run of whitespace becomes one space, and ligature chars
 * become letters. With `trim` (the default) no space is kept at either end.
 */
export function foldText(source: string, o: { trim?: boolean } = {}): Folded {
  const trim = o.trim ?? true;
  const chars: string[] = [];
  const src: number[] = [];
  let pendingSpace = -1; // source index of a whitespace run that has not been written yet
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (IGNORABLE.has(ch)) continue;
    if (WHITESPACE.test(ch)) {
      if (pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      if (!trim || chars.length > 0) {
        chars.push(' ');
        src.push(pendingSpace);
      }
      pendingSpace = -1;
    }
    const lig = LIGATURES[ch];
    if (lig) {
      for (let k = 0; k < lig.length; k++) {
        chars.push(lig[k]);
        src.push(i);
      }
    } else {
      chars.push(ch);
      src.push(i);
    }
  }
  if (pendingSpace >= 0 && !trim && chars.length > 0) {
    chars.push(' ');
    src.push(pendingSpace);
  }
  return { text: chars.join(''), src: Int32Array.from(src) };
}
