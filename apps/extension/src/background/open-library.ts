// "Open library" (plan S7; the toolbar menu's second choice since R103, and the viewer's palette): the library tab of this
// window or another if one is open (it comes to the front), else a new one.
export const LIBRARY_PATH = 'library.html';

/**
 * Shows the library: an open library tab comes to the front; otherwise one opens next to the current tab. `hash` names a page in
 * it, such as `#/settings/cloud` (the toolbar menu's "Sync has stopped" line); an open tab goes there too.
 */
export async function openLibrary(hash?: string): Promise<void> {
  const page = chrome.runtime.getURL(LIBRARY_PATH);
  // getContexts lists this extension's own pages, so no "tabs" permission is needed to find an open library tab.
  const open = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).find(
    (c) => c.tabId >= 0 && c.documentUrl !== undefined && c.documentUrl.startsWith(page),
  );
  if (open !== undefined) {
    await chrome.tabs.update(open.tabId, hash === undefined ? { active: true } : { active: true, url: `${page}${hash}` });
    if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: `${page}${hash ?? ''}` });
}
