// Where the viewer's "Back to library" goes: the reading's own page in the web library (its notes and page text).
import { parseViewerUrl } from '@ext/shared/viewer-url';

/** The reading's page for the PDF this viewer shows; the library's first page when the address names none. */
export function webBackHref(): string {
  const doc = parseViewerUrl(location.href).doc;
  return typeof doc === 'string' && /^[0-9a-f]{64}$/.test(doc) ? `/d/${doc}` : '/#/home';
}

/** Back to the library: the page before, when it was the library; else the reading's page. */
export function leaveViewer(): void {
  let fromLibrary = false;
  try {
    fromLibrary = document.referrer !== '' && new URL(document.referrer).origin === location.origin;
  } catch {
    // no referrer
  }
  if (fromLibrary && history.length > 1) history.back();
  else location.assign(webBackHref());
}
