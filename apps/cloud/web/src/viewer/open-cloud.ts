// The web's version of apps/extension/src/viewer/open-saved.ts (swapped in by vite.config.ts): a reading's saved copy is the
// one in the owner's cloud (`/api/blobs/<sha>`), not a file on this computer.
//
// - The download starts as soon as the page opens (viewer-main.tsx), while the library comes down, so the two overlap.
// - It streams, with a progress bar (DownloadProgress.tsx). A connection that breaks part-way is picked up where it stopped,
//   with a Range request, a few times, waiting for the browser to be online again.
// - The bytes go through the viewer's usual path for a file (hashed as they are read), and the PDF opens only when its SHA-256
//   is the reading's id. Anything else is refused and nothing is kept.
// - Nothing is written to this computer: the PDF lives in this tab's memory.
import { MAX_OPEN_BYTES, PdfFormatError, PdfLoadError } from '@sop/viewer';
import type { ViewerParams } from '@ext/shared/viewer-url';
import { type OpenDocumentDeps, type OpenOutcome, openPickedFile } from '@ext/viewer/open-document';
import { goToSignIn, ownFetch } from '../sync/api';
import { blobHref } from './download';
import { PHONE_LAYOUT } from './layout';

/** The cloud holds no PDF for this reading (it was kept on the computer it was read on, or the upload has not finished). */
export class SavedCopyMissingError extends PdfLoadError {
  constructor() {
    super('network');
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
/** A phone's browser holds about this much for the engine (it needs about twice the file); bigger PDFs are for Download. */
const PHONE_MAX_BYTES = 150 * 1024 * 1024;
const MAX_TRIES = 6;
/** A download that receives nothing for this long is given up and picked up again (a connection that died without saying so). */
const STALL_MS = 20_000;

/** What the progress bar shows. */
export type DownloadState =
  | { kind: 'idle' }
  | { kind: 'downloading'; received: number; total: number | null; waiting: boolean }
  | { kind: 'done' }
  | { kind: 'failed' };

let state: DownloadState = { kind: 'idle' };
const listeners = new Set<() => void>();
function set(next: DownloadState): void {
  state = next;
  for (const l of [...listeners]) l();
}
export const downloadProgress = {
  get: (): DownloadState => state,
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/** A file name from an address: no folders, no control characters, at most 255 characters. Null when nothing is left. */
function cleanName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const base = (name.split(/[/\\]/u).pop() ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 255);
  return base === '' ? null : base;
}

/** The name a saved copy's address gives it (for the header and the tab while it opens), or null for any other address. */
export function savedCopyName(p: ViewerParams): string | null {
  return (p.doc ?? null) === null ? null : cleanName(p.name);
}

class Missing extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves when the browser says it is online (at once if it is), or after `ms`. */
function onlineOrAfter(ms: number): Promise<void> {
  if (navigator.onLine) return sleep(ms);
  return new Promise((resolve) => {
    const done = () => {
      removeEventListener('online', done);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(done, Math.max(ms, 60_000));
    addEventListener('online', done);
  });
}

/** The whole file's size from a 200's Content-Length or a 206's Content-Range. */
function totalOf(res: Response): number | null {
  const range = /\/(\d+)$/u.exec(res.headers.get('content-range') ?? '')?.[1];
  const n = Number(range ?? (res.status === 200 ? res.headers.get('content-length') : null));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Downloads the cloud's copy, picking up after a broken connection. Rejects with Missing, PdfLoadError or the last error. */
async function download(sha: string): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  let total: number | null = null;
  let tries = 0;
  set({ kind: 'downloading', received: 0, total: null, waiting: false });
  for (;;) {
    try {
      const stop = new AbortController();
      let watchdog = setTimeout(() => stop.abort(), STALL_MS);
      const wake = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => stop.abort(), STALL_MS);
      };
      const res = await ownFetch(blobHref(sha), { cache: 'no-store', signal: stop.signal, headers: received > 0 ? { range: `bytes=${received}-` } : {} }).finally(wake);
      if (res.status === 401) {
        goToSignIn();
        throw new PdfLoadError('aborted');
      }
      if (res.status === 404 || res.status === 410) throw new Missing();
      if (res.status === 416 && total !== null && received >= total) break;
      if (!res.ok) throw new PdfLoadError('http', { status: res.status });
      if (received > 0 && res.status !== 206) {
        // The server sent the whole file again: start over.
        parts.length = 0;
        received = 0;
      }
      total ??= totalOf(res);
      const limit = PHONE_LAYOUT ? PHONE_MAX_BYTES : MAX_OPEN_BYTES;
      if (total !== null && total > limit) {
        await res.body?.cancel().catch(() => {});
        throw new PdfLoadError('too-large', { size: total });
      }
      if (res.body === null) throw new PdfLoadError('network');
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read().finally(wake);
        if (done) break;
        parts.push(value);
        received += value.byteLength;
        tries = 0;
        set({ kind: 'downloading', received, total, waiting: false });
      }
      clearTimeout(watchdog);
      if (total === null || received >= total) break;
      throw new Error('the download stopped early');
    } catch (e) {
      if (e instanceof Missing || e instanceof PdfLoadError) throw e;
      tries += 1;
      if (tries >= MAX_TRIES) throw e;
      // Offline, or the connection broke: wait, then go on from the last byte received.
      set({ kind: 'downloading', received, total, waiting: true });
      await onlineOrAfter(1000 * 2 ** (tries - 1));
    }
  }
  return new Blob(parts, { type: 'application/pdf' });
}

let started: { sha: string; blob: Promise<Blob> } | null = null;

/** Starts downloading the reading's PDF (viewer-main.tsx calls it before the library is ready). */
export function startCloudDownload(sha: string): void {
  if (!HEX64.test(sha) || started?.sha === sha) return;
  const blob = download(sha);
  blob.catch(() => {});
  started = { sha, blob };
}

/** Opens the reading that `p.doc` names from the cloud's copy. Never rejects: every failure is an outcome. */
export async function openSavedCopy(p: ViewerParams, deps: OpenDocumentDeps): Promise<OpenOutcome> {
  const id = p.doc ?? '';
  if (!HEX64.test(id)) return { kind: 'error', error: new PdfLoadError('network') };
  startCloudDownload(id);
  let blob: Blob;
  try {
    blob = await started!.blob;
  } catch (e) {
    set({ kind: 'failed' });
    if (e instanceof Missing) return { kind: 'error', error: new SavedCopyMissingError() };
    if (e instanceof PdfLoadError) return { kind: 'error', error: e };
    return { kind: 'error', error: new PdfLoadError('network') };
  }
  set({ kind: 'done' });
  const named = new File([blob], cleanName(p.name) ?? 'Saved PDF.pdf', { type: 'application/pdf' });
  const outcome = await openPickedFile(named, deps);
  if (outcome.kind === 'ready' && outcome.doc.loaded.sha256 !== id) {
    // Not the reading's bytes: refuse it, and keep nothing.
    void deps.backend.close(outcome.doc.open.doc).catch(() => {});
    console.error('sickofpdfs: the downloaded PDF is not the one this reading names; it was not opened');
    return { kind: 'error', error: new PdfFormatError('the downloaded file does not match its fingerprint') };
  }
  return outcome;
}
