/** What a viewer address says: the PDF to open, the page to return to, and the page to show first. */
export interface ViewerParams {
  /** The PDF's address (http, https, file, ...). */
  source: string | null;
  /** The page the PDF was opened from, for "Back to page". */
  back: string | null;
  /** 1-based page to scroll to. */
  page: number | null;
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
 * - `viewer.html?file=<enc>[&back=<enc>]`, which is what `buildViewerUrl` writes.
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
  return { source: decode(fields.get('file')), back: decode(fields.get('back')), page };
}

/**
 * The viewer address for `p`: `<base>?file=<enc>[&back=<enc>][#page=N]`. `base` defaults to this extension's
 * viewer page; Node callers (tests) pass their own.
 */
export function buildViewerUrl(p: ViewerParams, base: string = chrome.runtime.getURL(VIEWER_PATH)): string {
  const query = [p.source !== null && `file=${encodeURIComponent(p.source)}`, p.back !== null && `back=${encodeURIComponent(p.back)}`].filter(Boolean);
  return `${base}${query.length > 0 ? `?${query.join('&')}` : ''}${p.page !== null ? `#page=${p.page}` : ''}`;
}
