import { sendRuntimeMessage } from '../shared/send-message';
import type { ViewerParams } from '../shared/viewer-url';

/** True when the viewer sits in a frame of some page (a PDF in an `<iframe>`) and has a PDF to show. */
export function wantsFullTab(p: ViewerParams): boolean {
  return window.top !== window && p.source !== null;
}

/**
 * A viewer in a frame asks for the whole tab: the PDF opens there, with "Back to page" pointing at the page that
 * held the frame. Returns true when the viewer should show "Opening in the full tab…" and wait. If the page's
 * embedded PDFs are suppressed (the person just came back from the full tab), the worker says no and `onStay` is
 * called: the viewer then renders inside the frame.
 */
export function maybeLeaveFrame(p: ViewerParams, onStay?: () => void): boolean {
  if (!wantsFullTab(p)) return false;
  const pageSuffix = p.page === null ? '' : `#page=${p.page}`;
  sendRuntimeMessage({ type: 'takeover:embedded', url: `${p.source}${pageSuffix}` }).then(
    (reply) => {
      if (!reply.opened) onStay?.();
    },
    () => onStay?.(), // the worker did not answer: show the PDF here rather than nothing
  );
  return true;
}

/**
 * May the viewer show this PDF in the frame it is in? A local file only if every page above the frame is a local
 * page too. Any web page can put the viewer in a frame (it is a web-accessible page) and name a file on this
 * computer; the page cannot read what the frame shows, but nothing from the file should be loaded for it either.
 * (pdf.js has the same rule.) `ancestorOrigins` lists the origins above this frame; a local page's is "file://".
 */
export function mayShowSourceHere(p: ViewerParams): boolean {
  if (window.top === window || p.source === null || !p.source.startsWith('file:')) return true;
  return Array.from(location.ancestorOrigins).every((origin) => origin === 'file://');
}
