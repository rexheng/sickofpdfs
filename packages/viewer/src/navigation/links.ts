// Links inside a PDF: which ones may open anything, and each page's links, read once from the engine.
//
// Security: a PDF is untrusted. A web link opens only when its address parses to http:, https: or mailto:. Every
// other scheme (javascript:, data:, file:, chrome:, blob:, …) is inert: the link is not drawn at all. The address
// that is checked is the parsed URL's own href, and that exact string is what the link opens, so tabs, newlines or
// odd casing cannot slip a scheme past the check.
import type { DocHandle, PdfBackend, PdfLink } from '../backend/types';

const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

/** The href a web link opens, or null when it must do nothing: only absolute http:, https: and mailto: addresses. */
export function safeLinkHref(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (!OPENABLE.has(url.protocol)) return null;
  // A scheme alone ("https://") goes nowhere.
  if (url.protocol !== 'mailto:' && url.hostname === '') return null;
  return url.href;
}

/**
 * The address a URI action in a PDF names, made absolute the way Chrome's viewer does it, then checked by
 * safeLinkHref. A URI without a scheme is a guess:
 * - a path ("/a", "./a", "a/b.pdf", "foo.com/x": fewer than two dots before the first slash) is relative to the PDF's
 *   own address, when that is a web address (a local file's relative links would be file: links, which stay inert);
 * - "www.example.org/x" (two or more dots) is a web address: http:// is added, as Chrome's viewer does.
 */
export function resolveLinkUri(uri: string, pdfUrl: string | null): string | null {
  const raw = uri.trim();
  if (raw === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) return safeLinkHref(raw);
  const base = webBase(pdfUrl);
  const host = raw.split('/')[0];
  const relative = raw.startsWith('/') || raw.startsWith('.') || raw.startsWith('\\') || (host.match(/\./gu)?.length ?? 0) < 2;
  if (relative) {
    if (base === null) return null;
    try {
      return safeLinkHref(new URL(raw, base).href);
    } catch {
      return null;
    }
  }
  return safeLinkHref(`http://${raw}`);
}

function webBase(pdfUrl: string | null): string | null {
  if (pdfUrl === null) return null;
  try {
    const u = new URL(pdfUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Each page's links, read from the engine once per page and kept for the document. */
export interface PageLinkSource {
  /** The page's links if they have been read already. */
  cached(pageIndex: number): PdfLink[] | null;
  /** The page's links: page jumps, and web links that may open (made absolute). Never rejects; a failure gives []. */
  get(pageIndex: number): Promise<PdfLink[]>;
}

/**
 * Reads links with backend.getLinks. Web links are resolved against the PDF's address (`pdfUrl`, null for a file picked
 * from disk) and dropped when they may not open, so the page never holds an inert link.
 */
export function createPageLinkSource(backend: Pick<PdfBackend, 'getLinks'>, doc: DocHandle, pdfUrl: string | null): PageLinkSource {
  const done = new Map<number, PdfLink[]>();
  const pending = new Map<number, Promise<PdfLink[]>>();
  return {
    cached: (i) => done.get(i) ?? null,
    get(i) {
      const ready = done.get(i);
      if (ready) return Promise.resolve(ready);
      let p = pending.get(i);
      if (!p) {
        p = backend.getLinks(doc, i).then(
          (links) => {
            const usable = links.flatMap((l): PdfLink[] => {
              if (l.target.kind === 'page') return [l];
              const url = resolveLinkUri(l.target.url, pdfUrl);
              return url === null ? [] : [{ rect: l.rect, target: { kind: 'url', url } }];
            });
            done.set(i, usable);
            pending.delete(i);
            return usable;
          },
          () => {
            pending.delete(i); // asked again the next time the page is shown
            return [];
          },
        );
        pending.set(i, p);
      }
      return p;
    },
  };
}
