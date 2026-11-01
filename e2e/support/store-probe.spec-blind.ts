// Helpers for the library-store user tests (Task 28 and Task 29). They talk to the viewer the way the interface file says it publishes
// itself: `store` on the test hooks is the connected StoreClient (null in Incognito). Shapes are declared here, not imported, so these tests
// load whether or not the store code exists yet.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { buildViewerUrl } from '../../apps/extension/src/shared/viewer-url';
import { EXTENSION_ID, hooks, VIEWER_PATH } from './test';

export interface DocRow {
  id: string;
  title: string | null;
  authors: string[];
  pageCount: number;
  byteSize: number;
  createdAt: number;
  [key: string]: unknown;
}
export interface PlaceRow {
  id: string;
  documentId: string;
  kind: 'url' | 'file';
  canonical: string;
  raw: string;
  firstSeen: number;
  lastSeen: number;
}
export interface Stats {
  documents: number;
  aliases: number;
  locations: number;
  pageText: number;
  history: number;
  outbox: number;
}
export const ZERO_STATS: Stats = { documents: 0, aliases: 0, locations: 0, pageText: 0, history: 0, outbox: 0 };

export interface SaveInput {
  id: string;
  byteSize: number;
  pageCount: number;
  title: string | null;
  authors: string[];
  pdfId: string | null;
  hasText: boolean;
  encrypted: boolean;
  blobStored: boolean;
  saveReasons: string[];
  location: { kind: 'url' | 'file'; raw: string; viaPage: string | null } | null;
  openedAt: number;
}

type StoreShape = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** Calls one method of the viewer's published store. Rejects with "the viewer has no store" when it is null or missing. */
export function store(page: Page) {
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    hooks(page).eval(
      async (h, a) => {
        const s = (h as unknown as { store?: StoreShape | null }).store;
        if (!s) throw new Error('the viewer has no store');
        return (await s[a.method](...a.args));
      },
      { method, args },
    ) as Promise<T>;
  return {
    call,
    stats: () => call<Stats>('stats'),
    getDocument: (id: string) => call<DocRow | null>('getDocument', id),
    listLocations: (id: string) => call<PlaceRow[]>('listLocations', id),
    saveDocument: (input: SaveInput) => call<{ row: DocRow; created: boolean }>('saveDocument', input),
  };
}

/** Waits until the viewer has published a connected store. */
export async function waitForStore(page: Page, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await hooks(page).eval((h) => {
      const s = (h as unknown as { store?: unknown }).store;
      return s === undefined ? 'missing' : s === null ? 'null' : 'connected';
    });
    if (state === 'connected') return;
    if (Date.now() > deadline) throw new Error(`the viewer never published a connected store (it says: ${state})`);
    await page.waitForTimeout(100);
  }
}

/** Opens the viewer on a PDF address in any context (the `openViewer` fixture only knows the fixture's own context). */
export async function openViewerIn(context: BrowserContext, source: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(buildViewerUrl({ source, back: null, page: null }, `chrome-extension://${EXTENSION_ID}/${VIEWER_PATH}`));
  await page.waitForSelector('#viewer-root', { state: 'attached' });
  return page;
}

/** What the viewer knows about the PDF it opened, shaped like the store's SaveDocumentInput (what the save flow will send). */
export async function inputFor(page: Page, address: string, extra: Partial<SaveInput> = {}): Promise<SaveInput> {
  await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState(): string } }).__sopTest?.viewerState() === 'ready', undefined, { timeout: 20_000 });
  const doc = await hooks(page).eval((h) => {
    const d = (h as unknown as { doc(): { loaded: { size: number; sha256: string; sourceUrl: string | null }; open: { pageCount: number } } | null }).doc();
    return d && { size: d.loaded.size, sha256: d.loaded.sha256, sourceUrl: d.loaded.sourceUrl, pageCount: d.open.pageCount };
  });
  if (!doc) throw new Error('no document is open in the viewer');
  return {
    id: doc.sha256,
    byteSize: doc.size,
    pageCount: doc.pageCount,
    title: 'Spec-blind fixture paper',
    authors: ['A. Author'],
    pdfId: null,
    hasText: true,
    encrypted: false,
    blobStored: false,
    saveReasons: ['spec-blind test'],
    location: { kind: 'url', raw: doc.sourceUrl ?? address, viaPage: null },
    openedAt: Date.now(),
    ...extra,
  };
}

/** The OPFS files (path from the root) whose bytes contain `needle`. Reads every file, the library database's files included. */
export function scanOpfs(page: Page, needle: string): Promise<string[]> {
  return page.evaluate(async (wanted) => {
    const found: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, path: string): Promise<void> => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          await walk(handle, `${path}${name}/`);
          continue;
        }
        try {
          const bytes = await (await (handle).getFile()).arrayBuffer();
          if (new TextDecoder('latin1').decode(bytes).includes(wanted)) found.push(`${path}${name}`);
        } catch {
          // unreadable: not a file anyone could search either
        }
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return found;
  }, needle);
}

/** Sizes of the files the library database keeps under OPFS `.sop-db/`. */
export function libraryFileSizes(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const out: number[] = [];
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('.sop-db').catch(() => null);
    if (!dir) return out;
    const walk = async (d: FileSystemDirectoryHandle): Promise<void> => {
      for await (const [, handle] of d.entries()) {
        if (handle.kind === 'directory') await walk(handle);
        else out.push((await (handle).getFile()).size);
      }
    };
    await walk(dir);
    return out;
  });
}

/** How many hidden (offscreen) pages the extension has right now. */
export function offscreenCount(sw: Worker): Promise<number> {
  return sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
}

/**
 * Asks the service worker for `count` connections to the store in the same instant, and speaks the store protocol on each
 * ({ id, method, args } -> { id, ok, value | error }). Returns each connection's answer to `schemaVersion`.
 */
export function connectTogether(page: Page, count: number): Promise<{ id: number; ok: boolean; value?: unknown; error?: unknown }[]> {
  return hooks(page).eval(async (_h, n) => {
    const ready = await navigator.serviceWorker.ready;
    const ports: MessagePort[] = [];
    for (let i = 0; i < n; i++) {
      const channel = new MessageChannel();
      ports.push(channel.port1);
      ready.active!.postMessage({ type: 'store:connect' }, [channel.port2]);
    }
    return Promise.all(
      ports.map(
        (port, i) =>
          new Promise<{ id: number; ok: boolean; value?: unknown; error?: unknown }>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`connection ${i} never answered`)), 25_000);
            port.onmessage = (e: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: unknown }>) => {
              clearTimeout(timer);
              resolve(e.data);
            };
            port.postMessage({ id: 1, method: 'schemaVersion', args: [] });
          }),
      ),
    );
  }, count);
}
