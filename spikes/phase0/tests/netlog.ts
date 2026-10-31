import { readFile } from 'node:fs/promises';

export interface NetlogRequest {
  url: string;
  method: string;
  /** Origin of the context that made the request, or "not an origin" for the browser process. */
  initiator: string;
  /** "main frame", "sub frame" or "other". */
  requestType: string;
  trafficAnnotation: number | null;
  /**
   * Started by one of Chromium's own services (network time, Gaia, component updater, GCM, AI Mode
   * eligibility, …): no initiating origin and not a navigation. Pages, workers and service workers
   * (extension or web) always carry their origin as initiator, and navigations (including
   * chrome.tabs.create) have a frame request type, so neither is ever classified here.
   */
  browserService: boolean;
}

interface NetLog {
  constants: { logEventTypes: Record<string, number> };
  events: { type: number; source: { id: number }; params?: Record<string, unknown> }[];
}

/** Every URL request in a Chromium `--log-net-log` file, in start order (a redirect starts a new job). */
export async function readNetlogRequests(path: string): Promise<NetlogRequest[]> {
  const log = parseNetlog(await readFile(path, 'utf8'));
  const START_JOB = log.constants.logEventTypes.URL_REQUEST_START_JOB;
  const ALIVE = log.constants.logEventTypes.REQUEST_ALIVE;
  const annotations = new Map<number, number>();
  for (const e of log.events) {
    if (e.type === ALIVE && typeof e.params?.traffic_annotation === 'number') annotations.set(e.source.id, e.params.traffic_annotation);
  }
  const requests: NetlogRequest[] = [];
  for (const e of log.events) {
    if (e.type !== START_JOB || typeof e.params?.url !== 'string') continue;
    const initiator = String(e.params.initiator ?? 'not an origin');
    const requestType = String(e.params.request_type ?? 'other');
    requests.push({
      url: e.params.url,
      method: String(e.params.method ?? 'GET'),
      initiator,
      requestType,
      trafficAnnotation: annotations.get(e.source.id) ?? null,
      browserService: initiator === 'not an origin' && requestType === 'other',
    });
  }
  return requests;
}

/**
 * Distinct URLs requested by pages, workers, service workers and navigations, in first-seen order.
 * Requests started by Chromium's own services are left out (see NetlogRequest.browserService);
 * readNetlogRequests lists them.
 */
export async function readNetlogUrls(path: string): Promise<string[]> {
  return [...new Set((await readNetlogRequests(path)).filter((r) => !r.browserService).map((r) => r.url))];
}

// Chromium only writes the closing `]}` on a clean shutdown, so an unterminated file is repaired.
function parseNetlog(text: string): NetLog {
  try {
    return JSON.parse(text) as NetLog;
  } catch {
    return JSON.parse(`${text.trimEnd().replace(/,$/, '')}]}`) as NetLog;
  }
}
