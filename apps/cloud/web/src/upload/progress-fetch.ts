// A `fetch` for the PDF upload that also says how much of the body has gone (fetch cannot report upload progress; XMLHttpRequest
// can). PUTs with a file go through XMLHttpRequest, same origin, with the session cookie and the CSRF header; everything else
// goes through the web library's own fetch (sync/api.ts). Nothing goes to any other site.
import { csrfToken, ownFetch } from '../sync/api';

/** A request that sends nothing for this long is given up (a connection that died without saying so); the upload retries it. */
const STALL_MS = 30_000;

/** `onSent(bytes)` hears how much of the current request's body has gone. */
export function progressFetch(onSent: (bytes: number) => void): typeof fetch {
  return (input, init = {}) => {
    const body = init.body;
    if ((init.method ?? 'GET').toUpperCase() !== 'PUT' || !(body instanceof Blob)) return ownFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.origin !== location.origin) return Promise.reject(new TypeError('The web library only talks to its own server.'));
    return new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url.href);
      xhr.withCredentials = false; // same origin: the cookie goes anyway
      const headers = new Headers(init.headers);
      headers.delete('authorization');
      headers.set('x-csrf-token', csrfToken());
      headers.forEach((v, k) => xhr.setRequestHeader(k, v));
      xhr.responseType = 'blob';
      let stalled = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          stalled = true;
          xhr.abort();
        }, STALL_MS);
      };
      wake();
      xhr.upload.onprogress = (e) => {
        wake();
        onSent(e.loaded);
      };
      xhr.onloadend = () => clearTimeout(watchdog);
      xhr.onload = () => {
        const out = new Headers();
        for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/u)) {
          const at = line.indexOf(':');
          if (at > 0) out.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
        }
        resolve(new Response(xhr.status === 204 ? null : (xhr.response as Blob), { status: xhr.status, headers: out }));
      };
      xhr.onerror = () => reject(new TypeError('The connection broke.'));
      xhr.ontimeout = () => reject(new TypeError('The connection timed out.'));
      xhr.onabort = () => reject(stalled ? new TypeError('The connection stopped.') : new DOMException('Stopped.', 'AbortError'));
      init.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(body);
    });
  };
}
