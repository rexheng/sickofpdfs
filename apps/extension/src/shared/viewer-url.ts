/** What a viewer address says: the PDF to open, the page to return to, and the page to show first. */
export interface ViewerParams {
  /** The PDF's address (http, https, file, ...). */
  source: string | null;
  /** The page the PDF was opened from, for "Back to page". */
  back: string | null;
  /** 1-based page to scroll to. */
  page: number | null;
  /**
   * The file's own name, for a PDF the library opened from the owner's disk (ruling R76): its `blob:` link has no name.
   * Only shown, and only for a `blob:` link of this extension (`pickedFileName` in the viewer); absent otherwise.
   */
  name?: string | null;
}

/** The viewer page, relative to the extension root. */
export const VIEWER_PATH = 'viewer.html';

/** The query chrome.declarativeNetRequest builds: everything after `DNR:` is the source, as written. */
const DNR_PREFIX = 'DNR:';

function decode(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null; // a stray "%" in a hand-typed address
  }
}

/**
 * Reads a viewer address in either form:
 * - `viewer.html?DNR:<raw url>`, which is what the takeover rules redirect to;
 * - `viewer.html?file=<enc>[&back=<enc>][&name=<enc>]`, which is what `buildViewerUrl` writes.
 * `#page=N` (a PDF "open parameter") sets the page in both. Anything missing or malformed reads as null.
 */
export function parseViewerUrl(href: string): ViewerParams {
  const hashAt = href.indexOf('#');
  const hash = hashAt < 0 ? '' : href.slice(hashAt + 1);
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const query = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1);

  const pageText = /(?:^|&)page=(\d+)(?:&|$)/.exec(hash)?.[1];
  const page = pageText !== undefined && Number(pageText) >= 1 ? Number(pageText) : null;

  if (query.startsWith(DNR_PREFIX)) return { source: query.slice(DNR_PREFIX.length) || null, back: null, page };

  const fields = new Map<string, string>();
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0 && !fields.has(part.slice(0, eq))) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const name = decode(fields.get('name'));
  return { source: decode(fields.get('file')), back: decode(fields.get('back')), page, ...(name !== null ? { name } : {}) };
}

/**
 * The viewer address for `p`: `<base>?file=<enc>[&back=<enc>][#page=N]`. `base` defaults to this extension's
 * viewer page; Node callers (tests) pass their own.
 */
export function buildViewerUrl(p: ViewerParams, base: string = chrome.runtime.getURL(VIEWER_PATH)): string {
  const query = [
    p.source !== null && `file=${encodeURIComponent(p.source)}`,
    p.back !== null && `back=${encodeURIComponent(p.back)}`,
    typeof p.name === 'string' && p.name !== '' && `name=${encodeURIComponent(p.name)}`,
  ].filter(Boolean);
  return `${base}${query.length > 0 ? `?${query.join('&')}` : ''}${p.page !== null ? `#page=${p.page}` : ''}`;
}

/**
 * The refusal marker (`&refused=1`): the viewer writes it into its own address (history.replaceState) when the service
 * worker says this tab was not seen opening the PDF. The address is what Chrome keeps in the tab's history, so a
 * reload, Back, Duplicate tab, Reopen closed tab and a browser restart's session restore all carry the refusal with
 * them, even after chrome.storage.session is gone. A web page cannot remove it: it cannot touch the viewer's page or
 * its history entry, and any address it opens itself is refused (and marked) anyway.
 */
const REFUSED_FIELD = 'refused=1';

/** Does this viewer address carry the refusal marker? (Never in the `DNR:` form, which `withRefusal` rewrites.) */
export function isMarkedRefused(href: string): boolean {
  const hashAt = href.indexOf('#');
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const query = queryAt < 0 ? '' : beforeHash.slice(queryAt + 1);
  return !query.startsWith(DNR_PREFIX) && query.split('&').includes(REFUSED_FIELD);
}

/**
 * The viewer address `href` with the refusal marker on (`refused` true) or off, the rest kept: the PDF, the page to go
 * back to and the fragment. A `DNR:` address is rewritten to the `file=` form first, since everything after `DNR:` is
 * the PDF's own address.
 */
export function withRefusal(href: string, refused: boolean): string {
  const hashAt = href.indexOf('#');
  const fragment = hashAt < 0 ? '' : href.slice(hashAt);
  const queryAt = href.search(/[?#]/);
  const base = queryAt < 0 ? href : href.slice(0, queryAt);
  const p = parseViewerUrl(href);
  const plain = buildViewerUrl({ source: p.source, back: p.back, page: null, name: p.name ?? null }, base);
  const marker = refused ? `${plain.includes('?') ? '&' : '?'}${REFUSED_FIELD}` : '';
  return `${plain}${marker}${fragment}`;
}
