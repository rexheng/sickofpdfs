// The network gate (spec: "a build test fails on any other request"; "during every end-to-end run nothing may leave
// except the PDF itself and allowed calls"; egress table: opening a PDF sends one request, to the site it came from).
//
// R22: a gate that finds nothing proves nothing unless it is known to find something. Every path an extension request
// can take gets a positive control: the extension (or its page) makes a request to a server that is NOT the allowed
// origin, and the gate must list it. The paths are the ones the extension can drive on its own: service-worker fetch,
// extension-page fetch / XHR / image / frame / web socket / beacon, a tab opened with chrome.tabs.create, and
// window.open. (Requests from an offscreen document or a dedicated worker cannot be triggered from outside; they are
// not covered here.)
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Worker } from '@playwright/test';
import { EXTENSION_ID } from '../apps/extension/scripts/extension-id.mjs';
import { VIEWER_PATH, buildViewerUrl } from '../apps/extension/src/shared/viewer-url';
import { PROD_BUILD_DIR, TEST_BUILD_DIR } from './support/launch';
import { netlogExternalUrls } from './support/netlog';
import { ensureBuilt, launchRaw, startCountingServer } from './support/raw-launch.spec-blind';
import { ensureSamplePdf } from './support/sample-pdf.spec-blind';
import { startFixtureServer } from './support/server';

const SAMPLE = 't12-sample.pdf';
const BASE = `chrome-extension://${EXTENSION_ID}/${VIEWER_PATH}`;
type Chrome = { chrome: { tabs: { create(o: { url: string }): Promise<unknown> } } };

const BUILDS = [
  ['test build', TEST_BUILD_DIR, 'build:e2e'],
  ['production build', PROD_BUILD_DIR, 'build'],
] as const;

test.beforeAll(() => {
  test.setTimeout(10 * 60_000); // only matters when a build has to be made first
  for (const [, dir, script] of BUILDS) ensureBuilt(dir, script);
});

// eslint-disable-next-line no-empty-pattern -- Playwright needs a destructuring pattern as the first parameter
test('The network gate: opening a PDF sends nothing but the PDF request, in both builds, and the gate sees a request through each path', async ({}, testInfo) => {
  test.setTimeout(300_000);
  for (const [name, dir] of BUILDS) {
    await test.step(`opening a PDF sends nothing out except the request for the PDF (${name})`, async () => {
      await ensureSamplePdf(SAMPLE);
      const server = await startFixtureServer();
      const run = await launchRaw(dir, { netlog: true });
      try {
        const pdfUrl = server.url(`/f/${SAMPLE}`);
        const page = await run.context.newPage();
        await page.goto(buildViewerUrl({ source: pdfUrl, back: null, page: null }, BASE));
        await page.waitForLoadState('load');
        await page.waitForTimeout(4000); // start-up work of the service worker and viewer
        await page.screenshot({ path: testInfo.outputPath(`t12-gate-viewer-open-${name.split(' ')[0]}.png`) });
        await run.close(); // the net log is complete only after the browser has shut down
        await testInfo.attach('netlog.json', { path: run.netlogPath });

        expect(await netlogExternalUrls(run.netlogPath, server.origin)).toEqual([]);
        // The PDF's own server is allowed above; this asks for everything and finds only the PDF.
        const everything = [...new Set(await netlogExternalUrls(run.netlogPath, 'http://127.0.0.1:1'))];
        expect(everything.filter((u) => u !== pdfUrl)).toEqual([]);
      } finally {
        await run.dispose();
        await server.close();
      }
    }, { timeout: 60_000 });
  }
  await test.step('positive controls: the gate lists a request made through each path, and stays quiet about the rest (R22)', async () => {
    await ensureSamplePdf(SAMPLE);
    const allowed = await startFixtureServer();
    const elsewhere = await startCountingServer();
    const run = await launchRaw(TEST_BUILD_DIR, { netlog: true });
    try {
      const page = await run.context.newPage();
      await page.goto(buildViewerUrl({ source: allowed.url(`/f/${SAMPLE}`), back: null, page: null }, BASE));
      await page.waitForLoadState('load');

      const urls = new Map<string, string>();
      for (const c of CONTROLS) {
        const origin = c.host === 'ip' ? elsewhere.origin : elsewhere.localhostOrigin;
        const url = `${c.scheme === 'ws' ? origin.replace('http', 'ws') : origin}${c.path}`;
        urls.set(c.name, url);
        await c.run({ sw: run.sw, page, url });
        await elsewhere.waitFor(c.path); // the server saw it, so the net log has it
      }
      // The allowed origin, reached through the same service worker, must NOT be reported.
      const allowedUrl = allowed.url(`/f/${SAMPLE}`);
      const before = allowed.requests(`/f/${SAMPLE}`);
      await run.sw.evaluate((u) => fetch(u, { mode: 'no-cors' }).then(() => undefined), allowedUrl);
      await page.waitForTimeout(3000); // Chromium's own background requests show up in these seconds

      await run.close();
      await testInfo.attach('netlog.json', { path: run.netlogPath });
      const reported = await netlogExternalUrls(run.netlogPath, allowed.origin);
      const rawLog = await readFile(run.netlogPath, 'utf8');

      // Every path gets its own check, so one blind path does not hide another.
      for (const c of CONTROLS) {
        await test.step(`sees: ${c.name}`, () => {
          expect.soft(reported, `the gate is blind to: ${c.name}`).toContain(urls.get(c.name));
        });
      }

      await test.step('ignores the allowed origin', () => {
        expect(allowed.requests(`/f/${SAMPLE}`), 'the control request to the allowed origin did not arrive').toBeGreaterThan(before);
        expect.soft(reported.filter((u) => u.startsWith(allowed.origin))).toEqual([]);
      });

      await test.step('ignores Chromium’s own background services', () => {
        // Without such requests in the log this step would prove nothing; the browser starts them within seconds.
        const sawServices = /"url":\s*"https?:\/\/[^"/]*\.(google|googleapis|gstatic)\.com/.test(rawLog);
        if (!sawServices) {
          testInfo.annotations.push({ type: 'note', description: 'Chromium made no background requests in this run, so the filter was not exercised' });
          return;
        }
        const expected = new Set(urls.values());
        // a tab that the controls opened asks its own server for /favicon.ico
        expect.soft(reported.filter((u) => !expected.has(u) && !u.endsWith('/favicon.ico'))).toEqual([]);
      });
    } finally {
      await run.dispose();
      await elsewhere.close();
      await allowed.close();
    }
  }, { timeout: 180_000 });
});

interface Control {
  name: string;
  path: string;
  /** Which spelling of the other server to use. */
  host: 'localhost' | 'ip';
  scheme?: 'ws';
  run(c: { sw: Worker; page: Page; url: string }): Promise<void>;
}

const CONTROLS: Control[] = [
  { name: 'fetch from the service worker', path: '/ctl/sw-fetch', host: 'localhost', run: ({ sw, url }) => sw.evaluate((u) => fetch(u, { mode: 'no-cors' }).then(() => undefined), url) },
  { name: 'fetch from an extension page', path: '/ctl/page-fetch', host: 'localhost', run: ({ page, url }) => page.evaluate((u) => fetch(u, { mode: 'no-cors' }).then(() => undefined), url) },
  {
    name: 'XMLHttpRequest from an extension page',
    path: '/ctl/page-xhr',
    host: 'localhost',
    run: ({ page, url }) =>
      page.evaluate(
        (u) =>
          new Promise<void>((resolve) => {
            const x = new XMLHttpRequest();
            x.open('GET', u);
            x.onloadend = () => resolve();
            x.send();
          }),
        url,
      ),
  },
  {
    name: 'image loaded by an extension page',
    path: '/ctl/page-image',
    host: 'localhost',
    run: ({ page, url }) =>
      page.evaluate(
        (u) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = img.onerror = () => resolve();
            img.src = u;
          }),
        url,
      ),
  },
  {
    name: 'frame inside an extension page',
    path: '/ctl/page-frame',
    host: 'localhost',
    run: ({ page, url }) =>
      page.evaluate(
        (u) =>
          new Promise<void>((resolve) => {
            const frame = document.createElement('iframe');
            frame.onload = () => resolve();
            frame.src = u;
            document.body.append(frame);
          }),
        url,
      ),
  },
  {
    name: 'web socket opened by an extension page',
    path: '/ctl/page-websocket',
    host: 'localhost',
    scheme: 'ws',
    run: ({ page, url }) =>
      page.evaluate((u) => {
        new WebSocket(u);
      }, url),
  },
  { name: 'beacon sent by an extension page', path: '/ctl/page-beacon', host: 'localhost', run: ({ page, url }) => page.evaluate((u) => void navigator.sendBeacon(u, 'x'), url) },
  { name: 'tab opened with chrome.tabs.create', path: '/ctl/tabs-create', host: 'localhost', run: ({ sw, url }) => sw.evaluate((u) => (globalThis as unknown as Chrome).chrome.tabs.create({ url: u }).then(() => undefined), url) },
  { name: 'window.open from an extension page', path: '/ctl/window-open', host: 'localhost', run: ({ page, url }) => page.evaluate((u) => void window.open(u), url) },
  { name: 'fetch to the same machine under another port', path: '/ctl/sw-fetch-ip', host: 'ip', run: ({ sw, url }) => sw.evaluate((u) => fetch(u, { mode: 'no-cors' }).then(() => undefined), url) },
];
