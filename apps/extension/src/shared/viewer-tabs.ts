// Which tabs show the viewer, so the service worker can reopen them after a crash (crash-recovery.ts).
//
// The extension has no `tabs` permission (least privilege), so it cannot read the address of its own pages in other tabs, and
// webNavigation does not report them either. Each viewer page therefore notes its own tab id in chrome.storage.local, one key
// per tab, and removes it when the page goes normally. A crash gives the page no chance to remove it, which is the point.
// The key holds the tab id only: nothing about the PDF. chrome.storage.session would be nicer, but Chrome clears it when it
// terminates the extension (measured), which is exactly when it is needed.

export const VIEWER_TAB_PREFIX = 'viewerTab:';
export const viewerTabKey = (tabId: number): string => `${VIEWER_TAB_PREFIX}${tabId}`;

/** For the viewer page: note this tab as a viewer until the page goes. Never in Incognito. */
export function markViewerTab(): void {
  try {
    if (chrome.extension.inIncognitoContext) return;
    void chrome.tabs
      .getCurrent()
      .then((tab) => {
        if (tab?.id === undefined) return;
        const key = viewerTabKey(tab.id);
        void chrome.storage.local.set({ [key]: 1 });
        addEventListener('pagehide', (e: PageTransitionEvent) => {
          // A page kept in the back-forward cache is still this tab's viewer.
          if (!e.persisted) void chrome.storage.local.remove(key);
        });
      })
      .catch(() => undefined);
  } catch {
    // not an extension page (tests): nothing to note
  }
}
