import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { EXTENSION_ID } from '../../apps/extension/scripts/extension-id.mjs';

// What a renderer crash does to the extension, and the owner's way back (crash-report.md, measured on the test build):
// - every page of the extension shares one renderer process: all viewer tabs, the offscreen store document and the service
//   worker die together;
// - because the offscreen document died, Chrome marks the extension "terminated" at once and never reloads it by itself
//   (it does that only for force-installed extensions). Its pages are blocked (ERR_BLOCKED_BY_CLIENT) until it is reloaded;
// - Chrome tells the owner: "sickofpdfs has crashed. Click this balloon to reload the extension." chrome://extensions shows a
//   Reload button on the extension's card. Both reload it the same way. Headless Chromium shows no notification, so the
//   tests press that Reload button.

/** The extension's state ('ENABLED', 'TERMINATED', 'DISABLED', ...), read on chrome://extensions, which works while the extension cannot. */
export function extensionState(ext: Page): Promise<string> {
  return ext.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        // chrome.developerPrivate exists only on chrome://extensions; @types/chrome does not describe it.
        const dev = (globalThis as unknown as { chrome: { developerPrivate: { getExtensionInfo(id: string, cb: (x?: { state: string }) => void): void } } }).chrome.developerPrivate;
        dev.getExtensionInfo(id, (x) => resolve(x?.state ?? 'none'));
      }),
    EXTENSION_ID,
  );
}

/**
 * After a crash: if Chrome terminated the extension, reload it as the owner would, with the Reload button chrome://extensions
 * shows for a terminated extension (the crash notification does the same). Waits until the extension and its service worker
 * are back. Does nothing if the extension is still running (a crash while the offscreen document was not open).
 */
export async function ownerReloadsAfterCrash(context: BrowserContext, timeout = 20_000): Promise<void> {
  const ext = await context.newPage();
  try {
    await ext.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
    const deadline = Date.now() + timeout;
    // Chrome marks it terminated within a few ms of the crash event (measured); a second is plenty.
    let state = await extensionState(ext);
    for (let i = 0; i < 10 && state === 'ENABLED'; i++) {
      await ext.waitForTimeout(100);
      state = await extensionState(ext);
    }
    if (state !== 'TERMINATED') return;
    await ext.reload(); // the card shows its Reload button once the page knows the extension is terminated
    await ext.locator('#terminated-reload-button').filter({ visible: true }).click({ timeout });
    const worker = `chrome-extension://${EXTENSION_ID}/`;
    while ((await extensionState(ext)) !== 'ENABLED' || !context.serviceWorkers().some((w) => w.url().startsWith(worker))) {
      if (Date.now() > deadline) throw new Error(`the extension did not come back after the crash (state ${await extensionState(ext)})`);
      await ext.waitForTimeout(100);
    }
  } finally {
    await ext.close().catch(() => undefined);
  }
}

/**
 * A look inside a tab whose renderer crashed and that Chrome has since reloaded. Playwright never lets a crashed Page be used
 * again ("Page crashed"), so each look goes through a fresh CDP session on the same tab.
 */
export interface TabAfterCrash {
  /** Evaluates `expression` in the tab's page as it is now; null while the page is loading or the expression throws. */
  eval<T>(expression: string): Promise<T | null>;
  /** A screenshot of the tab as it is now (PNG). */
  screenshot(): Promise<Buffer>;
  detach(): Promise<void>;
}

export function lookInside(context: BrowserContext, page: Page): Promise<TabAfterCrash> {
  // A session attached while the renderer is dead never answers, so each look attaches afresh, with a time limit.
  const withSession = async <T>(fn: (cdp: CDPSession) => Promise<T>, ms = 3000): Promise<T | null> => {
    let cdp: CDPSession | null = null;
    const work = (async () => {
      cdp = await context.newCDPSession(page);
      return fn(cdp);
    })().catch(() => null);
    const out = await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
    void (cdp as CDPSession | null)?.detach().catch(() => undefined);
    return out;
  };
  return Promise.resolve({
    eval<T>(expression: string): Promise<T | null> {
      return withSession(async (cdp) => {
        const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        return r.exceptionDetails ? null : ((r.result.value as T | undefined) ?? null);
      });
    },
    async screenshot() {
      const shot = await withSession(async (cdp) => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'), 10_000);
      if (!shot) throw new Error('the tab could not be photographed');
      return shot;
    },
    detach: () => Promise.resolve(),
  });
}

/** The unsent notes a viewer tab holds as drafts (its published annotation session), or null before the session is up. */
export const draftsIn = (tab: TabAfterCrash): Promise<string[] | null> =>
  tab.eval<string[]>(`(globalThis.__sopTest?.annotations?.state().drafts ?? null)?.map((d) => d.body) ?? null`);

/** The text in every text box on the tab's screen. */
export const boxTextsIn = (tab: TabAfterCrash): Promise<string[] | null> =>
  tab.eval<string[]>(`[...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')].map((e) => ('value' in e ? e.value : e.innerText))`);
