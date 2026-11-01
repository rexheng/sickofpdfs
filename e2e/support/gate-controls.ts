import type { BrowserContext, Page, Worker } from '@playwright/test';
import { EXTENSION_ID } from '../../apps/extension/scripts/extension-id.mjs';

/**
 * Positive controls for the network gate (carried requirement R22).
 *
 * "No external request" proves nothing if the gate could not have seen one. Each control makes one stray request
 * (to `localhost`, which is another origin from the fixture server's `127.0.0.1`, so the gate must report it)
 * through ONE path the extension has to the network, and `harness.spec.ts` checks that the gate lists it. A new
 * path (a content script, a new API) gets a control here in the task that adds it.
 */
export interface ControlEnv {
  context: BrowserContext;
  /** The extension's service worker. */
  sw: Worker;
  /** An extension page (the viewer). */
  page: Page;
  /** The address of `path` on the stray origin. */
  stray: (path: string) => string;
  /** The address of `path` on the fixture server (the allowed origin). */
  fixtureUrl: (path: string) => string;
}

export interface GateControl {
  /** The extension API or context the request goes through. */
  api: string;
  /** Makes the request and returns its URL, which the gate must report. */
  run: (env: ControlEnv) => Promise<string>;
}

/** Runs `expression` in the offscreen document (`chrome.offscreen`), creating it first. Playwright does not expose that target. */
async function evaluateInOffscreen(context: BrowserContext, sw: Worker, expression: string): Promise<unknown> {
  await sw.evaluate(async () => {
    const offscreenExists = async () =>
      (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
    if (await offscreenExists()) return;
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'network gate control',
      });
    } catch (error) {
      // The extension's store creates the same document, so a race is expected.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('single offscreen document') || !(await offscreenExists())) throw error;
    }
  });
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
    if (!target) throw new Error('the offscreen document is not among the browser targets');
    // The flat protocol cannot be addressed through Playwright's session object, so use the message-forwarding form.
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    const reply = new Promise<string>((resolve) => {
      cdp.on('Target.receivedMessageFromTarget', (e) => {
        if (e.sessionId === sessionId) resolve(e.message);
      });
    });
    const params = { expression, awaitPromise: true, returnByValue: true };
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params }) });
    const result = JSON.parse(await reply) as { error?: { message: string }; result?: { exceptionDetails?: unknown } };
    if (result.error ?? result.result?.exceptionDetails) throw new Error(`offscreen evaluate failed: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Page expression: runs `body` in a Worker made from a Blob (as the engine's stock loader does) and resolves when it posts a message. */
const inBlobWorker = (body: string) => `new Promise((resolve) => {
  const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(body)}])));
  worker.onmessage = () => resolve(1);
  worker.onerror = () => resolve(0);
})`;

/**
 * Runs `expression` in the isolated world of the extension's content script in `page` (where `chrome.runtime` is the
 * extension's, and the page's own scripts cannot reach), through the debugging protocol. Playwright does not expose
 * that world.
 */
async function evaluateInContentScript(context: BrowserContext, page: Page, expression: string): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const worlds: { id: number; origin: string }[] = [];
    cdp.on('Runtime.executionContextCreated', (e) => worlds.push({ id: e.context.id, origin: e.context.origin }));
    await cdp.send('Runtime.enable'); // replays the contexts that already exist
    const world = worlds.find((w) => w.origin === `chrome-extension://${EXTENSION_ID}`);
    if (!world) throw new Error('the extension has no content script in this page');
    const result = await cdp.send('Runtime.evaluate', { contextId: world.id, expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`content script evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export const GATE_CONTROLS: GateControl[] = [
  {
    api: 'fetch() in an extension page',
    run: async ({ page, stray }) => {
      const url = stray('control/page-fetch');
      await page.evaluate((u) => fetch(u).then((r) => r.status), url);
      return url;
    },
  },
  {
    api: 'XMLHttpRequest in an extension page',
    run: async ({ page, stray }) => {
      const url = stray('control/page-xhr');
      await page.evaluate(
        (u) =>
          new Promise<number>((resolve) => {
            const x = new XMLHttpRequest();
            x.open('GET', u);
            x.onloadend = () => resolve(x.status);
            x.send();
          }),
        url,
      );
      return url;
    },
  },
  {
    api: 'WebSocket in an extension page',
    run: async ({ page, stray }) => {
      const url = stray('control/page-websocket').replace(/^http/, 'ws');
      await page.evaluate(
        (u) =>
          new Promise<void>((resolve) => {
            const ws = new WebSocket(u);
            ws.onerror = ws.onclose = () => resolve();
          }),
        url,
      );
      return url;
    },
  },
  {
    api: 'fetch() in a dedicated worker started by an extension page',
    run: async ({ page, stray }) => {
      const url = stray('control/worker-fetch');
      await page.evaluate(inBlobWorker(`fetch(${JSON.stringify(url)}).then(() => postMessage(1), () => postMessage(1))`));
      return url;
    },
  },
  {
    api: 'synchronous XMLHttpRequest in a dedicated worker (the stock engine font loader)',
    run: async ({ page, stray }) => {
      const url = stray('control/worker-sync-xhr');
      await page.evaluate(inBlobWorker(`try { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(url)}, false); x.send(); } catch {} postMessage(1)`));
      return url;
    },
  },
  {
    api: 'fetch() in the service worker',
    run: async ({ sw, stray }) => {
      const url = stray('control/sw-fetch');
      await sw.evaluate((u) => fetch(u).then((r) => r.status), url);
      return url;
    },
  },
  {
    api: 'fetch() in the offscreen document (chrome.offscreen)',
    run: async ({ context, sw, stray }) => {
      const url = stray('control/offscreen-fetch');
      await evaluateInOffscreen(context, sw, `fetch(${JSON.stringify(url)}).then((r) => r.status)`);
      return url;
    },
  },
  {
    api: 'chrome.tabs.create (a navigation the browser makes for the extension)',
    run: async ({ sw, stray }) => {
      const url = stray('control/tabs-create');
      await sw.evaluate((u) => chrome.tabs.create({ url: u, active: false }), url);
      return url;
    },
  },
  {
    api: 'chrome.tabs.update (the takeover re-points a tab)',
    run: async ({ sw, stray }) => {
      const url = stray('control/tabs-update');
      await sw.evaluate(async (u) => {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        await chrome.tabs.update(tab.id, { url: u });
      }, url);
      return url;
    },
  },
  {
    api: 'chrome.declarativeNetRequest redirect (the takeover mechanism) to an external address',
    run: async ({ page, sw, stray }) => {
      const url = stray('control/dnr-redirect-target');
      await sw.evaluate(async (target) => {
        await chrome.declarativeNetRequest.updateSessionRules({
          addRules: [
            {
              id: 9001,
              priority: 1,
              action: { type: 'redirect', redirect: { url: target } },
              condition: { urlFilter: '||dnr-control.invalid/', resourceTypes: ['xmlhttprequest'] },
            },
          ],
        });
      }, url);
      await page.evaluate(() => fetch('http://dnr-control.invalid/start').then((r) => r.status).catch(() => 0));
      return url;
    },
  },
  {
    api: 'fetch() in the extension content script (embed.content, in a page on the fixture server)',
    run: async ({ context, fixtureUrl, stray }) => {
      const url = stray('control/content-script-fetch');
      const page = await context.newPage();
      await page.goto(fixtureUrl('/h/referer-page')); // an ordinary page: the content script runs in it and takes nothing over
      await evaluateInContentScript(context, page, `fetch(${JSON.stringify(url)}).then((r) => r.status, () => 0)`);
      await page.close();
      return url;
    },
  },
];
