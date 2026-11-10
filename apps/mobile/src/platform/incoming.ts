// The viewer's side of a PDF Android handed the app: `viewer.html?incoming=<id>` names a copy in the app's cache. The viewer
// reads it into memory, removes the copy at once, and opens it the way the library opens a file picked from disk (a blob: link
// with the file's own name; ruling R76). So nothing of a private PDF stays on the phone; the learning filter decides, as in Chrome,
// whether the PDF is saved.
import { buildViewerUrl, parseViewerUrl } from '@ext/shared/viewer-url';
import { isNativeApp, SopPlatform, webUrl } from './native';

export type IncomingOutcome = 'none' | 'ready' | 'gone';

/** Reads the PDF the address names into this page, and points the address at it. 'gone': the copy was already read. */
export async function takeIncomingPdf(): Promise<IncomingOutcome> {
  const id = new URLSearchParams(location.search).get('incoming');
  if (id === null) return blobStillOpen();
  if (!isNativeApp()) return 'gone';
  const { pdf } = await SopPlatform.incoming({ id }).catch(() => ({ pdf: null }));
  if (pdf === null) return 'gone';
  try {
    const response = await fetch(webUrl(pdf.path));
    if (!response.ok) return 'gone';
    const file = new File([await response.blob()], pdf.name, { type: 'application/pdf' });
    const link = URL.createObjectURL(file);
    history.replaceState(null, '', buildViewerUrl({ source: link, back: null, page: null, name: pdf.name }));
    return 'ready';
  } catch {
    return 'gone';
  } finally {
    void SopPlatform.release({ id }).catch(() => {});
  }
}

/**
 * A viewer page that comes back from the page history with the blob: link of a PDF read earlier: the link ended with that page.
 * Saved readings (`?doc=`) and the app's own files still open.
 */
async function blobStillOpen(): Promise<IncomingOutcome> {
  const source = parseViewerUrl(location.href).source;
  if (source === null || !source.startsWith('blob:')) return 'none';
  try {
    await (await fetch(source)).body?.cancel();
    return 'none';
  } catch {
    return 'gone';
  }
}
