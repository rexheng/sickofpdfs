// What was typed in the palette, and how a hit's snippet is shown. Pure functions: no store, no DOM.
import type { DocumentId } from '@sop/core';
import type { TextPart } from './types';

// ---- operators: the hook for `tag:` and `course:` (S18) ------------------------------------------------------------------------

/**
 * A word with a colon in front of it that narrows the search to some readings (`tag:economics`, `course:EC102`). S18
 * registers `tag` and `course` once readings have tags; until one is registered, such words are searched as plain words.
 */
export interface PaletteOperator {
  /** The word before the colon, lower case. */
  key: string;
  /** The readings the typed value lets through. The palette keeps only hits from these. */
  readings(value: string): Promise<ReadonlySet<DocumentId>>;
}

const operators = new Map<string, PaletteOperator>();

/** Makes `key:value` mean something in the palette. Returns the function that takes it away again. */
export function registerPaletteOperator(op: PaletteOperator): () => void {
  operators.set(op.key.toLowerCase(), op);
  return () => {
    if (operators.get(op.key.toLowerCase()) === op) operators.delete(op.key.toLowerCase());
  };
}

export interface ParsedQuery {
  /** The words to search for, with the operators taken out. */
  text: string;
  /** The operators that were typed, in order. */
  operators: { op: PaletteOperator; value: string }[];
}

/** `key:value` or `key:"two words"` at the start of the text or after a space. */
const OPERATOR = /(^|\s)([a-z]+):(?:"([^"]*)"|(\S+))/giu;

export function parseQuery(typed: string): ParsedQuery {
  const found: ParsedQuery['operators'] = [];
  const text = typed.replace(OPERATOR, (all: string, lead: string, key: string, quoted: string | undefined, bare: string | undefined) => {
    const op = operators.get(key.toLowerCase());
    const value = (quoted ?? bare ?? '').trim();
    if (op === undefined || value === '') return all;
    found.push({ op, value });
    return lead;
  });
  return { text: text.replace(/\s+/gu, ' ').trim(), operators: found };
}

// ---- words ------------------------------------------------------------------------------------------------------------------

/** The words of a search, for finding the first one on a page: no punctuation at the edges, no repeats. */
export function queryTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/u)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word !== '' && !out.some((w) => w.toLowerCase() === word.toLowerCase())) out.push(word);
  }
  return out;
}

// ---- snippets ---------------------------------------------------------------------------------------------------------------

/**
 * A snippet from the store, split at its `<b>` and `</b>` markers into plain and bold parts. This is the only place those
 * markers are read; the page text between them is data and is never treated as HTML. White space is folded to single
 * spaces, and two bold words with only a space between them become one bold run.
 */
export function splitMarked(snippet: string): TextPart[] {
  const parts: TextPart[] = [];
  let bold = false;
  for (const piece of snippet.split(/(<\/?b>)/u)) {
    if (piece === '<b>') bold = true;
    else if (piece === '</b>') bold = false;
    else if (piece !== '') parts.push({ text: piece.replace(/\s+/gu, ' '), bold });
  }
  const merged: TextPart[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const last = merged.at(-1);
    const next = parts[i + 1];
    if (last?.bold === part.bold) last.text += part.text;
    else if (!part.bold && part.text.trim() === '' && last?.bold === true && next?.bold === true) last.text += part.text; // "a b" in one run
    else merged.push({ ...part });
  }
  return merged;
}

/** The snippet's words with no markers. */
export function plainOf(snippet: string): string {
  return splitMarked(snippet)
    .map((p) => p.text)
    .join('')
    .trim();
}

/** Plain text as one part. */
export function plain(text: string): TextPart[] {
  return [{ text, bold: false }];
}

// ---- commands ---------------------------------------------------------------------------------------------------------------

/**
 * How well `label` answers the typed words: every word must be in it (anywhere, any case). Lower is better; null is no
 * match. A label that starts with the first word comes first, then one with a word that starts with it.
 */
export function matchScore(label: string, typed: string): number | null {
  const words = typed.toLowerCase().split(/\s+/u).filter((w) => w !== '');
  if (words.length === 0) return 0;
  const text = label.toLowerCase();
  if (!words.every((w) => text.includes(w))) return null;
  if (text.startsWith(words[0])) return 0;
  return text.split(/[\s/-]+/u).some((w) => w.startsWith(words[0])) ? 1 : 2;
}
