// R97: the text fingerprint of a PDF, so "Never save this file" still holds for a re-download whose bytes differ (a new
// download stamp, a few bytes added at the end). It is the SHA-256 of the normalised text of the first pages: the stamp
// lines, IP addresses, dates and times removed (`stripStamps`, the alias rule's own cleaning), then only the letters and
// digits kept, lower-cased, with accents split off. The page count goes in too, as the alias rule asks (R59 a).
//
// Privacy: the result is a hash, made in memory. The caller never stores it as it is: the never-save list keeps only a
// salted HMAC of it (local-only/secrets-store.ts), the same as for a file's fingerprint. The text itself is never kept.
//
// A PDF with too little text (a scan, a one-line form) has no text fingerprint: with almost no letters, unrelated files
// would look the same. The same floor as the alias rule.
import type { Sha256 } from '../ids';
import { sha256Hex } from './fingerprint';
import { MIN_ALIAS_CHARS, MIN_ALIAS_CHARS_PER_PAGE, stripStamps } from './stamps';

/** How many of the first pages the text fingerprint reads. The title, authors and abstract are on them. */
export const TEXT_FINGERPRINT_PAGES = 3;

/** A version tag in the hashed text, so a later change of the rule never matches an old fingerprint by accident. */
const TAG = 'sop-text-fingerprint-v1';

const lettersAndDigits = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();

/**
 * The text fingerprint of a PDF with `pageCount` pages, from the text of its first pages (`firstPages`, at most
 * TEXT_FINGERPRINT_PAGES are read). Null when there is too little text to tell PDFs apart.
 */
export async function textFingerprint(pageCount: number, firstPages: readonly string[]): Promise<Sha256 | null> {
  const pages = firstPages.slice(0, TEXT_FINGERPRINT_PAGES).map((t) => lettersAndDigits(stripStamps(t)));
  if (pages.length === 0) return null;
  const letters = pages.reduce((n, p) => n + p.length, 0);
  if (letters < MIN_ALIAS_CHARS || letters < MIN_ALIAS_CHARS_PER_PAGE * pages.length) return null;
  return sha256Hex(`${TAG}\n${pageCount}\n${pages.join('\n')}`);
}
