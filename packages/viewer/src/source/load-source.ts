// Reads a PDF from where it lives (a web address, a file:// address, or a file the person picked) into one Blob,
// hashing it while it streams in (global constraints: a document is "the SHA-256 of the file's bytes, computed while
// it streams in"). Nothing here touches the engine: the caller opens `blob` with PdfBackend.open.
// Deep imports: @sop/core's index also re-exports code (the learning filter) that this file does not need.
import { createSha256, type Sha256Hasher } from '@sop/core/fingerprint';
import type { Sha256 } from '@sop/core/ids';
import { PdfLoadError } from './errors';
import { displayNameFor } from './file-name';
import { MAX_OPEN_BYTES } from './limits';

export type PdfSourceRef = { kind: 'url'; url: string } | { kind: 'file'; file: File };

export interface LoadedPdf {
  /** The file's bytes, typed application/pdf. Keep it: each PdfBackend.open (a password retry) needs a fresh copy. */
  blob: Blob;
  sha256: Sha256;
  size: number;
  /** What to call the file (displayNameFor). */
  displayName: string;
  /** The address it came from (after redirects); null for a picked file. */
  sourceUrl: string | null;
}

/** How far into the file `%PDF-` may start: PDFium, like Acrobat, accepts junk before the header up to here. */
const HEADER_WINDOW = 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
/** A file:// read arrives in one buffer; it is hashed in slices of this size. */
const HASH_SLICE = 8 * 1024 * 1024;

/**
 * Loads `ref`. Rejects with PdfLoadError:
 * - web address: `http` for an error status, `network` when the request fails or breaks off, `too-large` as soon as
 *   Content-Length (or, without one, the bytes counted so far) passes `maxBytes`, without reading further;
 * - `file:` address: `file-access` when it cannot be read, `too-large` from the size the first progress event gives;
 * - every source: `not-pdf` when the first 1024 bytes hold no `%PDF-` (checked as soon as they arrive), `aborted`
 *   when `signal` fires.
 */
export async function loadPdfSource(ref: PdfSourceRef, opts: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<LoadedPdf> {
  const maxBytes = opts.maxBytes ?? MAX_OPEN_BYTES;
  const signal = opts.signal;
  if (signal?.aborted) throw new PdfLoadError('aborted');
  const hasher = createSha256();
  hasher.catch(() => {}); // awaited below; this only keeps an early failure (no network) from reporting it unhandled
  if (ref.kind === 'file') {
    const collected = await readStream(ref.file.stream(), await hasher, maxBytes, signal);
    return { ...collected, displayName: displayNameFor(null, null, ref.file.name || undefined), sourceUrl: null };
  }
  if (/^file:/i.test(ref.url)) return fromFileUrl(ref.url, hasher, maxBytes, signal);
  return fromFetch(ref.url, hasher, maxBytes, signal);
}

async function fromFetch(url: string, hasher: Promise<Sha256Hasher>, maxBytes: number, signal: AbortSignal | undefined): Promise<LoadedPdf> {
  // Our own controller, so the body can be dropped (too large, not a PDF) whatever the caller's signal does.
  const request = new AbortController();
  const onAbort = () => request.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'include', cache: 'default', signal: request.signal });
    } catch {
      throw new PdfLoadError(signal?.aborted ? 'aborted' : 'network');
    }
    if (!res.ok) throw new PdfLoadError('http', { status: res.status });
    const declared = contentLength(res.headers.get('content-length'));
    if (declared !== null && declared > maxBytes) throw new PdfLoadError('too-large', { size: declared });
    if (!res.body) throw new PdfLoadError('network');
    const collected = await readStream(res.body, await hasher, maxBytes, signal);
    const finalUrl = res.url || url;
    return { ...collected, displayName: displayNameFor(finalUrl, res.headers.get('content-disposition')), sourceUrl: finalUrl };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    request.abort(); // a no-op once the body is read; otherwise it frees the connection
  }
}

function contentLength(header: string | null): number | null {
  if (header === null || !/^\s*\d+\s*$/.test(header)) return null;
  return Number(header);
}

/** file:// cannot be fetched; an extension page reads it with XHR when "Allow access to file URLs" is on. */
async function fromFileUrl(url: string, hasher: Promise<Sha256Hasher>, maxBytes: number, signal: AbortSignal | undefined): Promise<LoadedPdf> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let sizeChecked = false;
    const onAbort = () => xhr.abort();
    const settle = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = (e) => {
      if (sizeChecked || !e.lengthComputable) return;
      sizeChecked = true;
      if (e.total > maxBytes) {
        settle();
        xhr.onabort = null;
        xhr.abort();
        reject(new PdfLoadError('too-large', { size: e.total }));
      }
    };
    xhr.onload = () => {
      settle();
      const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
      if (ok && xhr.response instanceof ArrayBuffer) resolve(xhr.response);
      else reject(new PdfLoadError('file-access'));
    };
    xhr.onerror = () => {
      settle();
      reject(new PdfLoadError('file-access'));
    };
    xhr.onabort = () => {
      settle();
      reject(new PdfLoadError('aborted'));
    };
    xhr.send();
  });
  const collector = new Collector(await hasher, maxBytes);
  const bytes = new Uint8Array(buffer);
  for (let at = 0; at < bytes.byteLength; at += HASH_SLICE) collector.add(bytes.subarray(at, at + HASH_SLICE));
  return { ...collector.finish(), displayName: displayNameFor(url, null), sourceUrl: url };
}

/** Reads a byte stream to its end through a Collector; cancels the stream on any failure. */
async function readStream(
  stream: ReadableStream<Uint8Array>,
  hasher: Sha256Hasher,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ blob: Blob; sha256: Sha256; size: number }> {
  const reader = stream.getReader();
  const collector = new Collector(hasher, maxBytes);
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        throw new PdfLoadError(signal?.aborted ? 'aborted' : 'network');
      }
      if (signal?.aborted) throw new PdfLoadError('aborted');
      if (step.done) return collector.finish();
      collector.add(step.value);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Counts, hashes and keeps the chunks; enforces the size limit and the `%PDF-` check as early as it can. */
class Collector {
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private size = 0;
  /** The first HEADER_WINDOW bytes, until the header has been checked. */
  private head: Uint8Array | null = new Uint8Array(0);

  constructor(
    private readonly hasher: Sha256Hasher,
    private readonly maxBytes: number,
  ) {}

  add(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.size += chunk.byteLength;
    if (this.size > this.maxBytes) throw new PdfLoadError('too-large', { size: this.size });
    if (this.head !== null) {
      const room = HEADER_WINDOW - this.head.byteLength;
      const next = new Uint8Array(this.head.byteLength + Math.min(room, chunk.byteLength));
      next.set(this.head);
      next.set(chunk.subarray(0, room), this.head.byteLength);
      this.head = next;
      if (this.head.byteLength >= HEADER_WINDOW || hasMagic(this.head)) this.checkHead();
    }
    this.hasher.update(chunk);
    this.chunks.push(chunk as Uint8Array<ArrayBuffer>);
  }

  finish(): { blob: Blob; sha256: Sha256; size: number } {
    if (this.head !== null) this.checkHead();
    const blob = new Blob(this.chunks, { type: 'application/pdf' });
    this.chunks.length = 0;
    return { blob, sha256: this.hasher.digest(), size: this.size };
  }

  private checkHead(): void {
    if (this.head === null) return;
    if (!hasMagic(this.head)) throw new PdfLoadError('not-pdf');
    this.head = null;
  }
}

function hasMagic(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.byteLength, HEADER_WINDOW) - PDF_MAGIC.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let k = 0; k < PDF_MAGIC.length; k++) if (bytes[i + k] !== PDF_MAGIC[k]) continue outer;
    return true;
  }
  return false;
}
