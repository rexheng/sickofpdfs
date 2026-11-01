import { rm } from 'node:fs/promises';
import { expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { EXTENSION_ID } from '../../apps/extension/scripts/extension-id.mjs';
import { buildViewerUrl, VIEWER_PATH } from '../../apps/extension/src/shared/viewer-url';
import type { SopTestHooks } from '../../apps/extension/src/testing/test-hooks';
import { launchExtension, waitForExtensionWorker } from './launch';
import { netlogBrowserServiceHosts, netlogExternalUrls, readNetlogRequests } from './netlog';
import { profileTemplates, type ProfileKind } from './seed-profile';
import { startFixtureServer, type FixtureServer } from './server';

export { expect };
export type { FixtureServer };
export { EXTENSION_ID, VIEWER_PATH };
export { TEST_BUILD_DIR, PROD_BUILD_DIR } from './launch';

/** Every test's browser starts with the service worker fetching this path from the fixture server (see GateReport.recording). */
const GATE_PING = '/__gate-ping';

/** The viewer's root element: `openViewer` waits for it. */
export const VIEWER_ROOT = '#viewer-root';

/** What the network gate saw in one browser run. */
export interface GateReport {
  /** http(s)/ws(s) URLs that anything of ours requested, other than from the fixture server: this must be empty. */
  external: string[];
  /** Hosts Chromium's own services contacted (network time, Gaia, updater, ...); not ours, listed for the record. */
  browserServiceHosts: string[];
  /**
   * True when the net log holds the request the harness sends from the extension's service worker before every test
   * (to the fixture server's `/__gate-ping`), attributed to the extension. It proves the log is recording and that
   * requests made by the extension are attributed to it. Requests for `chrome-extension://` pages are not network
   * requests and never appear in a net log.
   */
  recording: boolean;
}

export interface NetGate {
  netlogPath: string;
  /** Closes the browser (once) and reads its net log. In `networkGate: 'observe'` tests, call this and assert on it yourself. */
  report: () => Promise<GateReport>;
}

interface Options {
  /** `seeded`: file access and Incognito allowed. `bare`: neither (see seed-profile.ts). */
  profile: ProfileKind;
  /**
   * `enforce` (default): after the test the browser closes and the net log must hold no external request.
   * `observe`: for the gate's own positive controls; the test must call `netgate.report()` and assert on it.
   */
  networkGate: 'enforce' | 'observe';
}

interface Fixtures {
  context: BrowserContext;
  sw: Worker;
  server: FixtureServer;
  netgate: NetGate;
  openViewer: (source: string, opts?: { back?: string; page?: number }) => Promise<Page>;
}

interface WorkerFixtures {
  profiles: ReturnType<typeof profileTemplates>;
}

export const test = base.extend<Options & Fixtures, WorkerFixtures>({
  profile: ['seeded', { option: true }],
  networkGate: ['enforce', { option: true }],

  profiles: [
    // eslint-disable-next-line no-empty-pattern -- Playwright needs a destructuring pattern as the first parameter
    async ({}, provide) => {
      const templates = profileTemplates();
      await provide(templates);
      await templates.dispose();
    },
    { scope: 'worker' },
  ],

  // eslint-disable-next-line no-empty-pattern -- Playwright needs a destructuring pattern as the first parameter
  server: async ({}, provide) => {
    const server = await startFixtureServer();
    await provide(server);
    await server.close();
  },

  // Playwright's own `context` fixture is replaced: a persistent Chromium with the test build, a copy of the seeded
  // profile and a net log. The gate runs after the test body.
  context: async ({ profiles, profile, networkGate, server, viewport, deviceScaleFactor }, provide, testInfo) => {
    const userDataDir = await profiles.copy(profile);
    const netlogPath = testInfo.outputPath('netlog.json');
    const context = await launchExtension({
      userDataDir,
      netlogPath,
      viewport,
      ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
    });
    let closing: Promise<GateReport> | undefined;
    const finish = () =>
      (closing ??= (async () => {
        await context.close();
        const requests = await readNetlogRequests(netlogPath);
        return {
          external: await netlogExternalUrls(netlogPath, server.origin),
          browserServiceHosts: await netlogBrowserServiceHosts(netlogPath),
          recording: requests.some((r) => r.url === server.url(GATE_PING) && r.initiator === `chrome-extension://${EXTENSION_ID}` && !r.browserService),
        };
      })());
    let testReadIt = false;
    gates.set(context, {
      netlogPath,
      report: () => {
        testReadIt = true;
        return finish();
      },
    });

    try {
      const worker = await waitForExtensionWorker(context); // fails with "extension did not load"
      await worker.evaluate((u) => fetch(u).then((r) => r.status), server.url(GATE_PING));
    } catch (error) {
      await context.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    await provide(context);

    const report = await finish();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    if (report.browserServiceHosts.length > 0) {
      testInfo.annotations.push({ type: 'not ours: Chromium services contacted', description: report.browserServiceHosts.join(', ') });
    }
    if (networkGate === 'observe') {
      expect(testReadIt, 'networkGate is "observe": the test must call netgate.report() and assert on it').toBe(true);
      return;
    }
    // A gate that recorded nothing would pass on anything.
    expect(report.recording, "the net log does not show the extension's own ping: the gate is not recording").toBe(true);
    expect(report.external, 'requests to anything but the fixture server').toEqual([]);
  },

  netgate: async ({ context }, provide) => {
    await provide(gates.get(context)!);
  },

  sw: async ({ context }, provide) => {
    await provide(await waitForExtensionWorker(context));
  },

  openViewer: async ({ context }, provide) => {
    await provide(async (source, opts = {}) => {
      const url = buildViewerUrl({ source, back: opts.back ?? null, page: opts.page ?? null }, `chrome-extension://${EXTENSION_ID}/${VIEWER_PATH}`);
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForSelector(VIEWER_ROOT, { state: 'attached' });
      return page;
    });
  },
});

const gates = new WeakMap<BrowserContext, NetGate>();

/** Reads the viewer's published runtime (`globalThis.__sopTest`, present in the e2e build only). */
export function hooks(page: Page): { eval: <T, A = undefined>(fn: (h: SopTestHooks, arg: A) => T | Promise<T>, arg?: A) => Promise<T> } {
  return {
    // Sent as source text: Playwright evaluates it over the debugging protocol, which the page's CSP (no eval) does not apply to.
    eval: <T, A = undefined>(fn: (h: SopTestHooks, arg: A) => T | Promise<T>, arg?: A): Promise<T> =>
      page.evaluate<T>(`(${fn.toString()})(globalThis.__sopTest, ${JSON.stringify(arg) ?? 'undefined'})`),
  };
}
