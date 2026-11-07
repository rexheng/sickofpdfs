// A recognised page as PDFium-style glyphs (contracts §9: ocrToPageGlyphs), so the text layer, selection painting, marks and
// anchoring treat a scan like a text page with no change of their own.
//
// The char model is PDFium's:
// - Each letter is one glyph. A word's box is split across its letters by Noto Sans advance widths (char-widths.ts), the
//   font the text layer measures with, so a word stays in one span and each letter sits over its own ink.
// - Words on one line are joined by a generated space; lines by a generated '\r\n', as FPDFText_GetText writes them.
// - A word broken at the end of a line ("illus-" + "trated") is joined the way PDFium joins one: the hyphen glyph becomes
//   U+FFFE and no line break follows, so the page text reads "illustrated" and Find finds it whole.
// - glyphs.length === text.length, and glyphs[i].text === text[i].
//
// Pure: no DOM, no engine.
import type { Glyph, PageGlyphs, PdfRect, Rotation } from '../../../viewer/src/backend/types';
import { charAdvance, NOTO_ASCENT, NOTO_DESCENT } from './char-widths';
import type { OcrPageResult, OcrWord } from './types';

/** PDFium's mark for a line-end hyphen it joins across the break (getPageText drops it). */
export const JOINED_HYPHEN = '￾';

const NO_BOX: PdfRect = { x: 0, y: 0, width: 0, height: 0 };
/** A line that ends in one of these, before a line that starts with a lower-case letter, is a word broken across two lines. */
const LINE_END_HYPHENS = new Set(['-', '­', '‐', '¬']);

/** The text direction of a page's upright text in unrotated space, clockwise (Glyph.angle): 0 for an unrotated page. */
export const ocrAngle = (rotation: Rotation = 0): number => (360 - rotation) % 360;

interface Laid {
  text: string;
  glyphs: Glyph[];
  /** [start, end) of each line's chars (words and the spaces between them; not the break after it). */
  lines: { start: number; end: number }[];
}

const cache = new WeakMap<readonly OcrWord[], Map<number, Laid>>();

/** Splits `box` along the text direction into pieces proportional to `weights`. */
function splitBox(box: PdfRect, weights: readonly number[], angle: number): PdfRect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const horizontal = angle === 0 || angle === 180;
  const forward = angle === 0 || angle === 90; // û points +x (0) or +y (90)
  const length = horizontal ? box.width : box.height;
  const out: PdfRect[] = [];
  let at = 0;
  for (const w of weights) {
    const a = (at / total) * length;
    const b = ((at + w) / total) * length;
    at += w;
    const lo = forward ? a : length - b;
    const size = b - a;
    out.push(horizontal ? { x: box.x + lo, y: box.y, width: size, height: box.height } : { x: box.x, y: box.y + lo, width: box.width, height: size });
  }
  return out;
}

/** The letters of a word as code points (an astral char is one entry; it becomes two glyphs, as in PDFium). */
const codePoints = (s: string): string[] => Array.from(s);

function lay(words: readonly OcrWord[], rotation: Rotation): Laid {
  let byRotation = cache.get(words);
  const hit = byRotation?.get(rotation);
  if (hit) return hit;
  const angle = ocrAngle(rotation);
  const across = (b: PdfRect) => (angle === 0 || angle === 180 ? b.height : b.width);
  const glyphs: Glyph[] = [];
  const lines: Laid['lines'] = [];
  const push = (text: string, box: PdfRect, fontSize: number, generated: boolean) => {
    glyphs.push({ index: glyphs.length, text, box, tight: box, fontSize, angle, generated });
  };

  // Words grouped into their lines, in the order given (the engine's reading order).
  const grouped: OcrWord[][] = [];
  for (const w of words) {
    if (codePoints(w.text.trim()).length === 0) continue;
    const last = grouped[grouped.length - 1];
    if (last && last[0].line === w.line) last.push(w);
    else grouped.push([w]);
  }

  grouped.forEach((line, li) => {
    const start = glyphs.length;
    line.forEach((w, wi) => {
      const letters = codePoints(w.text.trim());
      const fontSize = across(w.box) / (NOTO_ASCENT - NOTO_DESCENT);
      if (wi > 0) push(' ', NO_BOX, fontSize, true);
      const boxes = splitBox(w.box, letters.map(charAdvance), angle);
      const lastWordOfLine = wi === line.length - 1;
      const nextLine = grouped[li + 1];
      const nextStartsLower = nextLine !== undefined && /^\p{Ll}/u.test(nextLine[0].text.trim());
      letters.forEach((ch, k) => {
        const joined = lastWordOfLine && k === letters.length - 1 && letters.length >= 3 && LINE_END_HYPHENS.has(ch) && nextStartsLower;
        const text = joined ? JOINED_HYPHEN : ch;
        // An astral char is two UTF-16 units: two glyphs that share its box, as PDFium has them.
        for (const unit of text.length > 1 ? [text[0], text[1]] : [text]) push(unit, boxes[k], fontSize, false);
      });
    });
    lines.push({ start, end: glyphs.length });
    const endsJoined = glyphs[glyphs.length - 1]?.text === JOINED_HYPHEN;
    if (li < grouped.length - 1 && !endsJoined) {
      const size = glyphs[glyphs.length - 1]?.fontSize ?? 0;
      push('\r', NO_BOX, size, true);
      push('\n', NO_BOX, size, true);
    }
  });

  const laid: Laid = { text: glyphs.map((g) => g.text).join(''), glyphs, lines };
  if (!byRotation) cache.set(words, (byRotation = new Map<number, Laid>()));
  byRotation.set(rotation, laid);
  return laid;
}

/** The page's chars for these words (OcrPageResult.text): what `ocrToPageGlyphs` numbers its glyphs by. */
export function ocrText(words: readonly OcrWord[], rotation: Rotation = 0): string {
  return lay(words, rotation).text;
}

/** The page's text as getPageText would give it: `text` without U+FFFE. What page_text stores, and Find and Claude read. */
export function ocrPlainText(text: string): string {
  return text.replaceAll(JOINED_HYPHEN, '');
}

/**
 * The recognised page as glyphs: one per char of `r.text` (contracts §9). `rotation` is the page's /Rotate: a scan shown
 * turned has its words upright as displayed, which in unrotated page space runs at `ocrAngle(rotation)`.
 */
export function ocrToPageGlyphs(r: OcrPageResult, o: { rotation?: Rotation } = {}): PageGlyphs {
  const laid = lay(r.words, o.rotation ?? 0);
  return { pageIndex: r.pageIndex, glyphs: laid.glyphs, runs: laid.lines.map((l) => ({ start: l.start, end: l.end })) };
}

/** The [start, end) char ranges of each line of the page (for the line rects). */
export function ocrLines(r: OcrPageResult, rotation: Rotation = 0): readonly { start: number; end: number }[] {
  return lay(r.words, rotation).lines;
}
