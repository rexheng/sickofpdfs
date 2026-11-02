// What the categoriser reads of a saved reading: its title plus the abstract, or the opening text when there is no abstract.
// This is the text the meaning vector is made from, and the words topic names are picked from. Pure and synchronous; it
// never throws and returns plain strings only. The text is untrusted: nothing here evaluates or renders it.
//
// Rules:
// - The abstract is the text after an "Abstract" heading on the first two pages, up to the next heading (Keywords, Introduction)
//   or MAX_ABSTRACT_CHARS, whichever comes first.
// - With no abstract, the opening text is the start of the first pages, with the lines that carry no meaning (page numbers,
//   web addresses, e-mail addresses, copyright lines, arXiv stamps) left out. Short cover pages are joined to the next ones, so
//   a book's meaning vector comes from its preface or contents, not from "Springer, 4th edition".
// - A scan or an unreadable PDF has no text: the title alone is the input.

/** The most characters of abstract or opening text kept. The model reads 2,000 characters in all (embedder.ts). */
export const MAX_ABSTRACT_CHARS = 1500;
/** Pages the opening text may come from. */
export const OPENING_PAGES = 3;

export type InputKind = 'abstract' | 'opening' | 'title';

export interface EmbeddingInput {
  /** What the model reads: the title, then the abstract or the opening text. */
  text: string;
  /** The abstract or opening text on its own (empty when only the title is known). */
  abstract: string;
  kind: InputKind;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
const clean = (s: string): string => s.normalize('NFKC').replace(CONTROL, '');

const ABSTRACT_HEADING = /^[\s*_#]*(?:abstract|summary|executive summary|résumé|zusammenfassung|resumen)\b[\s*_.:—–-]*/i;
const ENDS_ABSTRACT =
  /^[\s*_#]*(?:(?:\d+|[ivx]+)[.)]?\s+)?(?:keywords?|key words|index terms|jel (?:classification|codes?)|introduction|contents|table of contents|1\s+introduction|i\.\s+introduction)\b/i;

const NOISE_LINE = [
  /^\s*(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?\s*$/i, // a page number
  /^\s*(?:https?:\/\/|www\.)\S+\s*$/i, // a web address on its own line
  /^\s*\S+@\S+\.\S+\s*$/, // an e-mail address on its own line
  /^\s*(?:©|\(c\)|copyright)\b/i,
  /^\s*arxiv:\s*\d{4}\.\d{4,5}/i,
  /^\s*(?:all rights reserved|preprint|draft|confidential)\b/i,
];

/** The lines of a page, with the empty ones and the lines that carry no meaning left out. */
function meaningfulLines(page: string): string[] {
  const out: string[] = [];
  for (const raw of clean(page).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line === '' || NOISE_LINE.some((re) => re.test(line))) continue;
    out.push(line);
  }
  return out;
}

/** Joins lines into running text: a word split by a hyphen at the end of a line is joined again. */
function joinLines(lines: readonly string[]): string {
  let text = '';
  for (const line of lines) {
    if (text === '') text = line;
    else if (/[a-z]-$/.test(text) && /^[a-z]/.test(line)) text = text.slice(0, -1) + line;
    else text += ` ${line}`;
  }
  return text;
}

function abstractOf(pages: readonly string[]): string | null {
  const lines = pages.slice(0, 2).flatMap(meaningfulLines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = ABSTRACT_HEADING.exec(line);
    if (!m) continue;
    const taken: string[] = [];
    const rest = line.slice(m[0].length).trim();
    if (rest !== '') taken.push(rest);
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (ENDS_ABSTRACT.test(next) && joinLines(taken).length >= 120) break;
      taken.push(next);
      if (joinLines(taken).length >= MAX_ABSTRACT_CHARS) break;
    }
    const text = joinLines(taken).slice(0, MAX_ABSTRACT_CHARS).trim();
    // A heading with almost nothing after it ("Abstract" on a contents page) is not an abstract.
    if (text.length >= 80) return text;
  }
  return null;
}

function openingOf(pages: readonly string[], title: string): string {
  const titleWords = new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
  const parts: string[] = [];
  let length = 0;
  for (const page of pages.slice(0, OPENING_PAGES)) {
    const lines = meaningfulLines(page).filter((line) => {
      // A line that only repeats the title adds nothing.
      const words = line.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
      return !(words.length > 0 && titleWords.size > 0 && words.every((w) => titleWords.has(w)));
    });
    const text = joinLines(lines);
    if (text === '') continue;
    parts.push(text);
    length += text.length;
    if (length >= MAX_ABSTRACT_CHARS) break;
  }
  return parts.join(' ').slice(0, MAX_ABSTRACT_CHARS).trim();
}

/**
 * The text a reading is understood by. `title` is the reading's title (null when it has none: pass the file name's words
 * instead if you have them), `pageTexts` the text of its first pages in order (empty strings for pages with no text).
 */
export function embeddingInput(title: string | null | undefined, pageTexts: readonly string[]): EmbeddingInput {
  const t = clean(title ?? '').replace(/\s+/g, ' ').trim();
  const abstract = abstractOf(pageTexts);
  if (abstract !== null) return { text: t === '' ? abstract : `${t}. ${abstract}`, abstract, kind: 'abstract' };
  const opening = openingOf(pageTexts, t);
  if (opening !== '') return { text: t === '' ? opening : `${t}. ${opening}`, abstract: opening, kind: 'opening' };
  return { text: t, abstract: '', kind: 'title' };
}

/**
 * `text` without the words of the given names (the authors): they appear in the opening text of nearly every reading by the same people,
 * and would otherwise name a topic "Allen · Downey". Only words of 3 letters or more are taken out.
 */
export function withoutNames(text: string, names: readonly string[]): string {
  const words = new Set(
    names
      .join(' ')
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{M}]+/u)
      .filter((w) => w.length >= 3),
  );
  if (words.size === 0) return text;
  return text
    .split(/(\s+)/)
    .filter((part) => !words.has(part.normalize('NFKC').toLowerCase().replace(/^[^\p{L}]+|[^\p{L}\p{M}]+$/gu, '')))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The model the vectors are made with, and the length of its vectors. A vector of another model is made again. */
export const EMBEDDING_MODEL = 'minilm-l6-v2-int8';
export const EMBEDDING_DIM = 384;
