import { splitPageFragment, stripFragment } from '../../shared/urls';
import { buildViewerUrl, VIEWER_PATH } from '../../shared/viewer-url';
import { grant, tabTitle } from './grants';
import { defaultReferer } from './referer';
import { waitForRequest } from './request-log';

/** How long the move to the full tab waits for Chrome's own request for an embedded PDF (it is usually there at once). */
const EMBED_REQUEST_WAIT_MS = 1000;

// One record per tab: the page whose embedded PDFs are left to Chrome.
const keyOf = (tabId: number) => `suppressed:${tabId}`;

const samePage = (a: string, b: string) => stripFragment(a) === stripFragment(b);

/**
 * Leave the embedded PDFs of `pageUrl` to Chrome in this tab, until the tab goes to another page. The viewer's "Back
 * to page" sets this so that the page does not send the person straight back to the viewer.
 */
export async function suppressEmbeds(tabId: number, pageUrl: string): Promise<void> {
  await chrome.storage.session.set({ [keyOf(tabId)]: { pageUrl: stripFragment(pageUrl) } });
}

export async function areEmbedsSuppressed(tabId: number, pageUrl: string): Promise<boolean> {
  const record = (await chrome.storage.session.get(keyOf(tabId)))[keyOf(tabId)] as { pageUrl: string } | undefined;
  return record !== undefined && samePage(record.pageUrl, pageUrl);
}

/**
 * Opens the PDF that a page embeds in the whole tab, with "Back to page" pointing at the page. This also suppresses
 * the page's embeds from now on, so that the browser's own Back button lands on the page and not in a loop: the
 * page would otherwise send the tab to the viewer again each time.
 *
 * The viewer's own request repeats the Referer of Chrome's request for the embed or the frame, which follows the
 * page's referrer policy (a page may send none). That request is waited for, briefly; only if it never comes, what
 * Chrome sends by default from the page.
 */
export async function openEmbeddedInTab(tabId: number, url: string, pageUrl: string): Promise<void> {
  const { url: source, page } = splitPageFragment(url);
  const topDocument = () => chrome.webNavigation.getFrame({ tabId, frameId: 0 }).then((f) => f?.documentId, () => undefined);
  const before = await topDocument();
  const seen = await waitForRequest(tabId, source, ['sub_frame', 'object'], EMBED_REQUEST_WAIT_MS);
  // The owner may have left the page while the worker waited: then the tab is theirs, not the page's. (The document,
  // not the address: a page may rewrite its own address with history.replaceState.)
  if (before !== undefined && (await topDocument()) !== before) return;
  await grant(tabId, source, { referer: seen ? seen.referer : defaultReferer(pageUrl, source), back: pageUrl, pageTitle: await tabTitle(tabId) });
  await suppressEmbeds(tabId, pageUrl);
  await chrome.tabs.update(tabId, { url: buildViewerUrl({ source, back: pageUrl, page }) });
}

/** A top-level page committed in `tabId`: the suppression ends unless this is the page itself or the viewer. */
export async function onTabCommitted(tabId: number, url: string): Promise<void> {
  const record = (await chrome.storage.session.get(keyOf(tabId)))[keyOf(tabId)] as { pageUrl: string } | undefined;
  if (!record) return;
  if (samePage(record.pageUrl, url) || url.startsWith(chrome.runtime.getURL(VIEWER_PATH))) return;
  await chrome.storage.session.remove(keyOf(tabId));
}

export async function onTabRemoved(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyOf(tabId));
}
