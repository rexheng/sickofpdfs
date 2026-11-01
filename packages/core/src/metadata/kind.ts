// A guess at what kind of document a PDF is (Phase 3, S4): a paper, a book, slides or something else. It is only a label
// for the library's "Type" filter, so it leans on the plainest signals: the shape of the pages, the number of pages, and a few
// words on page 1. Pure; it never throws.
import type { FilterPageSize } from '../filter/types';

export type DocumentKind = 'paper' | 'book' | 'slides' | 'other';

export interface KindInput {
  pageCount: number;
  /** The viewer's `PageSize[]` fits it. The first pages are enough. */
  pageSizes: readonly FilterPageSize[];
  firstPageText: string;
}

/** At most this many page shapes are looked at. */
const SHAPES_SEEN = 60;
/** Slides need a few pages, mostly landscape, in a slide-like shape (4:3 to 2:1). */
const SLIDES_MIN_PAGES = 3;
const SLIDES_LANDSCAPE_SHARE = 0.7;
const SLIDES_ASPECT_MIN = 1.25;
const SLIDES_ASPECT_MAX = 2.05;
/** Where a long document stops being a paper and starts being a book. */
const BOOK_PAGES = 150;
const BOOK_PAGES_WITHOUT_PAPER_CUES = 100;
const PAPER_MAX_PAGES = 250;

function slideShaped(sizes: readonly FilterPageSize[]): boolean {
  const seen = sizes.slice(0, SHAPES_SEEN);
  let landscape = 0;
  let aspectSum = 0;
  let counted = 0;
  for (const s of seen) {
    if (!s || !(s.width > 0) || !(s.height > 0)) continue;
    const swap = s.rotation === 90 || s.rotation === 270;
    const w = swap ? s.height : s.width;
    const h = swap ? s.width : s.height;
    counted += 1;
    if (w / h >= SLIDES_ASPECT_MIN) {
      landscape += 1;
      aspectSum += w / h;
    }
  }
  if (counted === 0 || landscape / counted < SLIDES_LANDSCAPE_SHARE) return false;
  const aspect = aspectSum / landscape;
  return aspect >= SLIDES_ASPECT_MIN && aspect <= SLIDES_ASPECT_MAX;
}

/** Words on page 1 that point to a journal article, a preprint or a working paper. Strong ones count 2. */
function paperScore(text: string): number {
  let score = 0;
  if (/\babstract\b/i.test(text)) score += 2;
  if (/\barxiv\s*:\s*\d|\barxiv\.org\b/i.test(text)) score += 2;
  if (/\b(?:working|discussion) paper\b|\btechnical report\b|\bresearch article\b|\boriginal article\b|\bproceedings of\b/i.test(text)) score += 2;
  if (/\bdoi\b\s*[:.]?|doi\.org\/|\b10\.\d{4,9}\/\S/i.test(text)) score += 1;
  if (/\bkey ?words?\b|\bindex terms\b|\bjel\b/i.test(text)) score += 1;
  if (/^citation:/im.test(text)) score += 1;
  if (/\b(?:received|accepted|published)\s*[:.]?\s*\d{1,2}\s+\p{L}+\s+\d{4}/iu.test(text)) score += 1;
  if (/\bet al\.?/i.test(text)) score += 0.5;
  return score;
}

/** Words on page 1 that point to a book, a textbook or a thesis. */
function bookScore(text: string): { score: number; thesis: boolean } {
  let score = 0;
  const thesis = /\b(?:thesis|dissertation)\b[\s\S]{0,200}\b(?:degree|requirements|doctor|submitted)\b|\bsubmitted in (?:partial )?(?:conformity|fulfil+ment)\b/i.test(text);
  if (/\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth)\s+edition\b|\bedition\b/i.test(text)) score += 2;
  if (/\bisbn\b/i.test(text)) score += 2;
  if (/^\s*(?:table of )?contents\s*$/im.test(text) || /^\s*preface\s*$/im.test(text)) score += 1;
  if (/\ball rights reserved\b/i.test(text)) score += 1;
  if (/\b(?:springer|wiley|elsevier|pearson|mcgraw|oxford university press|cambridge university press|mit press|o'reilly|apress|manning|crc press)\b/i.test(text)) score += 1;
  if (/\btextbook\b|\blecture notes\b|\bcourse notes\b|\ba first course\b/i.test(text)) score += 1;
  return { score, thesis };
}

/** `'slides'` for a landscape, slide-shaped file; `'paper'` for a short document with an abstract, an id or a working-paper line; `'book'` for a long one or one with an edition or ISBN; else `'other'`. */
export function guessKind(input: KindInput): DocumentKind {
  try {
    const text = typeof input.firstPageText === 'string' ? input.firstPageText.slice(0, 6000) : '';
    const pages = Number.isFinite(input.pageCount) ? input.pageCount : 0;
    const paper = paperScore(text);
    const book = bookScore(text);

    if (pages >= SLIDES_MIN_PAGES && slideShaped(Array.isArray(input.pageSizes) ? input.pageSizes : []) && paper < 4) return 'slides';
    if (book.thesis) return 'book';
    if (paper >= 2 && pages <= PAPER_MAX_PAGES && book.score < 4) return 'paper';
    if (book.score >= 2) return 'book';
    if (pages >= BOOK_PAGES) return 'book';
    if (pages >= BOOK_PAGES_WITHOUT_PAPER_CUES && paper < 2) return 'book';
    if (paper >= 1 && pages > 0 && pages <= 60) return 'paper';
    return 'other';
  } catch {
    return 'other';
  }
}
