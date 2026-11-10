// The sync API as a client sees it (contracts CA3, CA11): register this device, read the head, pull, push. Every sync client
// uses it: the extension's offscreen engine, the Android app, a test. It knows nothing about tokens beyond asking for one, and
// nothing about where it runs: `fetch` and `token` are given to it.
//
// It sends nothing on its own. Each call is one request to the owner's own server, to the address the owner connected.

import type { ChangeEntry, PullResponse, PushResponse } from '../protocol';
import { MAX_PULL_LIMIT, MAX_PUSH_ENTRIES } from '../protocol';

/** What went wrong with one call, in a form the engine can act on. */
export type SyncFailure =
  /** No usable token: sign in again. */
  | 'signed-out'
  /** The server's daily write meter (`lane`) or its rate limit: wait `retryAfterMs`. */
  | 'quota'
  | 'rate-limited'
  /** The server is busy (503) or unreachable: try again soon. */
  | 'busy'
  | 'offline'
  /** This sign-in has no device yet, or another one: register again. */
  | 'device'
  /** The request was refused for a reason a retry will not fix. */
  | 'refused';

export class SyncHttpError extends Error {
  constructor(
    readonly failure: SyncFailure,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
    readonly lane: 'text' | 'notes' | null = null,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export interface SyncClientOptions {
  /** The owner's server, as connected: an origin such as `https://sickofpdfs.example.workers.dev`. */
  server: string;
  /** A fresh access token for `<server>/api`, or null when signed out. */
  token(): Promise<string | null>;
  fetch?: typeof fetch;
}

export interface RegisteredDevice {
  device: string;
  head: number;
}

export interface SyncClient {
  readonly server: string;
  /** POST /api/devices. Send the stored id again after a new sign-in to keep it. */
  registerDevice(o: { id?: string | null; name?: string }): Promise<RegisteredDevice>;
  head(): Promise<number>;
  pull(since: number, limit?: number): Promise<PullResponse>;
  push(entries: readonly ChangeEntry[]): Promise<PushResponse>;
  /** Forget (D2): the server drops the document, its PDF, text and notes. Idempotent. */
  forget(sha: string): Promise<void>;
}

/** The origin of a server address, or null when it is not one we may send to (http only for this computer). */
export function serverOrigin(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username !== '' || u.password !== '') return null;
  return u.origin;
}

function retryAfter(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (v === null) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function failureOf(res: Response): Promise<SyncHttpError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown; lane?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
  const message = typeof body?.message === 'string' ? body.message : `The server answered ${res.status}.`;
  const wait = retryAfter(res);
  if (res.status === 401) return new SyncHttpError('signed-out', 401, code, message);
  if (res.status === 429) {
    const lane = body?.lane === 'text' || body?.lane === 'notes' ? body.lane : null;
    return new SyncHttpError(code === 'quota' ? 'quota' : 'rate-limited', 429, code, message, wait ?? 60_000, lane);
  }
  if (res.status === 503 || res.status === 502 || res.status === 504) return new SyncHttpError('busy', res.status, code, message, wait ?? 2_000);
  if (res.status === 409 && (code === 'device_not_registered' || code === 'device_mismatch')) return new SyncHttpError('device', 409, code, message);
  if (res.status >= 500) return new SyncHttpError('busy', res.status, code, message, wait ?? 10_000);
  return new SyncHttpError('refused', res.status, code, message);
}

export function createSyncClient(o: SyncClientOptions): SyncClient {
  const origin = serverOrigin(o.server);
  if (origin === null) throw new TypeError('The server address must be https (or http on this computer).');
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await o.token();
    if (token === null) throw new SyncHttpError('signed-out', 0, 'no_token', 'Not signed in.');
    let res: Response;
    try {
      res = await doFetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (e) {
      throw new SyncHttpError('offline', 0, 'network', e instanceof Error ? e.message : 'The server could not be reached.');
    }
    if (!res.ok) throw await failureOf(res);
    if (method === 'DELETE' || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    server: origin,
    registerDevice: ({ id, name }) => call<RegisteredDevice>('POST', '/api/devices', { ...(id ? { id } : {}), ...(name ? { name } : {}) }),
    head: async () => (await call<{ head: number }>('GET', '/api/sync/head')).head,
    pull: (since, limit = MAX_PULL_LIMIT) => call<PullResponse>('GET', `/api/sync/pull?since=${Math.max(0, Math.floor(since))}&limit=${Math.min(MAX_PULL_LIMIT, Math.max(1, limit))}`),
    push: (entries) => {
      if (entries.length > MAX_PUSH_ENTRIES) throw new RangeError(`A push holds at most ${MAX_PUSH_ENTRIES} entries.`);
      return call<PushResponse>('POST', '/api/sync/push', { entries });
    },
    forget: async (sha) => {
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new TypeError('A fingerprint is 64 lower-case hex characters.');
      await call<unknown>('DELETE', `/api/documents/${sha}`);
    },
  };
}
