// Cuts a page's text into passages: paragraphs, then sentences when a paragraph is longer than 300 tokens.
//
// Offsets are into the string you give (the page's `text()`), so a passage's `start` and `end` are the citation range
// for that text source. The same text always gives the same passages (the cache needs byte-identical packs).
import type { Passage } from './types';

/** A paragraph is cut at sentence ends to at most this many tokens (contract §6). */
export const MAX_PASSAGE_TOKENS = 300;
/** Tokens by the plain rule used everywhere in the pack maths. */
export const tokensOf = (chars: number): number => Math.ceil(chars / 4);
const MAX_CHARS = MAX_PASSAGE_TOKENS * 4;
/** Fragments shorter than this are page furniture (page numbers, running heads) and are not passages on their own. */
const MIN_CHARS = 24;

export interface Span { start: number; end: number; text: string }

interface Line { start: number; end: number }

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (const m of text.matchAll(/\r\n|\r|\n/g)) {
    out.push({ start: pos, end: m.index });
    pos = m.index + m[0].length;
  }
  out.push({ start: pos, end: text.length });
  return out;
}

const ENDS_SENTENCE = /[.!?:;]["')\]”’]*$/;

/**
 * Paragraph boundaries. PDF text has a line break at every line end, so a boundary needs a clue: an empty line, or a line
 * that ends a sentence and is clearly shorter than a full line (the last line of a paragraph).
 */
export function paragraphSpans(text: string): Span[] {
  const lines = linesOf(text);
  // A "full" line is near the top of the line lengths (not the single longest, which a web address can stretch).
  const lengths = lines.map((l) => l.end - l.start).filter((n) => n > 0).sort((a, b) => a - b);
  const full = lengths.length ? lengths[Math.floor(lengths.length * 0.85)] : 0;
  const spans: Span[] = [];
  let cur: Line | null = null;
  const flush = () => {
    if (cur) spans.push({ start: cur.start, end: cur.end, text: text.slice(cur.start, cur.end) });
    cur = null;
  };
  for (const l of lines) {
    const raw = text.slice(l.start, l.end);
    if (raw.trim() === '') { flush(); continue; }
    // Trim the line's own white space so spans start and end on text.
    const lead = raw.length - raw.trimStart().length;
    const tail = raw.length - raw.trimEnd().length;
    const line: Line = { start: l.start + lead, end: l.end - tail };
    const len = line.end - line.start;
    if (cur === null) cur = { ...line };
    else cur.end = line.end;
    if (ENDS_SENTENCE.test(raw.trimEnd()) && len < full * 0.8) flush();
  }
  flush();
  return spans;
}

const SENTENCE_END = /[.!?]["')\]”’]*(?=\s+[A-Z0-9“"([]|\s*$)/g;
/** Abbreviations that end in a full stop but not a sentence. */
const ABBREV = /(?:\b(?:e\.g|i\.e|et al|etc|vs|cf|Fig|Figs|Eq|Eqs|Sec|Tab|No|Dr|approx|resp)|\b[A-Z])\.$/;

function sentenceEnds(s: string): number[] {
  const ends: number[] = [];
  for (const m of s.matchAll(SENTENCE_END)) {
    const e = m.index + m[0].length;
    if (ABBREV.test(s.slice(0, e).replace(/["')\]”’]+$/, ''))) continue;
    ends.push(e);
  }
  return ends;
}

/** Cuts one span into pieces of at most MAX_CHARS, at sentence ends; a sentence longer than that is cut at a space. */
export function cutSpan(span: Span): Span[] {
  if (span.text.length <= MAX_CHARS) return [span];
  const ends = sentenceEnds(span.text);
  const out: Span[] = [];
  let from = 0;
  const push = (to: number) => {
    const raw = span.text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ start: span.start + from + lead, end: span.start + from + lead + t.length, text: t });
    from = to;
  };
  let last = from;
  for (const e of ends) {
    if (e - from > MAX_CHARS) {
      if (last > from) push(last);
      // A single sentence that is too long on its own.
      while (e - from > MAX_CHARS) {
        const sp = span.text.lastIndexOf(' ', from + MAX_CHARS);
        push(sp > from ? sp : from + MAX_CHARS);
      }
    }
    last = e;
  }
  while (span.text.length - from > MAX_CHARS) {
    const stop = ends.filter((e) => e > from && e - from <= MAX_CHARS).pop();
    if (stop !== undefined) push(stop);
    else {
      const sp = span.text.lastIndexOf(' ', from + MAX_CHARS);
      push(sp > from ? sp : from + MAX_CHARS);
    }
  }
  push(span.text.length);
  return out;
}

/** The page's passages in reading order, each at most 300 tokens, with no furniture. */
export function passageSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const p of paragraphSpans(text)) for (const piece of cutSpan(p)) if (piece.text.length >= MIN_CHARS) out.push(piece);
  return out;
}

/**
 * Short windows (three sentences, moving one sentence at a time) inside a passage. Ranking looks at these, so a passage
 * wins on the one place it answers, not on how many words it has in all. A passage of three sentences or fewer is one window.
 */
export function windowsOf(text: string): string[] {
  const ends = sentenceEnds(text);
  if (ends.length <= 3) return [text];
  const cuts = [0, ...ends.slice(0, -1), text.length];
  const out: string[] = [];
  for (let i = 0; i + 3 < cuts.length; i++) out.push(text.slice(cuts[i], cuts[i + 3]));
  return out;
}

export function toPassage(documentId: Passage['documentId'], pageIndex: number, textSource: string, s: Span, rank: number): Passage {
  return { documentId, pageIndex, start: s.start, end: s.end, textSource, text: s.text, rank, tokens: tokensOf(s.text.length) };
}
