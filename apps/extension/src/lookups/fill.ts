// What an online lookup may put in the library (S12). An answer from arXiv or Crossref is untrusted text, so it is cleaned first: control
// characters out, one space between words, sane lengths, a year that can be a year. Then only what the reading lacks is kept: the title if
// it has none, the authors if it has none, the year if it has none. Nothing that is there is ever replaced.
//
// The store checks the same rule again inside its transaction (store/lookups-api.ts), so a title the owner types while a lookup is on its way
// is not replaced either.
import type { LookupFill, LookupItem } from '../store/lookups-api';

/** What a source found. A field it did not find is null (or an empty list). */
export interface Found {
  title: string | null;
  authors: string[];
  year: number | null;
}

const MAX_TITLE = 300;
const MAX_AUTHORS = 100;
const MAX_AUTHOR = 120;
const FIRST_YEAR = 1900;

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/** Text as it is shown: no control or direction-changing characters, one space between words. Null when nothing is left or it is too long. */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return text === '' || [...text].length > max ? null : text;
}

/** A year between 1900 and next year, or null. */
export function cleanYear(raw: unknown, now: number): number | null {
  const year = typeof raw === 'number' ? raw : Number.NaN;
  return Number.isInteger(year) && year >= FIRST_YEAR && year <= new Date(now).getUTCFullYear() + 1 ? year : null;
}

/** An answer made safe to store: clean text, no repeated names, at most 100 authors. */
export function cleanFound(found: Found, now: number): Found {
  const authors: string[] = [];
  for (const raw of found.authors) {
    const name = cleanText(raw, MAX_AUTHOR);
    if (name !== null && !authors.includes(name)) authors.push(name);
    if (authors.length === MAX_AUTHORS) break;
  }
  return { title: cleanText(found.title, MAX_TITLE), authors, year: cleanYear(found.year, now) };
}

/** Which of title, authors and year the reading lacks. */
export function lacks(item: Pick<LookupItem, 'title' | 'authors' | 'year'>): { title: boolean; authors: boolean; year: boolean } {
  return { title: item.title === null || item.title.trim() === '', authors: item.authors.length === 0, year: item.year === null };
}

/** The part of a clean answer that fills a gap in the reading, or null when it fills none. */
export function fillFor(item: LookupItem, found: Found): LookupFill | null {
  const need = lacks(item);
  const fill: LookupFill = {};
  if (need.title && found.title !== null) fill.title = found.title;
  if (need.authors && found.authors.length > 0) fill.authors = found.authors;
  if (need.year && found.year !== null) fill.year = found.year;
  return Object.keys(fill).length > 0 ? fill : null;
}
