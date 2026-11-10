// PDFs and page text to and from the owner's server (contracts CA11), for every sync client. Platform-neutral: `fetch` is given,
// and a PDF is a `Blob` going up and a byte stream coming down. Each call is one request to the server the owner connected.
//
//   PDF up     HEAD first (the cloud may have it already, from another computer); one PUT up to 32 MiB; above that a
//              multipart upload in the server's part size, which resumes where it stopped (the server remembers the parts).
//   PDF down   one GET, streamed; the caller re-hashes it as it is written and keeps nothing on a mismatch.
//   Text up    chunks of at most 256 KB (and 200 pages), the last one marked `complete`.
//   Text down  pages in order, 200 at a time.

import { failureOf, serverOrigin, SyncHttpError } from './http';

/** One PUT carries a PDF up to this size; a bigger one goes in parts (contracts CA11). */
export const SINGLE_PUT_MAX = 32 * 1024 * 1024;
/** A text chunk stays under this many bytes of JSON (plan CL11). */
export const TEXT_CHUNK_BYTES = 256 * 1024;
const TEXT_CHUNK_PAGES = 200;

export interface TransferOptions {
  server: string;
  token(): Promise<string | null>;
  fetch?: typeof fetch;
}

export interface TextPage {
  pageIndex: number;
  text: string;
}

export interface Transfers {
  /** The size of the cloud's copy of this PDF, or null when it has none. */
  headBlob(sha: string): Promise<number | null>;
  /** Uploads one PDF (`size` bytes). Resumes a multipart upload cut off earlier. `onProgress` gets the bytes sent so far. */
  putBlob(sha: string, file: Blob, onProgress?: (sent: number) => void): Promise<void>;
  /** The PDF's bytes as a stream, or null when the cloud has none. */
  getBlob(sha: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Sends a reading's page text in chunks; the last is marked complete. */
  putText(sha: string, extractor: string, pages: readonly TextPage[]): Promise<void>;
  /** Every page of text the cloud holds for this reading, or null when it holds none. */
  getText(sha: string, onPages: (extractor: string, pages: TextPage[], complete: boolean) => Promise<void>): Promise<boolean>;
}

export function createTransfers(o: TransferOptions): Transfers {
  const origin = serverOrigin(o.server);
  if (origin === null) throw new TypeError('The server address must be https (or http on this computer).');
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const checkSha = (sha: string) => {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new TypeError('A fingerprint is 64 lower-case hex characters.');
  };

  /** One request. Answers the Response when it is ok or one of `allow`; throws the SyncHttpError otherwise. */
  async function send(method: string, path: string, init: { body?: BodyInit; type?: string; allow?: number[] } = {}): Promise<Response> {
    const token = await o.token();
    if (token === null) throw new SyncHttpError('signed-out', 0, 'no_token', 'Not signed in.');
    let res: Response;
    try {
      res = await doFetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(init.type !== undefined ? { 'content-type': init.type } : {}) },
        body: init.body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (e) {
      throw new SyncHttpError('offline', 0, 'network', e instanceof Error ? e.message : 'The server could not be reached.');
    }
    if (res.ok || (init.allow ?? []).includes(res.status)) return res;
    throw await failureOf(res);
  }

  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  return {
    async headBlob(sha) {
      checkSha(sha);
      const res = await send('HEAD', `/api/blobs/${sha}`, { allow: [404] });
      if (res.status === 404) return null;
      const n = Number(res.headers.get('content-length'));
      return Number.isFinite(n) ? n : 0;
    },

    async putBlob(sha, file, onProgress) {
      checkSha(sha);
      if (file.size <= SINGLE_PUT_MAX) {
        await send('PUT', `/api/blobs/${sha}`, { body: file, type: 'application/pdf' });
        onProgress?.(file.size);
        return;
      }
      type Start = { done: true } | { uploadId: string; partSize: number; partCount: number; parts: { partNumber: number }[] };
      const start = await json<Start>(await send('POST', `/api/blobs/${sha}/multipart`));
      if ('done' in start) {
        onProgress?.(file.size);
        return;
      }
      const have = new Set(start.parts.map((p) => p.partNumber));
      let sent = 0;
      for (let n = 1; n <= start.partCount; n++) {
        const from = (n - 1) * start.partSize;
        const part = file.slice(from, Math.min(file.size, from + start.partSize));
        if (!have.has(n)) await send('PUT', `/api/blobs/${sha}/multipart/${n}`, { body: part, type: 'application/octet-stream' });
        sent += part.size;
        onProgress?.(sent);
      }
      await send('POST', `/api/blobs/${sha}/multipart/complete`);
    },

    async getBlob(sha) {
      checkSha(sha);
      const res = await send('GET', `/api/blobs/${sha}`, { allow: [404] });
      if (res.status === 404 || res.body === null) return null;
      return res.body;
    },

    async putText(sha, extractor, pages) {
      checkSha(sha);
      const chunks: TextPage[][] = [];
      let cur: TextPage[] = [];
      let bytes = 0;
      for (const p of pages) {
        const size = JSON.stringify(p).length + 1;
        if (cur.length > 0 && (bytes + size > TEXT_CHUNK_BYTES || cur.length >= TEXT_CHUNK_PAGES)) {
          chunks.push(cur);
          cur = [];
          bytes = 0;
        }
        cur.push(p);
        bytes += size;
      }
      chunks.push(cur);
      for (let i = 0; i < chunks.length; i++) {
        const body = JSON.stringify({ extractor, pages: chunks[i], complete: i === chunks.length - 1 });
        await send('PUT', `/api/text/${sha}`, { body, type: 'application/json' });
      }
    },

    async getText(sha, onPages) {
      checkSha(sha);
      let from = 0;
      for (let guard = 0; guard < 1000; guard++) {
        const res = await send('GET', `/api/text/${sha}?from=${from}&limit=${TEXT_CHUNK_PAGES}`, { allow: [404] });
        if (res.status === 404) return false;
        const r = await json<{ extractor: string; state: string; pages: TextPage[]; nextFrom: number | null }>(res);
        const last = r.nextFrom === null;
        await onPages(r.extractor, r.pages, last && r.state === 'complete');
        if (last || r.nextFrom === null || r.nextFrom <= from) return true;
        from = r.nextFrom;
      }
      return true;
    },
  };
}
