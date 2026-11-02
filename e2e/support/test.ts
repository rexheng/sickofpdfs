import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { EXTENSION_ID } from '../../apps/extension/scripts/extension-id.mjs';
import { buildViewerUrl, VIEWER_PATH } from '../../apps/extension/src/shared/viewer-url';
import { LOCAL_ONLY_DB, LOCAL_ONLY_STORES } from '../../apps/extension/src/local-only/secrets-store';
import type { SopTestHooks } from '../../apps/extension/src/testing/test-hooks';
import { launchExtension, waitForExtensionWorker } from './launch';
import { isLookupRequest, netlogBrowserServiceHosts, netlogExternalUrls, readNetlogRequests, waitForNetlog } from './netlog';
import { profileTemplates, type ProfileKind } from './seed-profile';
import { startFixtureServer, TEST_ASSETS, type FixtureServer } from './server';

export { expect };
export type { FixtureServer };
export { EXTENSION_ID, VIEWER_PATH };
export { TEST_BUILD_DIR, PROD_BUILD_DIR } from './launch';

/**
 * Copies `test-assets/<name>` to `dest`, making the folders on the way, and returns `dest`. For tests that open local
 * files: pass a path under the `tmp` fixture, and give it whatever name the test needs (spaces, accents, `.PDF`).
 */
export async function copyFixture(name: string, dest: string): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(TEST_ASSETS, name), dest);
  return dest;
}

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
   * `enforce` (default): after the test the browser closes and the net log must hold no external request. That includes arXiv and
   * Crossref: Settings → Online lookups is off until the owner turns it on, so a lookup in a test that did not turn it on is a failure.
   * `lookups`: for a test that turns Online lookups on. The only requests allowed are the lookups' own, to exactly export.arxiv.org and
   * api.crossref.org and carrying an id and nothing else (`isLookupRequest`); anything else fails the test.
   * `observe`: for the gate's own positive controls; the test must call `netgate.report()` and assert on it.
   */
  networkGate: 'enforce' | 'lookups' | 'observe';
}

interface Fixtures {
  context: BrowserContext;
  sw: Worker;
  server: FixtureServer;
  /** A folder of the test's own, removed afterwards. */
  tmp: string;
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

  // eslint-disable-next-line no-empty-pattern -- Playwright needs a destructuring pattern as the first parameter
  tmp: async ({}, provide) => {
    const dir = await mkdtemp(join(tmpdir(), 'sop-tmp-'));
    await provide(dir);
    await rm(dir, { recursive: true, force: true });
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
        await waitForNetlog(netlogPath); // under load the browser can still be writing the log after it has closed
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
      // Ready means the takeover is registered: a PDF opened in the first moments must not race the worker's start-up.
      await worker.evaluate(async () => {
        const deadline = Date.now() + 10_000;
        while (!(await chrome.storage.session.get('takeoverMode')).takeoverMode) {
          if (Date.now() > deadline) throw new Error('the takeover was not registered');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      });
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
    if (networkGate === 'lookups') {
      expect(report.external.filter((u) => !isLookupRequest(u)), 'requests to anything but an id-only lookup of arXiv or Crossref').toEqual([]);
      return;
    }
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

// ---- Task 21: scrolling and ink helpers ----

/**
 * Scrolls the viewer's page list (`[role=document]`) down by `pxPerSec / 60` CSS px in every animation frame for
 * `seconds`, inside the page (as a steady wheel or trackpad scroll would), and resolves when done.
 */
export async function steadyScroll(page: Page, o: { pxPerSec: number; seconds: number }): Promise<void> {
  await page.evaluate(
    ({ pxPerSec, seconds }) =>
      new Promise<void>((resolve, reject) => {
        const el = document.querySelector<HTMLElement>('[role=document]');
        if (!el) return reject(new Error('steadyScroll: no [role=document] element'));
        let start: number | undefined;
        let position = el.scrollTop;
        const frame = (now: number) => {
          start ??= now;
          if (now - start >= seconds * 1000) return resolve();
          position += pxPerSec / 60;
          el.scrollTop = position;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    o,
  );
}

/**
 * The bounding box of the dark pixels (luminance < 128, alpha ≥ 128) of the first canvas matching `canvasSelector`,
 * as fractions of the canvas bitmap: { left, top, width, height }, all 0 when nothing is dark. The canvas is copied
 * with createImageBitmap, so this works for 2d and bitmaprenderer canvases alike.
 */
export async function inkBox(page: Page, canvasSelector: string): Promise<{ left: number; top: number; width: number; height: number }> {
  return page.evaluate(async (sel) => {
    const canvas = document.querySelector<HTMLCanvasElement>(sel);
    if (!canvas) throw new Error(`inkBox: nothing matches ${sel}`);
    const bitmap = await createImageBitmap(canvas);
    const { width: w, height: h } = bitmap;
    const copy = new OffscreenCanvas(w, h);
    const ctx = copy.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, w, h).data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (data[o + 3] < 128 || 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] >= 128) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return { left: 0, top: 0, width: 0, height: 0 };
    return { left: x0 / w, top: y0 / h, width: (x1 - x0 + 1) / w, height: (y1 - y0 + 1) / h };
  }, canvasSelector);
}

/** The first element matching `sel`: its box in CSS px (x, y from the viewport's top-left). Fails if there is none. */
export async function box(page: Page, sel: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.locator(sel).first().boundingBox();
  if (b === null) throw new Error(`box: nothing visible matches ${sel}`);
  return b;
}

/** The first element matching `sel`: its computed style, keyed as in CSSStyleDeclaration (`backgroundColor`). */
export async function css(page: Page, sel: string): Promise<Record<string, string>> {
  return page
    .locator(sel)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const name of Array.from(style)) out[name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = style.getPropertyValue(name);
      return out;
    });
}

/** Opens a header menu ("File") and chooses an item in it ("Copy link"), as a person would with the mouse. */
export async function clickMenu(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).click();
  const open = page.getByRole('menu');
  await open.getByRole('menuitem', { name: item, exact: true }).or(open.getByRole('menuitemcheckbox', { name: item, exact: true })).click();
}

/** A file's SHA-256, as lower-case hex. */
export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

// ---- Task 29: where a secret may and may not be found ----

/**
 * True when some file under the OPFS folder `dir` (from the origin's OPFS root, searched recursively) contains `needle`
 * as UTF-8 or UTF-16 text. Runs in `page`, so it sees that page's origin. It reads files in slices, so a large database
 * does not fill memory. Throws when the folder does not exist or a file cannot be read (for the SQLite files, close the
 * offscreen document first so it lets go of them): a search that could not look must not pass as "not found".
 */
export async function grepOpfs(page: Page, dir: string, needle: string): Promise<boolean> {
  return page.evaluate(
    async ({ dir, needle }) => {
      let folder = await navigator.storage.getDirectory();
      for (const part of dir.split('/').filter(Boolean)) {
        folder = await folder.getDirectoryHandle(part).catch(() => {
          throw new Error(`grepOpfs: there is no OPFS folder "${dir}"`);
        });
      }
      const patterns = [new TextEncoder().encode(needle), new Uint8Array(new Uint16Array(Array.from(needle, (c) => c.charCodeAt(0))).buffer)];
      const SLICE = 4 << 20;
      const find = (hay: Uint8Array, pattern: Uint8Array): boolean => {
        outer: for (let i = 0; i + pattern.length <= hay.length; i++) {
          if (hay[i] !== pattern[0]) continue;
          for (let j = 1; j < pattern.length; j++) if (hay[i + j] !== pattern[j]) continue outer;
          return true;
        }
        return false;
      };
      const overlap = Math.max(...patterns.map((p) => p.length)) - 1;
      const scan = async (file: File): Promise<boolean> => {
        for (let at = 0; at < file.size; at += SLICE) {
          const from = Math.max(0, at - overlap);
          const bytes = new Uint8Array(await file.slice(from, Math.min(file.size, at + SLICE)).arrayBuffer());
          if (patterns.some((p) => find(bytes, p))) return true;
        }
        return false;
      };
      const walk = async (d: FileSystemDirectoryHandle): Promise<boolean> => {
        for await (const handle of d.values()) {
          if (handle.kind === 'directory' ? await walk(handle) : await scan(await handle.getFile())) return true;
        }
        return false;
      };
      return walk(folder);
    },
    { dir, needle },
  );
}

/**
 * The files under the OPFS folder `dir` of `page`'s origin (from the OPFS root, searched recursively), as paths from that
 * root and sorted: `opfsList(page, 'pdf')` gives `['pdf/ab/ab12….pdf']` for one stored PDF (blob-store.ts's layout).
 * A folder that does not exist holds no files: `[]`.
 */
export async function opfsList(page: Page, dir: string): Promise<string[]> {
  return page.evaluate(async (dir) => {
    const parts = dir.split('/').filter(Boolean);
    let folder = await navigator.storage.getDirectory();
    for (const part of parts) {
      try {
        folder = await folder.getDirectoryHandle(part);
      } catch {
        return [];
      }
    }
    const out: string[] = [];
    const walk = async (d: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const handle of d.values()) {
        const path = `${prefix}/${handle.name}`;
        if (handle.kind === 'directory') await walk(handle, path);
        else out.push(path);
      }
    };
    await walk(folder, parts.join('/'));
    return out.map((p) => p.replace(/^\//, '')).sort();
  }, dir);
}

/** What `probeIdb` found. */
export interface IdbProbe {
  existed: boolean;
  stores: string[];
  containsNeedle: boolean;
}

/**
 * Looks at the IndexedDB database `name` of `page`'s origin without creating it: it opens the database with no version,
 * and if that would create it, aborts, so the database stays absent (`existed: false`). Otherwise it lists the object
 * stores and scans every key and value (strings, bytes, nested objects) for `needle`.
 */
export async function probeIdb(page: Page, name: string, needle: string): Promise<IdbProbe> {
  return page.evaluate(
    ({ name, needle }) =>
      new Promise<IdbProbe>((resolve, reject) => {
        const bytesOf = (v: ArrayBufferView | ArrayBuffer) => new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer, v instanceof ArrayBuffer ? 0 : v.byteOffset, v instanceof ArrayBuffer ? undefined : v.byteLength);
        const contains = (value: unknown, depth = 0): boolean => {
          if (typeof value === 'string') return value.includes(needle);
          if (value === null || typeof value !== 'object' || depth > 8) return false;
          if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const text = new TextDecoder('utf-8').decode(bytesOf(value));
            return text.includes(needle);
          }
          const entries = value instanceof Map ? [...value.entries()].flat() : value instanceof Set ? [...value] : Object.entries(value).flat();
          return entries.some((v) => contains(v, depth + 1));
        };
        const request = indexedDB.open(name);
        let created = false;
        request.onupgradeneeded = (event) => {
          if (event.oldVersion === 0) {
            created = true;
            request.transaction?.abort(); // nothing is created
          }
        };
        request.onerror = () => {
          if (created) resolve({ existed: false, stores: [], containsNeedle: false });
          else reject(request.error ?? new Error('probeIdb: the database did not open'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const stores = Array.from(db.objectStoreNames).sort();
          if (stores.length === 0) {
            db.close();
            return resolve({ existed: true, stores, containsNeedle: false });
          }
          let found = false;
          const tx = db.transaction(stores, 'readonly');
          for (const store of stores) {
            const cursor = tx.objectStore(store).openCursor();
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (!c) return;
              if (contains(c.key) || contains(c.value)) found = true;
              c.continue();
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve({ existed: true, stores, containsNeedle: found });
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error ?? new Error('probeIdb: could not read the database'));
          };
        };
      }),
    { name, needle },
  );
}

/**
 * Writes `{ name: 'anthropic_api_key', value }` into the `secrets` store of `sop-local` in `page`'s origin, creating the
 * database as the secrets store does (the same object stores, from LOCAL_ONLY_STORES). It is test code: the viewer's
 * test hooks never touch the store. Never log `value`.
 */
export async function seedSecret(page: Page, value: string): Promise<void> {
  await page.evaluate(
    ({ db: dbName, stores, value }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          for (const { name, options } of stores) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, options);
        };
        request.onerror = () => reject(request.error ?? new Error('seedSecret: the database did not open'));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('secrets', 'readwrite');
          tx.objectStore('secrets').put({ name: 'anthropic_api_key', value });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error('seedSecret: the write failed'));
        };
      }),
    { db: LOCAL_ONLY_DB, stores: LOCAL_ONLY_STORES, value },
  );
}
