// How the web library talks to its own Worker: always same-origin, with the session cookie (`__Host-sess`, HttpOnly, which this
// page never sees). Every change also carries the session's CSRF token, which the page reads from the `__Host-csrf` cookie
// (double submit, plan CA11). Nothing is ever sent to another site.

const CSRF_COOKIE = '__Host-csrf';

/** The session's CSRF token, or '' when there is none (signed out). */
export function csrfToken(): string {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === CSRF_COOKIE) return part.slice(eq + 1).trim();
  }
  return '';
}

const unsafe = (method: string | undefined) => !['GET', 'HEAD', 'OPTIONS'].includes((method ?? 'GET').toUpperCase());

/** The sign-in page, coming back here afterwards. */
export function goToSignIn(): void {
  const here = `${location.pathname}${location.search}${location.hash}`;
  location.replace(`/login?next=${encodeURIComponent(here)}`);
}

/** `fetch` to our own Worker: same origin only, the cookie, the CSRF header on changes, never a token, never a redirect. */
export const ownFetch: typeof fetch = (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  if (url.origin !== location.origin) return Promise.reject(new TypeError('The web library only talks to its own server.'));
  const headers = new Headers(init.headers);
  headers.delete('authorization');
  if (unsafe(init.method)) headers.set('x-csrf-token', csrfToken());
  return fetch(url, { ...init, headers, credentials: 'same-origin', redirect: 'error' });
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A JSON call to the Worker. 401 goes to the sign-in page. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await ownFetch(path, {
    cache: 'no-store',
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { ...(rest.headers as Record<string, string> | undefined), 'content-type': 'application/json' } } : {}),
  });
  if (res.status === 401) {
    goToSignIn();
    throw new ApiError(401, 'signed_out', 'Sign in again.');
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : `http_${res.status}`, typeof body?.message === 'string' ? body.message : 'Something went wrong.');
  return body as T;
}
