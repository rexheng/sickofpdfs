import { stripFragment } from '../../shared/urls';
import { VIEWER_PATH } from '../../shared/viewer-url';
import { requestById } from './request-log';

/**
 * Which addresses the viewer may load in each tab. Any web page can send a tab to `viewer.html?file=<anything>` or put
 * the viewer in a frame (it is a web-accessible page), so the viewer's own address proves nothing. What the service
 * worker saw the tab do does. An address is granted to a tab when:
 * - the takeover rule redirected the tab's request for it (a page or a frame) to the viewer (`onBeforeRedirect`);
 * - the service worker itself sent the tab to the viewer for it (a sniffed PDF, an embedded one, the file:// fallback);
 * - the tab navigated to that file:// address. A web page cannot start such a navigation: Chrome refuses it before
 *   it starts, and webNavigation never hears of it (measured on Chrome 153).
 * The viewer asks with `takeover:prepare-fetch`. An address the tab never opened is not loaded with the owner's
 * sign-in, and a local file is not loaded at all. Each record also keeps the Referer that the viewer's own request
 * repeats: the one Chrome sent for that PDF, never the one of some other request of the tab.
 *
 * The records are in chrome.storage.session (memory only, gone when the browser closes), so a reload or Back in the
 * tab still works after the worker slept. They go when the tab closes.
 */
export interface Grant extends Opened {
  /** The address as the network stack sees it: normalised, without a fragment. */
  url: string;
}

/** How the tab opened the address. */
export interface Opened {
  /** The frame it opened in, and that frame's parent (0: the page itself holds it; -1: it is the page). */
  frameId: number;
  parentFrameId: number;
  /** The Referer of Chrome's own request for it (or what Chrome would send, for an embedded PDF); null for none. */
  referer: string | null;
  /** The page that embedded it, which "Back to page" returns to; null when it was not opened from an embed. */
  back: string | null;
}
/** The service worker's own navigations are of the whole tab. */
const WHOLE_TAB: Opened = { frameId: 0, parentFrameId: -1, referer: null, back: null };

/** Enough for Back and Forward through the PDFs of one tab; the oldest goes first. */
const MAX_PER_TAB = 10;
const keyOf = (tabId: number) => `grants:${tabId}`;

// One at a time, in the order they were asked for: the viewer's question always sees the grant of the redirect or
// navigation that brought it there, even while that write is still in flight.
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

function keyUrl(url: string): string | null {
  try {
    return stripFragment(new URL(url).href);
  } catch {
    return null;
  }
}

async function read(tabId: number): Promise<Grant[]> {
  const value: unknown = (await chrome.storage.session.get(keyOf(tabId)))[keyOf(tabId)];
  return Array.isArray(value) ? (value as Grant[]) : [];
}

/** This tab really opened `url`: its viewer may load it. */
export function grant(tabId: number, url: string, how: Partial<Opened> = {}): Promise<void> {
  return inOrder(async () => {
    const target = keyUrl(url);
    if (target === null || tabId < 0) return;
    const { frameId, parentFrameId, referer, back } = { ...WHOLE_TAB, ...how };
    const record: Grant = { url: target, frameId, parentFrameId, referer, back };
    const others = (await read(tabId)).filter((g) => g.url !== target);
    await chrome.storage.session.set({ [keyOf(tabId)]: [record, ...others].slice(0, MAX_PER_TAB) });
  });
}

/** The tab's record for `url`, or null when the tab was never seen opening it. */
export function findGrant(tabId: number, url: string): Promise<Grant | null> {
  return inOrder(async () => {
    const target = keyUrl(url);
    if (target === null) return null;
    return (await read(tabId)).find((g) => g.url === target) ?? null;
  });
}

/** The tab closed. */
export function forgetGrants(tabId: number): Promise<void> {
  return inOrder(() => chrome.storage.session.remove(keyOf(tabId)));
}

const recordFailed = () => console.error('sickofpdfs: could not record a PDF the tab opened');

/** The two events that grant an address by themselves. Register at the top level of the worker. */
export function installGrants(): void {
  // The takeover rules redirect to `viewer.html?DNR:<the request's address>` (rules.ts). A server's own redirect to
  // the viewer has the server's address as `url`, so it never matches another address.
  const redirected = `${chrome.runtime.getURL(VIEWER_PATH)}?DNR:`;
  chrome.webRequest.onBeforeRedirect.addListener(
    (details) => {
      if (details.tabId < 0 || details.redirectUrl !== redirected + details.url) return;
      const { frameId, parentFrameId } = details;
      grant(details.tabId, details.url, { frameId, parentFrameId, referer: requestById(details.requestId)?.referer ?? null }).catch(recordFailed);
    },
    { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame'] },
  );
  chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, url, frameId, parentFrameId }) => void grant(tabId, url, { frameId, parentFrameId }).catch(recordFailed), {
    url: [{ urlPrefix: 'file://' }],
  });
}
