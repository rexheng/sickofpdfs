import { sendRuntimeMessage } from '../shared/send-message';
import type { ViewerParams } from '../shared/viewer-url';

/**
 * True when the viewer sits in a frame of some page (a PDF in an `<iframe>`) and has a PDF to show. Such a viewer
 * never loads the PDF itself: any web page can put the viewer in a frame and name any address, and a page could lay
 * its own buttons over what the frame shows. It asks for the whole tab instead, or offers a new tab.
 */
export function wantsFullTab(p: ViewerParams): boolean {
  return window.top !== window && p.source !== null;
}

/**
 * A viewer in a frame asks for the whole tab: the PDF opens there, with "Back to page" pointing at the page that held
 * the frame. The service worker says no when the PDF did not reach this frame through the takeover, when the frame
 * is not the page's own, or when the page's embedded PDFs are suppressed (the person just came back from the full
 * tab); then `onStay` is called, and the viewer offers a new tab instead.
 */
export function maybeLeaveFrame(p: ViewerParams, onStay: () => void): void {
  if (!wantsFullTab(p)) return;
  const pageSuffix = p.page === null ? '' : `#page=${p.page}`;
  sendRuntimeMessage({ type: 'takeover:embedded', url: `${p.source}${pageSuffix}` }).then(
    (reply) => {
      if (!reply.opened) onStay();
    },
    onStay, // the worker did not answer
  );
}

/**
 * May a viewer in a frame offer to open its PDF in a new tab? Not for a local file under a web page: any web page can
 * put the viewer in a frame and name a file on this computer, and nothing from the file should be opened for it
 * (pdf.js has the same rule). `ancestorOrigins` lists the origins above this frame; a local page's is "file://".
 */
export function mayOfferNewTab(p: ViewerParams): boolean {
  if (p.source === null) return false;
  if (/^https?:/i.test(p.source)) return true;
  return /^file:/i.test(p.source) && Array.from(location.ancestorOrigins).every((origin) => origin === 'file://');
}

/** "Open in a new tab": the PDF's own address in a new tab beside this one, where the takeover opens it like a link. */
export function openInNewTab(source: string): void {
  sendRuntimeMessage({ type: 'takeover:open-in-new-tab', url: source }).catch(() => {});
}
