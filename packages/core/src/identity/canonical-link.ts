// Canonical links. A wrong answer here either merges two different documents or splits one document in two, so
// every rule is narrow: it applies only to the exact host and path shape it was written for, and leaves the rest
// of the link as the user gave it. Anything that is not an http(s) URL comes back unchanged.

/**
 * Query keys that never choose a document: ads, analytics, "force download", expiring signed-URL parts, and sign-in, session and
 * gift keys (Moodle's `sesskey`, an OAuth `code`, a magic link's `auth`, Medium's gift `sk`: live keys that must never be stored,
 * backed up or synced; R105 and the Phase 4 security read). Compared in lower case, so `accessToken` is `accesstoken`.
 */
const REMOVED_KEYS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'igshid', 'yclid', 'twclid', 'ttclid',
  'ref_src', 'refreqid', 'forcedownload', 'token', 'access_token', 'accesstoken', 'id_token', 'sesskey',
  'code', 'auth', 'sig', 'session', 'sessionid', 'session_id', 'sk',
  'googleaccessid', 'expires', 'signature', 'key-pair-id', 'policy',
]);
const REMOVED_PREFIXES = ['utm_', 'x-amz-', 'x-goog-'];

/** A host is a proxy by name when the part after its first label looks like this (e.g. `ezproxy.lse.ac.uk`). */
const PROXY_HOST = /(^|\.)(ezproxy|libproxy|ezp|proxy|eresources)\.|\.idm\.oclc\.org$/;

const ARXIV_PATH = /^\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/;
const DOI_PATH = /^\/(10\.\d{4,9}(?:\.\d+)*\/.+)$/;
const MOODLE_REVISION = /(\/pluginfile\.php\/\d+\/mod_(?:resource|folder|page|book)\/content\/)\d+\//;
// the same path inside a `file=` value (`/123/mod_resource/content/7/a.pdf`), whose slashes may be written as %2F
const SLASH = '(?:/|%2[Ff])';
const MOODLE_FILE_REVISION = new RegExp(`(${SLASH}\\d+${SLASH}mod_(?:resource|folder|page|book)${SLASH}content${SLASH})\\d+(?=${SLASH})`);

/** How many proxy login wrappers one link may be unwrapped through. */
const MAX_UNWRAP = 8;

function parseWeb(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

function decodeKey(rawKey: string): string {
  const spaced = rawKey.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

function isRemovedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REMOVED_KEYS.has(lower) || REMOVED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** The query without removed keys, sorted by key. Each pair keeps its original spelling and a repeated key keeps its order. */
function cleanSearch(search: string): string {
  const pairs = search
    .replace(/^\?/, '')
    .split('&')
    .filter((raw) => raw !== '')
    .map((raw) => {
      const eq = raw.indexOf('=');
      return { raw, key: decodeKey(eq < 0 ? raw : raw.slice(0, eq)) };
    })
    .filter(({ key }) => !isRemovedKey(key));
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // stable, so a repeated key keeps its order
  return pairs.length === 0 ? '' : `?${pairs.map(({ raw }) => raw).join('&')}`;
}

function cleanInPlace(url: URL): void {
  url.hash = '';
  const login = proxyLogin(url);
  if (login?.rest) {
    // the unencoded target owns the rest of the query, "&" parameters included: clean and sort only what comes before it
    const head = cleanSearch(url.search.slice(1, 1 + login.start));
    url.search = `${head === '' ? '?' : `${head}&`}${url.search.slice(1 + login.start)}`;
  } else {
    url.search = cleanSearch(url.search);
  }
}

/**
 * The link as the user would want to copy it: no fragment, no tracking or signing parameters, the rest of the
 * parameters sorted. Scheme, host and path are left alone. Not an http(s) URL: returned unchanged.
 */
export function cleanLink(url: string): string {
  const parsed = parseWeb(url);
  if (parsed === null) return url;
  cleanInPlace(parsed);
  return parsed.href;
}

interface ProxyLogin {
  /** The link the login page leads to. */
  target: string;
  /** Where the `url=` pair starts in the query (without the "?"), and whether the target runs to the end of the query unencoded. */
  start: number;
  rest: boolean;
}

/**
 * The target of an EZproxy `/login?url=` or `/login?qurl=` link, or null if this is not one.
 * `url=` is taken the way EZproxy reads it: if it starts with `http(s)://`, everything after it is the target
 * (so the target may carry its own `&` parameters); if it is percent-encoded it ends at the next `&`.
 */
function proxyLogin(url: URL): ProxyLogin | null {
  if (!url.hostname.includes('proxy') || !/^\/login\/?$/i.test(url.pathname)) return null;
  const search = url.search.slice(1);
  let offset = 0;
  for (const segment of search.split('&')) {
    const eq = segment.indexOf('=');
    const key = eq > 0 ? decodeKey(segment.slice(0, eq)).toLowerCase() : '';
    if (key === 'url' || key === 'qurl') {
      const value = segment.slice(eq + 1);
      if (/^https?:\/\//i.test(value)) {
        const target = search.slice(offset + eq + 1);
        if (parseWeb(target) !== null) return { target, start: offset, rest: true };
      } else if (/^https?%3a/i.test(value)) {
        try {
          const target = decodeURIComponent(value);
          if (parseWeb(target) !== null) return { target, start: offset, rest: false };
        } catch {
          // not valid UTF-8: not a target
        }
      }
    }
    offset += segment.length + 1;
  }
  return null;
}

/**
 * The real host behind a proxy-by-host-name host: `www-jstor-org.ezproxy.lse.ac.uk` is `www.jstor.org`
 * (`-` is a dot, `--` is a hyphen). Null unless it is clearly a proxy host and the first label decodes to a
 * host name that ends in a plausible top-level domain.
 */
function unproxiedHost(hostname: string): string | null {
  const dot = hostname.indexOf('.');
  if (dot < 1 || !PROXY_HOST.test(hostname)) return null;
  const first = hostname.slice(0, dot);
  if (!first.includes('-')) return null;
  const decoded = first.replace(/--|-/g, (dashes) => (dashes === '--' ? '-' : '.'));
  const labels = decoded.split('.');
  const wellFormed = labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  return wellFormed && /^[a-z]{2,6}$/.test(labels[labels.length - 1] ?? '') ? decoded : null;
}

/** The lower-cased DOI in a doi.org path, or null if the path is not a DOI (or cannot be decoded safely). */
function doiFromPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const doi = DOI_PATH.exec(decoded)?.[1];
  if (doi === undefined) return null;
  // "%", "#" and "?" go back to escapes so that the result still reads as one path (and canonicalising it again is a no-op)
  return doi.toLowerCase().replace(/[%#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Moodle file paths: the web-service form is the browser form, and the revision number is not part of the file. */
function moodlePath(pathname: string): string {
  const marker = '/pluginfile.php/';
  const at = pathname.indexOf(marker);
  if (at < 0) return pathname;
  const service = '/webservice';
  const plain = pathname.slice(0, at).endsWith(service) ? pathname.slice(0, at - service.length) + pathname.slice(at) : pathname;
  return plain.replace(MOODLE_REVISION, (_, head: string) => `${head}0/`);
}

/**
 * Moodle's older link form `pluginfile.php?file=/<context>/mod_resource/content/<revision>/a.pdf`: the revision
 * becomes 0 inside the `file` value, as it does in the path form. Only that one `/content/<digits>/` segment changes,
 * and the value keeps its own spelling (encoded slashes stay encoded).
 */
function moodleFileSearch(pathname: string, search: string): string {
  if (search === '' || !/\/pluginfile\.php$/.test(pathname)) return search;
  const pairs = search.slice(1).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0 || decodeKey(pair.slice(0, eq)) !== 'file') return pair;
    return pair.slice(0, eq + 1) + pair.slice(eq + 1).replace(MOODLE_FILE_REVISION, (_, head: string) => `${head}0`);
  });
  return `?${pairs.join('&')}`;
}

function canonicalize(input: string, unwrapped: number): string {
  const url = parseWeb(input);
  if (url === null) return input;

  // 1. EZproxy login wrapper: the link is its target
  if (unwrapped < MAX_UNWRAP) {
    const login = proxyLogin(url);
    if (login !== null) return canonicalize(login.target, unwrapped + 1);
  }

  cleanInPlace(url);

  // 2. proxy by host name: the host is the real site
  const real = unproxiedHost(url.hostname);
  if (real !== null) {
    url.hostname = real;
    url.port = ''; // the port belonged to the proxy
  }

  // 3. https, no credentials, no "www.", no default port
  url.protocol = 'https:';
  url.username = '';
  url.password = '';
  let host = url.hostname;
  while (host.startsWith('www.') && host.length > 4) host = host.slice(4);
  url.hostname = host;

  // 4. arXiv: one link per paper, whatever the version or the format
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const id = ARXIV_PATH.exec(url.pathname)?.[1];
    if (id !== undefined) return `https://arxiv.org/abs/${id}`;
  }

  // 5. DOI
  if (host === 'doi.org' || host === 'dx.doi.org') {
    const doi = doiFromPath(url.pathname);
    if (doi !== null) return `https://doi.org/${doi}`;
  }

  // 6. Moodle
  url.pathname = moodlePath(url.pathname);
  url.search = moodleFileSearch(url.pathname, url.search);
  return url.href;
}

/**
 * The one spelling a web link is stored and compared under: `cleanLink`, plus https, no "www.", no default port,
 * no credentials, and the proxy, arXiv, DOI and Moodle rules. Not an http(s) URL: returned unchanged.
 */
export function canonicalLink(url: string): string {
  return canonicalize(url, 0);
}
