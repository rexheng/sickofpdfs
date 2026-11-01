// Opening the PDF a viewer address names: Referer set-up, the streaming load (hash and limits), the engine open with
// the password loop, and the 1 GB bounce to Chrome's viewer.
import {
  type LoadedPdf,
  loadPdfSource,
  type OpenResult,
  type PdfBackend,
  PdfFormatError,
  PdfLoadError,
  PdfPasswordError,
} from '@sop/viewer';
import { sendRuntimeMessage } from '../shared/send-message';
import type { ViewerParams } from '../shared/viewer-url';
import { mayShowSourceHere } from './frame-escape';
import { openInChrome } from './open-in-chrome';

export interface OpenedDocument {
  loaded: LoadedPdf;
  open: OpenResult;
  /** The password that opened it; null when none was needed. */
  password: string | null;
  /** The takeover:prepare-fetch reply's referer, when it was not null: the page the PDF was opened from. */
  referrer?: string;
}

export type OpenOutcome =
  | { kind: 'ready'; doc: OpenedDocument }
  | { kind: 'error'; error: PdfLoadError | PdfFormatError }
  | { kind: 'bounced' };

/** Shown while a too-large PDF waits to move to Chrome's viewer. */
export interface LargeFileBounce {
  size: number;
  /** Goes now, without waiting for the rest of the delay. */
  openNow: () => void;
}

export interface OpenDocumentDeps {
  backend: PdfBackend;
  /** Asks for the password: `retry` is true when the last one was wrong. null means the person gave up. */
  askPassword(retry: boolean): Promise<string | null>;
  /** A PDF over the limit is about to open in Chrome's viewer (LargeFileNotice). */
  onLargeFile?(bounce: LargeFileBounce): void;
  signal?: AbortSignal;
}

/** How long the large-file note shows before the tab moves to Chrome's viewer. */
export const BOUNCE_DELAY_MS = 2000;

/** Opens `p.source`. Never rejects: every failure is an `error` outcome. */
export async function openDocument(p: ViewerParams, deps: OpenDocumentDeps): Promise<OpenOutcome> {
  const url = p.source;
  if (url === null) return { kind: 'error', error: new PdfLoadError('network') };
  // A web page put the viewer in a frame and named a file on this computer: nothing of it is loaded (pdf.js's rule).
  if (!mayShowSourceHere(p)) return { kind: 'error', error: new PdfLoadError('aborted') };
  let referrer: string | undefined;
  if (/^https?:/i.test(url)) {
    const { referer } = await prepareFetch(url);
    if (referer !== null) referrer = referer;
  }
  let loaded: LoadedPdf;
  try {
    loaded = await loadPdfSource({ kind: 'url', url }, { signal: deps.signal });
  } catch (err) {
    if (!(err instanceof PdfLoadError)) return { kind: 'error', error: new PdfLoadError('network') };
    if (err.code === 'too-large') {
      bounce(url, err.detail.size ?? 0, deps);
      return { kind: 'bounced' };
    }
    // A file:// read fails for two reasons: Chrome's file access is off (the person can fix that), or the file is gone.
    if (err.code === 'file-access' && (await fileAccessAllowed())) return { kind: 'error', error: new PdfLoadError('network') };
    return { kind: 'error', error: err };
  }
  return openLoaded(loaded, deps, referrer);
}

/** Opens a file the person picked ("Import this PDF", "Choose file"). */
export async function openPickedFile(file: File, deps: OpenDocumentDeps): Promise<OpenOutcome> {
  let loaded: LoadedPdf;
  try {
    loaded = await loadPdfSource({ kind: 'file', file }, { signal: deps.signal });
  } catch (err) {
    return { kind: 'error', error: err instanceof PdfLoadError ? err : new PdfLoadError('file-access') };
  }
  return openLoaded(loaded, deps);
}

/** The engine open, asking for a password as long as PDFium refuses the one given. */
async function openLoaded(loaded: LoadedPdf, deps: OpenDocumentDeps, referrer?: string): Promise<OpenOutcome> {
  let password: string | null = null;
  for (;;) {
    try {
      // Each try needs its own copy: PdfBackend.open transfers the buffer to the engine.
      const open = await deps.backend.open(await loaded.blob.arrayBuffer(), password === null ? {} : { password });
      return { kind: 'ready', doc: { loaded, open, password, ...(referrer !== undefined ? { referrer } : {}) } };
    } catch (err) {
      if (err instanceof PdfPasswordError) {
        password = await deps.askPassword(err.wrongPassword);
        if (password === null) return { kind: 'error', error: new PdfLoadError('aborted') };
        continue;
      }
      if (err instanceof PdfFormatError) return { kind: 'error', error: err };
      // The engine crashed or could not start: shown like a damaged file ("Couldn't load this PDF").
      return { kind: 'error', error: new PdfFormatError(err instanceof Error ? err.message : String(err)) };
    }
  }
}

function bounce(url: string, size: number, deps: OpenDocumentDeps): void {
  let gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    void openInChrome(url);
  };
  const timer = setTimeout(go, BOUNCE_DELAY_MS);
  deps.onLargeFile?.({ size, openNow: go });
}

/** How long the viewer waits for the service worker's Referer set-up before it fetches anyway. */
const PREPARE_TIMEOUT_MS = 2000;

/**
 * takeover:prepare-fetch: the service worker makes the viewer's own fetch of `url` carry the Referer the tab's
 * navigation had (Task 16's sticky rule) and says what it was. No answer in time, or none at all, means no Referer.
 */
async function prepareFetch(url: string): Promise<{ referer: string | null }> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PREPARE_TIMEOUT_MS));
  try {
    const reply = await Promise.race([sendRuntimeMessage({ type: 'takeover:prepare-fetch', url }), timeout]);
    return { referer: reply?.referer ?? null };
  } catch {
    return { referer: null };
  }
}

async function fileAccessAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}
