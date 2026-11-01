// The toolbar icon opens the library (plan S7): the library tab of this window or another if one is open (it comes to
// the front), else a new one.
export const LIBRARY_PATH = 'library.html';

/** Shows the library: an open library tab comes to the front; otherwise one opens next to the current tab. */
export async function openLibrary(): Promise<void> {
  const page = chrome.runtime.getURL(LIBRARY_PATH);
  // getContexts lists this extension's own pages, so no "tabs" permission is needed to find an open library tab.
  const open = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).find(
    (c) => c.tabId >= 0 && c.documentUrl !== undefined && c.documentUrl.startsWith(page),
  );
  if (open !== undefined) {
    await chrome.tabs.update(open.tabId, { active: true });
    if (open.windowId >= 0) await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: page });
}

/** Registers the toolbar icon's click. Call it synchronously when the service worker starts, so a click wakes it. */
export function installOpenLibrary(): void {
  chrome.action.onClicked.addListener(() => {
    openLibrary().catch((error: unknown) => console.error('sickofpdfs: the library did not open', error));
  });
}
