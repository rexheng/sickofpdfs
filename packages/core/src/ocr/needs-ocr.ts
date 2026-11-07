// Which pages are read by the text recogniser: a scanned page, and nothing else. A page with its own text (PDFium's, visible
// or not: a scanner's invisible OCR layer counts as text) is left alone, as Chrome leaves it. Pure.
import type { OcrPageKind } from './types';

/** A page with this many words of its own text or more is a text page. */
export const OCR_MAX_WORDS = 15;
/** The page's pictures cover at least this share of it (a photographed receipt on a Letter page covers about 40%). */
export const OCR_MIN_IMAGE_COVERAGE = 0.25;
/** Chars a word has, on average, to estimate words from chars when the caller did not count them. */
const CHARS_PER_WORD = 5;

/** Fewer than 15 words of text and a big picture, and no invisible text layer of its own. */
export function needsOcr(k: OcrPageKind): boolean {
  if (k.hasInvisibleText) return false;
  const words = k.textWords ?? Math.ceil(k.textChars / CHARS_PER_WORD);
  return words < OCR_MAX_WORDS && k.imageCoverage >= OCR_MIN_IMAGE_COVERAGE;
}

/** Words of a page's own text: runs of letters or digits. */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}
