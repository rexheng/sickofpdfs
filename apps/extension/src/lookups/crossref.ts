// Crossref's API (S12): the address to ask, and the title, authors and year out of its answer. Only the paper's DOI is ever sent.
//
// The address is `https://api.crossref.org/works/<doi>`. Nothing else goes with it: no title, no file name, no link, no cookie, no referrer,
// and no e-mail address for Crossref's "polite" pool (lookups/http.ts).
import type { Found } from './fill';

export const CROSSREF_HOST = 'api.crossref.org';
/** A pause between two calls. Crossref's public pool allows 5 calls a second, one at a time. */
export const CROSSREF_GAP_MS = 1000;

/** `10.1371/journal.pone.0000308`: the prefix, a slash and a suffix with no spaces or control characters. */
// eslint-disable-next-line no-control-regex
const DOI = /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]{1,190}$/;

export const isDoi = (raw: unknown): raw is string => typeof raw === 'string' && DOI.test(raw);

/** The address that asks about one DOI, or null when `raw` is not a DOI. The whole DOI is percent-encoded, so nothing in it can change the address. */
export function crossrefUrl(raw: unknown): string | null {
  return isDoi(raw) ? `https://${CROSSREF_HOST}/works/${encodeURIComponent(raw)}` : null;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Crossref titles carry markup (`<i>`, `<sub>`) and entities (`&amp;`). This is the plain text of one. */
function plain(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return Object.hasOwn(NAMED, name.toLowerCase()) ? (NAMED[name.toLowerCase()] ?? whole) : whole;
      const code = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    });
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/** The year of a Crossref date (`{ "date-parts": [[2007, 3, 21]] }`), or null. */
function yearOf(date: unknown): number | null {
  if (!isRecord(date) || !Array.isArray(date['date-parts'])) return null;
  const first: unknown = date['date-parts'][0];
  return Array.isArray(first) && typeof first[0] === 'number' ? first[0] : null;
}

/**
 * The title, authors and year of the work `doi` in Crossref's answer. Null when Crossref says no, answers with something else, or the answer
 * cannot be read. The answer must name the DOI that was asked about.
 */
export function parseCrossref(body: string, doi: string): Found | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(root) || root.status !== 'ok' || !isRecord(root.message)) return null;
  const work = root.message;
  if (str(work.DOI)?.toLowerCase() !== doi.toLowerCase()) return null;

  const title = Array.isArray(work.title) ? str(work.title[0]) : null;
  const authors: string[] = [];
  if (Array.isArray(work.author)) {
    for (const a of work.author as unknown[]) {
      if (!isRecord(a)) continue;
      const name = [str(a.given), str(a.family)].filter((p): p is string => p !== null && p.trim() !== '').join(' ');
      const org = str(a.name);
      const shown = name !== '' ? name : org;
      if (shown !== null) authors.push(plain(shown));
    }
  }
  const year = yearOf(work.issued) ?? yearOf(work['published-online']) ?? yearOf(work['published-print']) ?? yearOf(work.created);
  return { title: title === null ? null : plain(title), authors, year };
}
