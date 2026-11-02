import { readFile, stat } from 'node:fs/promises';

/** One URL request in a Chromium net log (`--log-net-log`). */
export interface NetlogRequest {
  url: string;
  method: string;
  /** Origin of the context that made the request, or "not an origin" for the browser process. */
  initiator: string;
  /** "main frame", "sub frame" or "other". */
  requestType: string;
  /**
   * Started by one of Chromium's own services (network time, Gaia, component updater, GCM, AI Mode eligibility, ...):
   * no initiating origin and not a navigation. Pages, workers and service workers (extension or web) always carry
   * their origin as initiator, and navigations (including chrome.tabs.create) have a frame request type, so neither
   * is ever classified here. The extension cannot make Chromium send one of these on its behalf.
   */
  browserService: boolean;
}

interface NetLog {
  constants: { logEventTypes: Record<string, number> };
  events: { type: number; source: { id: number }; params?: Record<string, unknown> }[];
}

// Chromium only writes the closing `]}` on a clean shutdown, so an unterminated file is repaired.
function parseNetlog(text: string): NetLog {
  try {
    return JSON.parse(text) as NetLog;
  } catch {
    return JSON.parse(`${text.trimEnd().replace(/,$/, '')}]}`) as NetLog;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the browser has finished writing its net log: the file exists and its size has not changed for two checks in
 * a row. Under heavy load the browser can still be writing it after `context.close()` has returned. Gives up after
 * `timeoutMs`: with a clear error if the file never appeared, and otherwise (still growing) lets the caller read what is
 * there, which `readNetlogRequests` repairs or rejects loudly.
 */
export async function waitForNetlog(netlogPath: string, timeoutMs = 10_000, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let seen = false;
  for (;;) {
    const size = await stat(netlogPath).then(
      (s) => s.size,
      () => -1,
    );
    if (size >= 0) seen = true;
    if (size > 0 && size === last) return;
    last = size;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  if (!seen) throw new Error(`The browser never wrote its net log: ${netlogPath} did not exist ${timeoutMs / 1000} s after the browser closed. The network gate cannot say what left the browser.`);
}

const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

/** Every URL request in a net log, in start order (a redirect starts a new job). */
export async function readNetlogRequests(netlogPath: string): Promise<NetlogRequest[]> {
  const log = parseNetlog(await readFile(netlogPath, 'utf8'));
  const startJob = log.constants.logEventTypes.URL_REQUEST_START_JOB;
  if (startJob === undefined) throw new Error(`${netlogPath} is not a Chromium net log (no URL_REQUEST_START_JOB event type)`);
  const requests: NetlogRequest[] = [];
  for (const e of log.events) {
    if (e.type !== startJob || typeof e.params?.url !== 'string') continue;
    const initiator = text(e.params.initiator, 'not an origin');
    const requestType = text(e.params.request_type, 'other');
    requests.push({
      url: e.params.url,
      method: text(e.params.method, 'GET'),
      initiator,
      requestType,
      browserService: initiator === 'not an origin' && requestType === 'other',
    });
  }
  return requests;
}

const NETWORK_SCHEME = /^(?:https?|wss?):/i;

/**
 * The network gate. Distinct http(s)/ws(s) URLs that anything of ours requested, other than from `allowedOrigin`, in
 * first-seen order. "Anything of ours" is every page, worker, service worker, offscreen document, content script
 * and navigation: they all carry an initiator origin or a frame request type. Requests Chromium's own services start
 * are left out (see NetlogRequest.browserService); `netlogBrowserServiceHosts` lists them.
 */
export async function netlogExternalUrls(netlogPath: string, allowedOrigin: string): Promise<string[]> {
  const requests = await readNetlogRequests(netlogPath);
  const external = requests.filter((r) => !r.browserService && NETWORK_SCHEME.test(r.url) && new URL(r.url).origin !== allowedOrigin);
  return [...new Set(external.map((r) => r.url))];
}

/** The hosts of the requests the gate leaves out, sorted. Tests attach them to their report. */
export async function netlogBrowserServiceHosts(netlogPath: string): Promise<string[]> {
  const hosts = (await readNetlogRequests(netlogPath)).filter((r) => r.browserService && NETWORK_SCHEME.test(r.url)).map((r) => new URL(r.url).host);
  return [...new Set(hosts)].sort();
}

// ---- the online lookups (S12) ------------------------------------------------------------------------------------------------------

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]{2})?\/\d{7})$/;
const DOI = /^10\.\d{4,9}\/\S+$/;

/**
 * True when `url` is exactly a request the online lookups make (Settings → Online lookups, off until the owner turns it on), and so goes to
 * one of two hosts and carries an id and nothing else:
 *   https://export.arxiv.org/api/query?id_list=<arXiv id>&max_results=1
 *   https://api.crossref.org/works/<DOI, percent-encoded>
 * Any other address on these two hosts (a search, a list, an extra parameter) is not one.
 */
export function isLookupRequest(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.hash !== '') return false;
  if (u.hostname === 'export.arxiv.org') {
    const keys = [...u.searchParams.keys()].sort().join(',');
    return u.pathname === '/api/query' && keys === 'id_list,max_results' && u.searchParams.get('max_results') === '1' && ARXIV_ID.test(u.searchParams.get('id_list') ?? '');
  }
  if (u.hostname === 'api.crossref.org') {
    if (u.search !== '' || !u.pathname.startsWith('/works/')) return false;
    try {
      return DOI.test(decodeURIComponent(u.pathname.slice('/works/'.length)));
    } catch {
      return false;
    }
  }
  return false;
}
