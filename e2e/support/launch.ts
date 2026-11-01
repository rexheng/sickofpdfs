import { existsSync } from 'node:fs';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** `pnpm e2e` builds the extension here with `wxt build --mode test`; every spec loads this folder. */
export const TEST_BUILD_DIR = fileURLToPath(new URL('../../apps/extension/.output/chrome-mv3-test', import.meta.url));
/** `pnpm build` writes the production build here. It never touches TEST_BUILD_DIR. */
export const PROD_BUILD_DIR = fileURLToPath(new URL('../../apps/extension/.output/chrome-mv3', import.meta.url));

/** Used only when Playwright cannot resolve its own Chromium build. Never the headless shell, which loads no extension. */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

export interface LaunchOptions {
  /** The profile folder to run in. It is used in place, so pass a copy if the original must stay as it is. */
  userDataDir: string;
  /** Where Chromium writes its net log, for the network gate (`netlog.ts`). Omit for no net log. */
  netlogPath?: string;
  viewport?: { width: number; height: number } | null;
  deviceScaleFactor?: number;
  /** The unpacked extension to load. Default: the test build. */
  extensionDir?: string;
}

/**
 * A persistent context in the full Chromium build (`channel: 'chromium'`, new headless mode, which loads extensions)
 * with the extension loaded and a net log written. The switches below only quiet Chromium's own background
 * chatter; the network gate counts what the extension does, and the net log records the rest separately.
 */
export async function launchExtension(o: LaunchOptions): Promise<BrowserContext> {
  const extensionDir = o.extensionDir ?? TEST_BUILD_DIR;
  if (!existsSync(`${extensionDir}/manifest.json`)) throw new Error(`no extension build in ${extensionDir}; run "pnpm e2e" (it builds first)`);
  const executablePath = !existsSync(chromium.executablePath()) && existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;
  return chromium.launchPersistentContext(o.userDataDir, {
    channel: 'chromium',
    headless: true,
    ...(o.viewport !== undefined ? { viewport: o.viewport } : {}),
    ...(o.deviceScaleFactor !== undefined ? { deviceScaleFactor: o.deviceScaleFactor } : {}),
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      ...(o.netlogPath ? [`--log-net-log=${o.netlogPath}`] : []),
      '--disable-component-update',
      '--no-pings',
      '--disable-domain-reliability',
    ],
    ...(executablePath ? { executablePath } : {}),
  });
}

const isExtensionWorker = (w: Worker) => w.url().startsWith('chrome-extension://');

/** The extension's service worker. Waits up to `timeout` ms for it and throws "extension did not load" otherwise. */
export async function waitForExtensionWorker(context: BrowserContext, timeout = 10_000): Promise<Worker> {
  const existing = context.serviceWorkers().find(isExtensionWorker);
  if (existing) return existing;
  const started = await context.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout }).catch(() => null);
  if (!started) throw new Error('extension did not load');
  return started;
}
