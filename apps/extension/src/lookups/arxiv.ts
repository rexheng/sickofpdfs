// arXiv's API (S12): the address to ask, and the title, authors and year out of its answer. Only the paper's id is ever sent.
//
// The address is `https://export.arxiv.org/api/query?id_list=<id>&max_results=1`. Nothing else goes with it: no title, no file name, no
// link, no cookie, no referrer (lookups/http.ts). arXiv asks for at most one call every 3 seconds (the queue keeps that).
import type { Found } from './fill';

export const ARXIV_HOST = 'export.arxiv.org';
/** arXiv's own rule: at most one call in this many ms. */
export const ARXIV_GAP_MS = 3000;

/** `1706.03762` (2007 on) or `hep-th/9901001` (before that). Anything else is not put in an address. */
const ID = /^(?:\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]{2})?\/\d{7})$/;

/** The id without a version ("1706.03762v7" is "1706.03762"), or null when it is not an arXiv id. */
export function arxivIdOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const id = raw.trim().replace(/v\d+$/i, '');
  return ID.test(id) ? id : null;
}

/** The address that asks about one paper, or null when `raw` is not an arXiv id. The id is made of letters, digits, dots, dashes and one slash. */
export function arxivUrl(raw: unknown): string | null {
  const id = arxivIdOf(raw);
  return id === null ? null : `https://${ARXIV_HOST}/api/query?id_list=${id}&max_results=1`;
}

const ATOM = 'http://www.w3.org/2005/Atom';

const child = (parent: Element, name: string): Element | undefined => Array.from(parent.children).find((c) => c.localName === name && c.namespaceURI === ATOM);

/**
 * The title, authors and year of the paper `raw` in arXiv's Atom answer. Null when arXiv has no such paper, answers with something else (an
 * error entry, a page from a network's sign-in), or the answer cannot be read. The entry must name the paper that was asked about.
 */
export function parseArxiv(xml: string, raw: string): Found | null {
  const want = arxivIdOf(raw);
  if (want === null || /<!(?:DOCTYPE|ENTITY)/i.test(xml)) return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  for (const entry of Array.from(doc.getElementsByTagNameNS(ATOM, 'entry'))) {
    const named = /\/abs\/(.+?)(?:v\d+)?$/.exec((child(entry, 'id')?.textContent ?? '').trim());
    if (named === null || named[1]?.toLowerCase() !== want.toLowerCase()) continue;
    const authors = Array.from(entry.children)
      .filter((c) => c.localName === 'author' && c.namespaceURI === ATOM)
      .map((a) => child(a, 'name')?.textContent ?? '');
    const published = /^(\d{4})-/.exec((child(entry, 'published')?.textContent ?? '').trim());
    return { title: child(entry, 'title')?.textContent ?? null, authors, year: published === null ? null : Number(published[1]) };
  }
  return null;
}
