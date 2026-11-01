import { VIEWER_PATH } from '../../shared/viewer-url';
import * as embedded from './embedded';
import * as escape from './escape';
import { forgetGrants, leaveGrants } from './grants';
import { clearStickyReferer } from './referer';
import { forgetTab } from './request-log';

/**
 * One pair of listeners that ends the per-tab state of the takeover when its tab moves on:
 * - the one-time allow rule of the escape hatch (escape.ts);
 * - the embedded-PDF suppression of "Back to page" (embedded.ts);
 * - the sticky Referer rule (referer.ts);
 * - the request log (request-log.ts);
 * - the addresses the tab opened (grants.ts): they go dormant when the tab goes to another page, so that page cannot
 *   re-open them with the owner's sign-in, and wake when the owner comes back (Back, reload); they go when it closes.
 */
export function installTabLifecycle(): void {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const { tabId, url } = details;
    void escape.onTabCommitted(tabId, url);
    void embedded.onTabCommitted(tabId, url);
    // The viewer's own reload keeps its rule and its records; any other page ends the rule and puts the records to sleep.
    if (!url.startsWith(chrome.runtime.getURL(VIEWER_PATH))) {
      void clearStickyReferer(tabId);
      void leaveGrants(tabId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void escape.onTabRemoved(tabId);
    void embedded.onTabRemoved(tabId);
    void clearStickyReferer(tabId);
    forgetTab(tabId);
    void forgetGrants(tabId);
  });
  void escape.sweepExpiredEscapes();
}
