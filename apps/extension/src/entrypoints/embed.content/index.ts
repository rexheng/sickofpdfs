/*
Copyright 2014 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Modified for sickofpdfs, 2026
// Adapted from pdf.js extensions/chromium/contentscript.js (see background/takeover/LICENSE.pdfjs).

import { defineContentScript } from 'wxt/utils/define-content-script';
import { sendRuntimeMessage } from '../../shared/send-message';
import { isOpenableUrl } from '../../shared/urls';
import './style.css';

/**
 * Runs in every http, https and file page and frame at document_start. It holds no data and asks the service worker
 * to act; the worker checks who is asking (background/takeover/messages.ts). It does two things:
 * - A PDF that Chrome shows by itself (the response had no Content-Type, so no rule redirected it): ask whether the
 *   viewer may take it over, and if so have the tab sent there.
 * - A PDF embedded in a page with <embed> or <object>: have the whole tab sent to the viewer, with "Back to page".
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*', 'file://*/*'],
  runAt: 'document_start',
  allFrames: true,
  main() {
    // The animation in style.css fires this for each <embed> and <object>, including those added later.
    document.addEventListener('animationstart', onAnimationStart, true);
    if (document.contentType === 'application/pdf') void offerSniffedPdf();
  },
});

function onAnimationStart(event: AnimationEvent): void {
  if (event.animationName === 'sop-detect-embed' && (event.target instanceof HTMLEmbedElement || event.target instanceof HTMLObjectElement)) {
    watchObjectOrEmbed(event.target);
  }
}

/** Chrome opened this document as a PDF without a rule redirecting it. Ask first: a form's POST answer stays in Chrome. */
async function offerSniffedPdf(): Promise<void> {
  if (window !== window.top) return; // only a PDF that fills the tab; a PDF in a frame stays in Chrome
  // Back or Forward landed on a PDF that the person left for the viewer: let them stay, or Back would never work.
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (navigation?.type === 'back_forward') return;
  try {
    if (await sendRuntimeMessage({ type: 'takeover:can-take-over', url: location.href })) {
      await sendRuntimeMessage({ type: 'takeover:sniffed', url: location.href });
    }
  } catch {
    // The extension was reloaded under this page, or the worker is gone: Chrome keeps the PDF.
  }
}

const watched = new WeakSet<Element>();

/**
 * Called for every <embed> and <object>. If it shows a PDF, tell the worker, which opens the PDF in the whole tab
 * (unless the person came back from there). The address can change later, so the attribute is watched.
 */
function watchObjectOrEmbed(elem: HTMLEmbedElement | HTMLObjectElement): void {
  if (watched.has(elem)) return;
  watched.add(elem);
  let last: string | null = null;
  const check = () => {
    const source = pdfSourceOf(elem);
    if (source === null || source === last) return;
    last = source;
    void sendRuntimeMessage({ type: 'takeover:embedded', url: source }).catch(() => {});
  };
  check();
  new MutationObserver(check).observe(elem, { attributes: true, attributeFilter: [elem instanceof HTMLEmbedElement ? 'src' : 'data'] });
}

/** The absolute address of the PDF that this element shows, or null if it shows something else (or Chrome's own viewer). */
function pdfSourceOf(elem: HTMLEmbedElement | HTMLObjectElement): string | null {
  const type = elem.type.toLowerCase();
  if (type !== '' && type !== 'application/pdf') return null;
  const source = elem instanceof HTMLEmbedElement ? elem.src : elem.data; // both are resolved against the page
  if (type === '' && !/\.pdf(?:$|[?#])/i.test(source)) return null;

  if (
    elem instanceof HTMLEmbedElement &&
    elem.name === 'plugin' &&
    elem.parentNode === document.body &&
    document.body.childElementCount === 1 &&
    elem.src === location.href
  ) {
    // Chrome's own page for a PDF it shows (for example the answer to a form's POST). The worker said no on purpose.
    return null;
  }
  if (elem instanceof HTMLEmbedElement && elem.src === 'about:blank') return null; // Chrome's internal embed since Chrome 76 (pdf.js issue 11137)

  return isOpenableUrl(source) ? source : null; // a blob: or data: PDF cannot be re-fetched by the viewer
}
