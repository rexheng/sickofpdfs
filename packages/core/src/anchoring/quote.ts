// Turning a selection into a text anchor: the quote with its 32-char context (the W3C TextQuoteSelector), the page
// positions (the TextPositionSelector) and the rects it was drawn with. Pure: the caller reads the page texts.
import type { Anchor, CharPos, NormRect } from '../model/anchor';
import { isIgnorable, stripIgnorable } from './text-fold';

/** How many chars of context a quote keeps on each side (the anchor's prefix and suffix). */
export const QUOTE_CONTEXT = 32;

type TextAnchor = Extract<Anchor, { kind: 'text' }>;

/**
 * Builds the text anchor for the range `start` to `end` (exclusive).
 *
 * - `text(pageIndex)` must be index-aligned: char `i` of the string is PDFium char `i` of the page. That is
 *   PageTextProvider.rawText, not getPageText, which drops the chars PDFium uses for joined line-end hyphens and so
 *   shifts every offset after one.
 * - The quote is the text from `start` to `end`, exactly as it is on the page, except that the marks that are not text
 *   are left out. A quote across pages joins the page texts with '\n'.
 * - `prefix` and `suffix` are up to QUOTE_CONTEXT chars of text before `start` and after `end`, on the same page.
 * - `rects` are stored as given. `textSource` is only written when it is given.
 */
export function buildTextAnchor(i: {
  text(pageIndex: number): string;
  start: CharPos;
  end: CharPos;
  rects: { page: number; rects: NormRect[] }[];
  textSource?: string;
}): TextAnchor {
  let { start, end } = i;
  if (end.page < start.page || (end.page === start.page && end.index < start.index)) [start, end] = [end, start];

  const pieces: string[] = [];
  for (let page = start.page; page <= end.page; page++) {
    const text = i.text(page);
    const from = page === start.page ? clamp(start.index, text.length) : 0;
    const to = page === end.page ? clamp(end.index, text.length) : text.length;
    pieces.push(stripIgnorable(text.slice(from, Math.max(from, to))));
  }

  const startText = i.text(start.page);
  const endText = i.text(end.page);
  const anchor: TextAnchor = {
    kind: 'text',
    quote: {
      quote: pieces.join('\n'),
      prefix: contextBefore(startText, clamp(start.index, startText.length)),
      suffix: contextAfter(endText, clamp(end.index, endText.length)),
    },
    start: { page: start.page, index: start.index },
    end: { page: end.page, index: end.index },
    rects: i.rects.map((r) => ({ page: r.page, rects: r.rects.map((n): NormRect => [n[0], n[1], n[2], n[3]]) })),
  };
  if (i.textSource !== undefined) anchor.textSource = i.textSource;
  return anchor;
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(length, index));
}

/** Up to QUOTE_CONTEXT text chars (marks that are not text do not count) that end just before `index`. */
function contextBefore(text: string, index: number): string {
  let out = '';
  for (let k = index - 1; k >= 0 && out.length < QUOTE_CONTEXT; k--) if (!isIgnorable(text[k])) out = text[k] + out;
  return out;
}

/** Up to QUOTE_CONTEXT text chars that start at `index`. */
function contextAfter(text: string, index: number): string {
  let out = '';
  for (let k = index; k < text.length && out.length < QUOTE_CONTEXT; k++) if (!isIgnorable(text[k])) out += text[k];
  return out;
}
