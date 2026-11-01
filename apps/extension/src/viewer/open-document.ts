// Opening the PDF a viewer address names: asking the service worker whether this tab really opened it (and setting up
// the Referer), the streaming load (hash and limits), the engine open with the password loop, and the 1 GB bounce to
// Chrome's viewer.
import {
  type LoadedPdf,
  loadPdfSource,
  type OpenResult,
  type PdfBackend,
  PdfEngineCrashedError,
  PdfFormatError,
  PdfLoadError,
  PdfPasswordError,
} from '@sop/viewer';
import { sendRuntimeMessage } from '../shared/send-message';
import type { ViewerParams } from '../shared/viewer-url';
import { openInChrome } from './open-in-chrome';

export interface OpenedDocument {
  loaded: LoadedPdf;
  open: OpenResult;
  /** The password that opened it; null when none was needed. */
  password: string | null;
  /**
   * The takeover:prepare-fetch reply's referer, when it was not null: the Referer Chrome sent for this PDF (for an
   * embedded PDF, what the embedding page sent, which may be its origin only).
   */
  referrer?: string;
  /**
   * The page this tab was seen embedding the PDF in (takeover:prepare-fetch's `back`, which "Back to page" returns to),
   * when there was one. Never the `back` in the viewer's address, which any web page can write.
   */
  back?: string;
}

export type OpenOutcome =
  | { kind: 'ready'; doc: OpenedDocument }
  /** `signedOut`: the address was fetched without the owner's sign-in (the tab was not seen opening it). */
  | { kind: 'error'; error: PdfLoadError | PdfFormatError; signedOut?: true }
  | { kind: 'bounced' }
  /** A file on this computer that this tab was not seen opening (a web page may have sent it here): not read. */
  | { kind: 'refused' };

/** Shown while a too-large PDF waits to move to Chrome's viewer. */
export interface LargeFileBounce {
  /** Over the 1 GB limit, or under it but more than the engine's memory holds (it needs about twice the file). */
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
  /** The page this tab was seen embedding the PDF in ("Back to page"), as soon as the service worker says; null for none. */
  onBackPage?(back: string | null): void;
  signal?: AbortSignal;
}

/** How long the large-file note shows before the tab moves to Chrome's viewer. */
export const BOUNCE_DELAY_MS = 2000;

/**
 * Opens `p.source` in the viewer that fills the tab (a viewer in a frame never loads anything: App.tsx). Never
 * rejects: every failure is an outcome.
 *
 * Any web page can send a tab to the viewer with any address in it, so the service worker says first whether this tab
 * really opened that address. If it did not, a web address is fetched without the owner's sign-in (no cookies, no
 * Referer), as any page could fetch it, and a local file is not read at all.
 */
export async function openDocument(p: ViewerParams, deps: OpenDocumentDeps): Promise<OpenOutcome> {
  const url = p.source;
  if (url === null) return { kind: 'error', error: new PdfLoadError('network') };
  const { known, referer, back } = await prepareFetch(url);
  deps.onBackPage?.(back);
  if (!known && /^file:/i.test(url)) return { kind: 'refused' };
  const referrer = referer ?? undefined;
  const signedOut = known ? {} : ({ signedOut: true } as const);
  let loaded: LoadedPdf;
  try {
    loaded = await loadPdfSource({ kind: 'url', url }, { signal: deps.signal, anonymous: !known });
  } catch (err) {
    if (!(err instanceof PdfLoadError)) return { kind: 'error', error: new PdfLoadError('network'), ...signedOut };
    if (err.code === 'too-large') {
      bounce(url, err.detail.size ?? 0, deps);
      return { kind: 'bounced' };
    }
    // A file:// read fails for two reasons: Chrome's file access is off (the person can fix that), or the file is gone.
    if (err.code === 'file-access' && (await fileAccessAllowed())) return { kind: 'error', error: new PdfLoadError('network') };
    return { kind: 'error', error: err, ...signedOut };
  }
  return openLoaded(loaded, deps, url, { ...(referrer !== undefined ? { referrer } : {}), ...(back !== null ? { back } : {}) });
}

/** Opens a file the person picked ("Import this PDF", "Choose file"). */
export async function openPickedFile(file: File, deps: OpenDocumentDeps): Promise<OpenOutcome> {
  let loaded: LoadedPdf;
  try {
    loaded = await loadPdfSource({ kind: 'file', file }, { signal: deps.signal });
  } catch (err) {
    return { kind: 'error', error: err instanceof PdfLoadError ? err : new PdfLoadError('file-access') };
  }
  return openLoaded(loaded, deps, null);
}

/**
 * The engine open, asking for a password as long as PDFium refuses the one given. `url` is where the file came from
 * (null for a picked file): a file the engine has no memory for moves there, to Chrome's viewer, like one over 1 GB.
 */
async function openLoaded(loaded: LoadedPdf, deps: OpenDocumentDeps, url: string | null, from: Pick<OpenedDocument, 'referrer' | 'back'> = {}): Promise<OpenOutcome> {
  let password: string | null = null;
  for (;;) {
    try {
      // Each try needs its own copy: PdfBackend.open transfers the buffer to the engine.
      const open = await deps.backend.open(await loaded.blob.arrayBuffer(), password === null ? {} : { password });
      return { kind: 'ready', doc: { loaded, open, password, ...from } };
    } catch (err) {
      if (err instanceof PdfPasswordError) {
        password = await deps.askPassword(err.wrongPassword);
        if (password === null) return { kind: 'error', error: new PdfLoadError('aborted') };
        continue;
      }
      if (err instanceof PdfFormatError) return { kind: 'error', error: err };
      // Opening copies the file into the engine's memory (at most 2 GiB) while the page still holds it, so a file under
      // the 1 GB limit can still be too big: that is a file too large for this viewer, not a damaged one.
      if (err instanceof PdfEngineCrashedError && err.reason === 'out-of-memory') {
        if (url === null) return { kind: 'error', error: new PdfLoadError('too-large', { size: loaded.size }) };
        bounce(url, loaded.size, deps);
        return { kind: 'bounced' };
      }
      // The engine crashed or could not start: shown like a damaged file ("Couldn't load this PDF").
      return { kind: 'error', error: new PdfFormatError(err instanceof Error ? err.message : String(err)) };
    }
  }
}

/**
 * Opens `doc` again from the bytes the viewer still holds, after the engine stopped (the backend starts a fresh worker
 * for this `open`). The new handle replaces the lost one. Rejects when the engine cannot open it again.
 */
export async function reopenDocument(doc: OpenedDocument, backend: PdfBackend): Promise<OpenedDocument> {
  const open = await backend.open(await doc.loaded.blob.arrayBuffer(), doc.password === null ? {} : { password: doc.password });
  void backend.close(doc.open.doc).catch(() => {}); // the lost handle: only forgotten, the worker that held it is gone
  return { ...doc, open };
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

/** How long the viewer waits for the service worker's answer (it may be starting up) before it treats the address as unknown. */
const PREPARE_TIMEOUT_MS = 5000;

/**
 * takeover:prepare-fetch: whether this tab really opened `url`, and the Referer the viewer's own fetch will carry
 * (Task 16's sticky rule). No answer in time, or none at all, counts as an address the tab was not seen opening.
 */
async function prepareFetch(url: string): Promise<{ known: boolean; referer: string | null; back: string | null }> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PREPARE_TIMEOUT_MS));
  try {
    const reply = await Promise.race([sendRuntimeMessage({ type: 'takeover:prepare-fetch', url }), timeout]);
    return { known: reply?.known === true, referer: reply?.referer ?? null, back: reply?.back ?? null };
  } catch {
    return { known: false, referer: null, back: null };
  }
}

async function fileAccessAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}
