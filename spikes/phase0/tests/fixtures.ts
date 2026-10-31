import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { record, RESULTS_DIR } from './record';
import { startServer } from './server.mjs';

/** The built extension that every launch loads (`pnpm -C spikes/phase0 build`). */
export const EXTENSION_DIR = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url));
/** Used only when Playwright cannot resolve its own Chromium build. Never the headless shell. */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

export type SpikeQuery = Record<string, string | number>;
export interface SpikeServer {
  origin: string;
  url(p: string): string;
}
export interface LaunchOptions {
  /** Write a Chromium net log to results/netlog-<test>.json. */
  netlog?: boolean;
  /** Reuse the user-data dir results/profiles/<profile> (kept across launches); default: a fresh temp dir. */
  profile?: string;
  /** Open spike.html?check=<check> and wait until that check's module has loaded. */
  check?: string;
}
export interface SpikeSession {
  context: BrowserContext;
  page: Page;
  netlogPath: string;
  openSpike(q: SpikeQuery, o?: { timeout?: number }): Promise<any>;
}

interface Fixtures {
  server: SpikeServer;
  /** Opens spike.html?<q> in the test's browser (launched on first use) and resolves window.__result. */
  spikePage(q: SpikeQuery, o?: { timeout?: number }): Promise<any>;
  launchSpike(o: LaunchOptions): Promise<SpikeSession>;
  /** Results of every spike page opened in this test, for the failure record. */
  _spikeResults: unknown[];
  /** Writes a FAIL entry for a failed `P0-<n>…` test, so a failing check still gets a report row. */
  _recordFailure: void;
}

const DEFAULT_TIMEOUT = 60_000;
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80);
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

export const test = base.extend<Fixtures>({
  _spikeResults: async ({}, use) => {
    await use([]);
  },

  _recordFailure: [
    async ({ _spikeResults }, use, testInfo) => {
      await use();
      const id = /^(P0-\d+)/.exec(testInfo.title)?.[1] as `P0-${number}` | undefined;
      if (!id || testInfo.status === testInfo.expectedStatus) return;
      const error = stripAnsi(testInfo.error?.message ?? testInfo.status ?? 'failed')
        .split('\n')
        .filter((line) => line.trim() && !/^\s*at /.test(line));
      const last = _spikeResults.at(-1);
      await record(id, {
        pass: false,
        measured: last === undefined ? 'no spike result' : summarise(last),
        note: error.slice(0, 3).join(' ').slice(0, 300),
      });
    },
    { auto: true },
  ],

  server: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.close();
  },

  launchSpike: async ({ viewport, deviceScaleFactor, _spikeResults }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    const tempDirs: string[] = [];
    let launches = 0;

    await use(async (o: LaunchOptions) => {
      launches++;
      let userDataDir: string;
      if (o.profile) {
        userDataDir = join(RESULTS_DIR, 'profiles', o.profile);
        await mkdir(userDataDir, { recursive: true });
      } else {
        userDataDir = await mkdtemp(join(tmpdir(), 'sop-spike-'));
        tempDirs.push(userDataDir);
      }
      const netlogPath = join(RESULTS_DIR, `netlog-${slug(testInfo.title)}${launches > 1 ? `-${launches}` : ''}.json`);
      const args = [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`];
      if (o.netlog) {
        await mkdir(RESULTS_DIR, { recursive: true });
        args.push(`--log-net-log=${netlogPath}`);
      }
      const executablePath =
        !existsSync(chromium.executablePath()) && existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium', // the full build in new headless mode, which loads extensions
        headless: true,
        viewport,
        deviceScaleFactor,
        args,
        ...(executablePath ? { executablePath } : {}),
      });
      contexts.push(context);

      const isExtensionWorker = (w: { url(): string }) => w.url().startsWith('chrome-extension://');
      const worker =
        context.serviceWorkers().find(isExtensionWorker) ??
        (await context.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: 10_000 }).catch(() => null));
      if (!worker) {
        await context.close();
        throw new Error('extension did not load');
      }
      const extensionId = new URL(worker.url()).host;

      const page = context.pages()[0] ?? (await context.newPage());
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));

      const spikeUrl = (q: SpikeQuery) =>
        `chrome-extension://${extensionId}/spike.html?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`;

      // Waits for `flag` (or a runner error) on the spike page and returns its value.
      const waitFor = async (flag: '__result' | '__spikeReady', timeout: number) => {
        try {
          await page.waitForFunction(
            (f) => (window as any)[f] !== undefined || (window as any).__spikeError !== undefined,
            flag,
            { timeout, polling: 100 },
          );
        } catch {
          throw new Error(`window.${flag} was never set within ${timeout} ms${problems.length ? ` (${problems.join('; ')})` : ''}`);
        }
        const spikeError = await page.evaluate(() => (window as any).__spikeError);
        if (spikeError !== undefined) throw new Error(`spike page error: ${spikeError}`);
        return page.evaluate((f) => (window as any)[f], flag);
      };

      const openSpike = async (q: SpikeQuery, opts: { timeout?: number } = {}) => {
        await page.goto(spikeUrl(q));
        const result = await waitFor('__result', opts.timeout ?? DEFAULT_TIMEOUT);
        _spikeResults.push(result);
        return result;
      };

      if (o.check) {
        await page.goto(spikeUrl({ check: o.check }));
        await waitFor('__spikeReady', DEFAULT_TIMEOUT);
      }
      return { context, page, netlogPath, openSpike };
    });

    for (const context of contexts) await context.close();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  },

  spikePage: async ({ launchSpike }, use) => {
    let session: SpikeSession | undefined;
    await use(async (q, o) => {
      session ??= await launchSpike({});
      return session.openSpike(q, o);
    });
  },
});

/** One line for a failure record: scalar fields as they are, arrays and objects by size. */
function summarise(result: unknown): string {
  if (result === null || typeof result !== 'object') return String(result);
  return Object.entries(result)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}=[${v.length}]`;
      if (v && typeof v === 'object') return `${k}={…}`;
      return `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`;
    })
    .join(', ')
    .slice(0, 400);
}
