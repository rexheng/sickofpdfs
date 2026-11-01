import { readFile } from 'node:fs/promises';

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
