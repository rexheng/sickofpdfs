// The one place the online lookups touch the network (S12): a plain GET of one address, with nothing about the owner on it.
//
// - No cookies (`credentials: 'omit'`), no referrer, nothing kept in the browser's cache, and no redirect followed: an answer that sends the
//   request on to another address fails instead, so a request can only ever go where `arxiv.ts` and `crossref.ts` built it.
// - No header that names the owner or the extension's files. The browser adds its own (User-Agent, Origin).
// - A time limit, and a limit on the size of the answer, because the answer comes from the internet.
export interface Answer {
  status: number;
  /** The body as text, or null when it was not read (not a 200) or was too big. */
  text: string | null;
  /** How long the server asked to be left alone (Retry-After), in ms, or null. */
  retryAfterMs: number | null;
}

/** The longest answer read. A Crossref work with thousands of references is the biggest thing asked for. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

function retryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

/** Reads a body up to `MAX_BYTES`. Null when it is longer. */
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

/** Asks for `url`. Rejects when the network fails, the request is stopped (`signal`), or it takes too long. */
export async function ask(url: string, accept: string, signal: AbortSignal): Promise<Answer> {
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { Accept: accept },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  const retryAfterMs = retryAfter(res.headers.get('retry-after'), Date.now());
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, text: null, retryAfterMs };
  }
  return { status: 200, text: await readCapped(res), retryAfterMs };
}
