// Helpers for the spec-blind Task 12 tests. They use only what the interface file publishes
// (TEST_BUILD_DIR, PROD_BUILD_DIR, EXTENSION_ID, buildViewerUrl, startFixtureServer, netlogExternalUrls),
// so they can start their own Chromium with a net log, which the shared `test` fixtures do not expose.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { REPO_ROOT } from './sample-pdf.spec-blind';

/** Used only when Playwright cannot resolve its own Chromium build (same fallback the Phase 0 spike used). */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

export interface RawRun {
  context: BrowserContext;
  sw: Worker;
  extensionId: string;
  /** Chromium net log; complete only after close(). Empty path when the run had no net log. */
  netlogPath: string;
  /** Closes the browser (this flushes the net log). */
  close(): Promise<void>;
  /** Closes the browser and deletes the profile and net log. */
  dispose(): Promise<void>;
}

/** Launches Chromium with the unpacked extension in `extensionDir`, optionally writing a net log. */
export async function launchRaw(extensionDir: string, o: { netlog?: boolean } = {}): Promise<RawRun> {
  const workDir = await mkdtemp(join(tmpdir(), 'sop-t12-'));
  const netlogPath = o.netlog ? join(workDir, 'netlog.json') : '';
  const args = [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
  if (o.netlog) args.push(`--log-net-log=${netlogPath}`);
  const executablePath = !existsSync(chromium.executablePath()) && existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;
  const context = await chromium.launchPersistentContext(join(workDir, 'profile'), {
    channel: 'chromium', // the full build in new headless mode, which loads extensions
    headless: true,
    viewport: { width: 1280, height: 800 },
    args,
    ...(executablePath ? { executablePath } : {}),
  });
  const isExtensionWorker = (w: { url(): string }) => w.url().startsWith('chrome-extension://');
  const sw =
    context.serviceWorkers().find(isExtensionWorker) ??
    (await context.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: 15_000 }).catch(() => null));
  if (!sw) {
    await context.close();
    await rm(workDir, { recursive: true, force: true });
    throw new Error(`the extension in ${extensionDir} did not start a service worker`);
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await context.close();
  };
  return {
    context,
    sw,
    extensionId: new URL(sw.url()).host,
    netlogPath,
    close,
    dispose: async () => {
      await close();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

/** Builds the extension if `<dir>/manifest.json` is missing (`pnpm e2e` builds the test build itself). */
export function ensureBuilt(dir: string, script: 'build' | 'build:e2e'): void {
  if (existsSync(join(dir, 'manifest.json'))) return;
  const run = spawnSync('pnpm', ['-C', 'apps/extension', script], { cwd: REPO_ROOT, stdio: 'inherit', timeout: 5 * 60_000 });
  if (run.status !== 0 || !existsSync(join(dir, 'manifest.json'))) {
    throw new Error(`pnpm -C apps/extension ${script} did not produce ${dir}/manifest.json (exit ${String(run.status)})`);
  }
}

export interface CountingServer {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** http://localhost:<port>: another host string for the same server. */
  localhostOrigin: string;
  /** How many requests (HTTP or WebSocket handshakes) arrived for this path (query string left out). */
  count(path: string): number;
  /** Resolves once `path` has been requested; rejects after `timeoutMs`. */
  waitFor(path: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * A server that answers everything with 200 and counts requests by path. It is the "somewhere else on the
 * internet" for the network-gate controls: the extension must never talk to it.
 */
export async function startCountingServer(): Promise<CountingServer> {
  const hits = new Map<string, number>();
  const note = (rawUrl: string | undefined) => {
    const path = new URL(rawUrl ?? '/', 'http://x').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
  };
  const server = http.createServer((req, res) => {
    note(req.url);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>elsewhere</title><p>elsewhere</p>');
  });
  server.on('upgrade', (req, socket) => {
    note(req.url);
    socket.destroy(); // the handshake request is what the gate has to see
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const count = (path: string) => hits.get(path) ?? 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    localhostOrigin: `http://localhost:${port}`,
    count,
    async waitFor(path, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (count(path) === 0) {
        if (Date.now() > deadline) throw new Error(`${path} was never requested within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
