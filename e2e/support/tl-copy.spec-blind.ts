// Spec-blind helpers for Task 22 (copy, R26). Pure code, no browser.
//
// R26: copy is judged against PDFium's own text for the range. "Join a break when the next glyph continues the same
// baseline/word": a line break that PDFium inserted inside a line (around a superscript, between rotated glyphs) must
// not survive into the copied text, and a real line break must not be glued together.
import type { Glyph } from '../../packages/viewer/src/backend/types';

/** Chars PDFium's page text leaves out (written as escapes: U+FFFE hyphen join, U+FFFF, soft hyphen, ZWSP, word joiner, BOM). */
export const INVISIBLE = new Set(['\uFFFE', '\uFFFF', '\u00AD', '\u200B', '\u2060', '\uFEFF']);

export type Sep = 'none' | 'space' | 'break';

interface Vis {
  ch: string;
  /** What lay between the previous visible char and this one. */
  sep: Sep;
  glyph?: Glyph;
}

const isBreak = (s: string) => /[\r\n\u2028\u2029]/.test(s);

/** The visible chars of glyphs [start, end), NFKC-folded (ligatures and the like), with what separated them. */
export function engineChars(glyphs: Glyph[], start: number, end: number): Vis[] {
  const out: Vis[] = [];
  let pending = 'none' as Sep;
  for (let i = start; i < end; i++) {
    const g = glyphs[i];
    let text = g.text;
    // An astral char (a maths italic x) is two glyphs that share a box: fold the pair as one char, owned by the first glyph.
    if (/^[\uD800-\uDBFF]$/u.test(text) && i + 1 < end && /^[\uDC00-\uDFFF]$/u.test(glyphs[i + 1].text)) {
      text += glyphs[i + 1].text;
      i++;
    }
    if (INVISIBLE.has(text)) continue;
    if (/^\s$/u.test(text)) {
      pending = isBreak(text) || pending === 'break' ? 'break' : 'space';
      continue;
    }
    for (const unit of text.normalize('NFKC').split('')) {
      out.push({ ch: unit, sep: out.length === 0 ? 'none' : pending, glyph: g });
      pending = 'none';
    }
  }
  return out;
}

/** The same for copied text. */
export function copiedChars(text: string): Vis[] {
  const out: Vis[] = [];
  let pending = 'none' as Sep;
  for (const unit of text.normalize('NFKC').split('')) {
    if (INVISIBLE.has(unit) || unit === '\u0000') continue;
    if (/^\s$/u.test(unit)) {
      pending = isBreak(unit) || pending === 'break' ? 'break' : 'space';
      continue;
    }
    out.push({ ch: unit, sep: out.length === 0 ? 'none' : pending });
    pending = 'none';
  }
  return out;
}

/** The text with all whitespace removed (and NFKC folded): what must be equal whatever the line breaks. */
export const squash = (s: string) => s.normalize('NFKC').replaceAll('\u0000', '').replace(/[\s\uFFFE\uFFFF\u00AD\u200B\u2060\uFEFF]+/gu, '');

/** Whitespace collapsed to single spaces, NFKC folded (the P0-4 comparison). */
export const collapse = (s: string) => s.normalize('NFKC').replaceAll('\u0000', '').replace(/[\uFFFE\uFFFF\u00AD\u200B\u2060\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim();

const centre = (g: Glyph) => ({ x: g.box.x + g.box.width / 2, y: g.box.y + g.box.height / 2 });

/**
 * How two glyphs on either side of a PDFium line break sit. `along` is the distance travelled in the text's own direction,
 * `across` the distance sideways to it, both in points. Directions come from the glyph's angle (clockwise as displayed).
 */
export function lineRelation(prev: Glyph, next: Glyph): { along: number; across: number; size: number } {
  const theta = (prev.angle * Math.PI) / 180;
  const d = { x: Math.cos(theta), y: Math.sin(theta) };
  const n = { x: -Math.sin(theta), y: Math.cos(theta) };
  const a = centre(prev);
  const b = centre(next);
  const delta = { x: b.x - a.x, y: b.y - a.y };
  return { along: delta.x * d.x + delta.y * d.y, across: delta.x * n.x + delta.y * n.y, size: Math.max(prev.fontSize, next.fontSize) };
}

/** 'join': the next glyph clearly continues the same line, so a break is wrong. 'keep': clearly a new line. 'free': either is fair. */
export function breakVerdict(prev: Glyph, next: Glyph, o: { rtl?: boolean } = {}): 'join' | 'keep' | 'free' {
  const r = lineRelation(prev, next);
  if (Math.abs(r.across) > 0.9 * r.size) return 'keep';
  if (!o.rtl && r.along < -2 * r.size) return 'keep';
  if (Math.abs(r.across) < 0.45 * r.size && (o.rtl ? true : r.along > -0.5 * r.size)) return 'join';
  return 'free';
}

/**
 * What is wrong with `copied` as the copy of glyphs [start, end) (empty when nothing). Rules:
 *  1. The same letters in the same order as the engine's text (ligatures folded, whitespace ignored).
 *  2. No space or break the engine did not have, and none missing, apart from the line breaks below.
 *  3. A PDFium line break where the next glyph continues the same line or word is joined (no break in the copy).
 *  4. A PDFium line break between two real lines is kept as a break.
 */
export function copyProblems(glyphs: Glyph[], start: number, end: number, copied: string, o: { rtl?: boolean } = {}): string[] {
  const e = engineChars(glyphs, start, end);
  const c = copiedChars(copied);
  const es = e.map((v) => v.ch).join('');
  const cs = c.map((v) => v.ch).join('');
  if (es !== cs) {
    let i = 0;
    while (i < es.length && i < cs.length && es[i] === cs[i]) i++;
    return [`the copied letters differ from the engine's text at letter ${i}: engine "${es.slice(Math.max(0, i - 15), i + 15)}" vs copy "${cs.slice(Math.max(0, i - 15), i + 15)}" (${es.length} vs ${cs.length} letters)`];
  }
  const problems: string[] = [];
  const context = (k: number) => `"${es.slice(Math.max(0, k - 12), k)}|${es.slice(k, k + 12)}"`;
  for (let k = 1; k < e.length; k++) {
    const want = e[k].sep;
    const got = c[k].sep;
    if (want !== 'break') {
      if (got !== want) problems.push(`at ${context(k)}: the engine has ${want === 'none' ? 'no gap' : 'a space'} but the copy has ${got === 'none' ? 'no gap' : got === 'space' ? 'a space' : 'a line break'}`);
      continue;
    }
    const verdict = breakVerdict(e[k - 1].glyph!, e[k].glyph!, o);
    if (verdict === 'join' && got === 'break') problems.push(`at ${context(k)}: a line break was left inside a line (the next glyph continues the same line)`);
    if (verdict === 'keep' && got !== 'break') problems.push(`at ${context(k)}: a real line break was lost (${got === 'none' ? 'the words are glued together' : 'turned into a space'})`);
  }
  return problems;
}
