import { isOpenableUrl, stripFragment } from '../../shared/urls';
import { isMarkedRefused, parseViewerUrl, VIEWER_PATH } from '../../shared/viewer-url';
import { requestById } from './request-log';

/**
 * Which addresses the viewer may load in each tab. Any web page can send a tab to `viewer.html?file=<anything>` or put
 * the viewer in a frame (it is a web-accessible page), so the viewer's own address proves nothing. What the service
 * worker saw the tab do does. An address is granted to a tab when:
 * - the takeover rule redirected the tab's request for it (a page or a frame) to the viewer (`onBeforeRedirect`);
 * - the service worker itself sent the tab to the viewer for it (a sniffed PDF, an embedded one, the file:// fallback);
 * - the tab navigated to that file:// address. A web page cannot start such a navigation: Chrome refuses it before
 *   it starts, and webNavigation never hears of it (measured on Chrome 153);
 * - the owner opened the viewer's own address (ruling R63): typed, a bookmark, a keyword or suggestion, a start page,
 *   a reload, Back or Forward. Duplicate tab, Reopen closed tab and session restore report a reload (measured on
 *   Chrome 153). A web page's opening (a link, a form, a redirect) is never one of these.
 * The viewer asks with `takeover:prepare-fetch`. An address the tab never opened is not loaded with the owner's
 * sign-in, and a local file is not loaded at all. Each record also keeps the Referer that the viewer's own request
 * repeats: the one Chrome sent for that PDF, never the one of some other request of the tab.
 *
 * The records are in chrome.storage.session (memory only, gone when the browser closes), so a reload or Back in the
 * tab still works after the worker slept. They go dormant when the tab goes to another page, and go when it closes.
 *
 * A refusal is remembered too, two ways: for the browser session, by address; and in the refused viewer's own address,
 * which it marks (viewer-url.ts, `withRefusal`). Chrome keeps that address in the tab's history, so the marker also
 * survives a browser restart's session restore, where chrome.storage.session is empty and the tab reports a plain
 * reload. Either way an address the viewer was not allowed to load stays refused when it is opened again by reload,
 * Back or Forward, Duplicate tab, Reopen closed tab or session restore, so a web page cannot wait for the owner to do
 * one of those. Only a real opening of that address (a link the takeover opened, a typed address) lifts it.
 */
export interface Grant extends Opened {
  /** The address as the network stack sees it: normalised, without a fragment. */
  url: string;
  /**
   * The tab has left the viewer for another page since (`leaveGrants`). A dormant record counts for nothing: a web
   * page in the tab cannot use it to re-open that PDF with the owner's sign-in. Only the owner's own return to that
   * viewer (Back or Forward, a reload, a typed address) wakes it, with its Referer and page.
   */
  dormant?: boolean;
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
/** Addresses refused in this browser session, newest first. */
const REFUSED_KEY = 'refused';
const MAX_REFUSED = 100;

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

async function readRefused(): Promise<string[]> {
  const value: unknown = (await chrome.storage.session.get(REFUSED_KEY))[REFUSED_KEY];
  return Array.isArray(value) ? (value as string[]) : [];
}

async function write(tabId: number, target: string, how: Partial<Opened>): Promise<void> {
  const { frameId, parentFrameId, referer, back } = { ...WHOLE_TAB, ...how };
  const record: Grant = { url: target, frameId, parentFrameId, referer, back };
  const others = (await read(tabId)).filter((g) => g.url !== target);
  await chrome.storage.session.set({ [keyOf(tabId)]: [record, ...others].slice(0, MAX_PER_TAB) });
  const refused = await readRefused();
  if (refused.includes(target)) await chrome.storage.session.set({ [REFUSED_KEY]: refused.filter((u) => u !== target) });
}

/** This tab really opened `url`: its viewer may load it. A refusal of that address ends. */
export function grant(tabId: number, url: string, how: Partial<Opened> = {}): Promise<void> {
  return inOrder(async () => {
    const target = keyUrl(url);
    if (target === null || tabId < 0) return;
    await write(tabId, target, how);
  });
}

/** The viewer was not allowed to load `url` with the owner's sign-in: a reload or another re-visit must not change that. */
export function refuse(url: string): Promise<void> {
  return inOrder(async () => {
    const target = keyUrl(url);
    if (target === null) return;
    const others = (await readRefused()).filter((u) => u !== target);
    await chrome.storage.session.set({ [REFUSED_KEY]: [target, ...others].slice(0, MAX_REFUSED) });
  });
}

/**
 * The owner opened the viewer's address for `url` in this tab (`revisit`: by reload, Back or Forward, which also
 * covers Duplicate tab, Reopen closed tab and session restore). Granted, unless the tab already has a record (which
 * keeps its Referer and page) or this is a re-visit of a refused address: refused in this session, or `marked` refused
 * in the address itself.
 */
function grantOwnerOpening(tabId: number, url: string, revisit: boolean, marked: boolean): Promise<void> {
  return inOrder(async () => {
    const target = keyUrl(url);
    if (target === null || tabId < 0) return;
    const records = await read(tabId);
    const own = records.find((g) => g.url === target);
    if (own !== undefined) {
      // The owner came back to a viewer this tab opened: its record wakes, Referer and page kept.
      if (own.dormant === true) await chrome.storage.session.set({ [keyOf(tabId)]: records.map((g) => (g === own ? { ...g, dormant: false } : g)) });
      return;
    }
    if (revisit && (marked || (await readRefused()).includes(target))) return;
    await write(tabId, target, {});
  });
}

/** Transitions only the owner starts (ruling R63). A link, a form or a redirect is a web page's (or a server's). */
const OWNER_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'reload', 'keyword', 'generated', 'start_page']);

function ownerStarted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): { owner: boolean; revisit: boolean } {
  const q = details.transitionQualifiers;
  const back = q.includes('forward_back');
  if (q.includes('client_redirect') || q.includes('server_redirect')) return { owner: false, revisit: back };
  return { owner: back || OWNER_TRANSITIONS.has(details.transitionType), revisit: back || details.transitionType === 'reload' };
}

// The viewer's own documents whose opening has been weighed (onCommitted), so prepare-fetch can wait for that.
const weighed = new Set<string>();
const waiters = new Map<string, (() => void)[]>();

function markWeighed(documentId: string): void {
  weighed.add(documentId);
  if (weighed.size > 200) weighed.delete(weighed.values().next().value as string);
  for (const resolve of waiters.get(documentId) ?? []) resolve();
  waiters.delete(documentId);
}

/**
 * Resolves once the opening of the viewer document `documentId` has been weighed (an owner's opening is granted by
 * then), or after `timeoutMs`. The viewer's question can reach the worker before webNavigation's event does.
 */
export function whenWeighed(documentId: string | undefined, timeoutMs: number): Promise<void> {
  if (documentId === undefined || weighed.has(documentId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const list = waiters.get(documentId) ?? [];
    list.push(() => {
      clearTimeout(timer);
      resolve();
    });
    waiters.set(documentId, list);
  });
}

/** The tab's record for `url`, or null when the tab was never seen opening it. */
export function findGrant(tabId: number, url: string): Promise<Grant | null> {
  return inOrder(async () => {
    const target = keyUrl(url);
    if (target === null) return null;
    return (await read(tabId)).find((g) => g.url === target && g.dormant !== true) ?? null;
  });
}

/**
 * The tab went to a page that is not the viewer: its records go dormant (`Grant.dormant`). A page the tab shows from
 * now on must not re-open, by a link of its own, a PDF the owner opened in the tab earlier.
 */
export function leaveGrants(tabId: number): Promise<void> {
  return inOrder(async () => {
    const records = await read(tabId);
    if (records.some((g) => g.dormant !== true)) await chrome.storage.session.set({ [keyOf(tabId)]: records.map((g) => ({ ...g, dormant: true })) });
  });
}

/** The tab closed. */
export function forgetGrants(tabId: number): Promise<void> {
  return inOrder(() => chrome.storage.session.remove(keyOf(tabId)));
}

const recordFailed = () => console.error('sickofpdfs: could not record a PDF the tab opened');

/** The events that grant an address by themselves. Register at the top level of the worker. */
export function installGrants(): void {
  const viewer = chrome.runtime.getURL(VIEWER_PATH);
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0 || !details.url.startsWith(viewer)) return;
    const source = parseViewerUrl(details.url).source;
    const { owner, revisit } = ownerStarted(details);
    const marked = isMarkedRefused(details.url);
    const work = owner && source !== null && isOpenableUrl(source) ? grantOwnerOpening(details.tabId, source, revisit, marked) : Promise.resolve();
    void work.catch(recordFailed).finally(() => markWeighed(details.documentId));
  });

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
