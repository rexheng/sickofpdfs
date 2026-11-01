// Which pages the viewer reads for the filter, and when it looks at more of them. The pages are chosen from the page
// count alone, so this file touches no text and no engine.
//
// The sample is the first 5 and the last 5 pages. A slide deck can have almost no text there (title slides, image
// slides), which looks the same as a scan. So when those 10 pages hold fewer than NO_TEXT_WORDS words, the sampler
// takes a second look: up to 10 more pages spread evenly through the middle, appended AFTER the first 10. Only then is
// the PDF treated as having no text. An image-only receipt or scan has no middle pages with text either, so it is
// still skipped.

import { countWords, NO_TEXT_WORDS } from './signals';

/** Pages read at each end of the document. */
export const EDGE_PAGES = 5;
/** Extra pages read in the second look. */
export const SECOND_LOOK_PAGES = 10;

/** Zero-based page numbers of the first and last 5 pages, in reading order, without repeats. */
export function sampleIndexes(pageCount: number): number[] {
  const n = Math.max(0, Math.floor(pageCount));
  if (n <= 2 * EDGE_PAGES) return Array.from({ length: n }, (_, i) => i);
  return [...Array.from({ length: EDGE_PAGES }, (_, i) => i), ...Array.from({ length: EDGE_PAGES }, (_, i) => n - EDGE_PAGES + i)];
}

/**
 * Zero-based page numbers for the second look: up to SECOND_LOOK_PAGES pages, evenly spaced strictly between the first 5
 * and the last 5. Empty when the document has 10 pages or fewer.
 */
export function secondLookIndexes(pageCount: number): number[] {
  const n = Math.max(0, Math.floor(pageCount));
  const first = EDGE_PAGES;
  const last = n - EDGE_PAGES - 1;
  if (last < first) return [];
  const span = last - first + 1;
  const count = Math.min(SECOND_LOOK_PAGES, span);
  return Array.from({ length: count }, (_, i) => first + Math.floor(((i + 0.5) * span) / count));
}

/** True when the pages read so far hold too little text to judge, so the sampler should take the second look. */
export function needsSecondLook(sampleText: readonly string[]): boolean {
  return countWords(sampleText.join('\n')) < NO_TEXT_WORDS;
}
