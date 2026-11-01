import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { record, recordedBy, RESULTS_DIR } from './record';
import { startServer } from './server.mjs';
import type { TextlayerFixture } from './textlayer-fixtures';

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

export interface CharRange {
  pageIndex: number;
  start: number;
  /** Exclusive. */
  end: number;
}
export interface TextlayerAlignment {
  maxEdgeErrorPx: number;
  p99EdgeErrorPx: number;
  minVerticalOverlap: number;
  /** Chars measured: rendered, non-generated, with a non-empty PDFium box. */
  chars: number;
  worst: string;
}
/** One PDF page in the textlayer check (src/checks/textlayer.ts), driven with the real mouse. */
export interface TextlayerPage {
  /** The check's result: counts, timings, layout and `endpoints`. */
  info: any;
  /** The first and last glyph a drag may start or end on (see `endpoints` in the check). */
  firstGlyph: number;
  lastGlyph: number;
  /** n pairs of drag endpoints, the same for every zoom of a fixture: half anywhere on the page, half within 40 glyphs. */
  seededPairs(n: number): [number, number][];
  /** Clears the selection, then mouse down at glyph a's centre, moves in 8 steps and releases at glyph b's centre. */
  dragSelect(a: number, b: number): Promise<{ ranges: CharRange[]; domText: string }>;
  /** PDFium's text for the char range (getTextRange: FPDFText_GetText via getTextSlices). */
  textRange(start: number, count: number): Promise<string>;
  alignment(): Promise<TextlayerAlignment>;
  /** The text of a selection of the whole text layer (Selection.toString()). */
  selectAllText(): Promise<string>;
  /** dragSelect from the middle of column 1's bottom line to the middle of column 2's top line; domText has whitespace collapsed. */
  dragColumns(): Promise<{ ranges: CharRange[]; domText: string }>;
  /** The dir attribute of every span in the text layer. */
  runDirs(): Promise<string[]>;
}

export interface ObjectsPageOptions {
  detect?: boolean;
  textRuns?: boolean;
  /** Paper names (file names without .pdf in fixtures/out/classifier/learning/) to time detection on. */
  timing?: string[];
  /** With `timing`: how many pages of each paper, from the first. */
  pages?: number;
}

interface Fixtures {
  server: SpikeServer;
  /** Opens spike.html?<q> in the test's browser (launched on first use) and resolves window.__result. */
  spikePage(q: SpikeQuery, o?: { timeout?: number }): Promise<any>;
  /**
   * Saves a PNG of the page spikePage opened last, as results/<file>: the element `selector`, or `clip` in
   * client px. The viewport first grows to hold the whole document, so nothing is cut off. Returns the path.
   */
  spikeScreenshot(file: string, target: { selector: string } | { clip: { x: number; y: number; width: number; height: number } }): Promise<string>;
  launchSpike(o: LaunchOptions): Promise<SpikeSession>;
  /** Opens `f`'s page at `zoom` (1 = 100% = 96/72 CSS px per pt) in the textlayer check; the viewport is resized to fit it. */
  textlayerPage(f: TextlayerFixture, zoom: number): Promise<TextlayerPage>;
  /**
   * The objects check (src/checks/objects.ts, P0-10) on page `pageIndex` of fixtures/out/<file>: the page is drawn
   * first, then its page objects (`objects`, `truncated`, `elapsedMs`) and structure tree (`struct`) are read;
   * `textRuns` adds `runs` (getPageTextRuns) and `detect` adds `figures` (detectFigures). With file 'papers' and
   * `timing` (names in fixtures/out/classifier/learning/), it times detection on the first `pages` pages of each
   * paper instead: `pages` (one row per page), `p50Ms`, `p95Ms`, `maxMs`, and `resnetPage0Labels`.
   */
  objectsPage(file: string, pageIndex: number, opts?: ObjectsPageOptions): Promise<any>;
  /** The browser that spikePage and spikeScreenshot share, launched on first use. */
  _spikeSession: () => Promise<SpikeSession>;
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
      // A test that recorded its own measurements keeps them; the error is added to its note.
      const own = recordedBy(testInfo.testId);
      await record(id, {
        pass: false,
        measured: own?.measured ?? (last === undefined ? 'no spike result' : summarise(last)),
        note: [own?.note, error.slice(0, 3).join(' ').slice(0, 300)].filter(Boolean).join('; '),
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

  _spikeSession: async ({ launchSpike }, use) => {
    let session: Promise<SpikeSession> | undefined;
    await use(() => (session ??= launchSpike({})));
  },

  spikePage: async ({ _spikeSession }, use) => {
    await use(async (q, o) => (await _spikeSession()).openSpike(q, o));
  },

  spikeScreenshot: async ({ _spikeSession }, use) => {
    await use(async (file, target) => {
      const { page } = await _spikeSession();
      const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
      const viewport = page.viewportSize();
      if (!viewport || size.width > viewport.width || size.height > viewport.height) {
        await page.setViewportSize({ width: Math.max(size.width, viewport?.width ?? 0), height: Math.max(size.height, viewport?.height ?? 0) });
      }
      await mkdir(RESULTS_DIR, { recursive: true });
      const path = join(RESULTS_DIR, file);
      if ('selector' in target) await page.locator(target.selector).screenshot({ path });
      else await page.screenshot({ path, clip: target.clip });
      return path;
    });
  },

  textlayerPage: async ({ launchSpike, server }, use) => {
    let session: SpikeSession | undefined;
    await use(async (f, zoom) => {
      session ??= await launchSpike({});
      const { page } = session;
      const info = await session.openSpike({ check: 'textlayer', file: server.url(f.file), page: f.page, zoom });
      const endpoints: number[] = info.endpoints;
      if (endpoints.length < 2) throw new Error(`${f.name}: fewer than 2 glyphs to drag between`);
      // The whole page must be inside the viewport: the mouse cannot hit what is scrolled away.
      await page.setViewportSize({ width: Math.ceil(info.layout.right + 16), height: Math.ceil(info.layout.bottom + 16) });
      const tl = '__tl';
      const dragSelect = async (a: number, b: number) => {
        await page.evaluate(() => getSelection()?.removeAllRanges());
        const [pa, pb] = await page.evaluate(([k, x, y]) => [(window as any)[k].glyphCenter(x), (window as any)[k].glyphCenter(y)], [tl, a, b] as const);
        await page.mouse.move(pa.x, pa.y);
        await page.mouse.down();
        await page.mouse.move(pb.x, pb.y, { steps: 8 });
        await page.mouse.up();
        return page.evaluate((k) => (window as any)[k].selection(), tl);
      };
      return {
        info,
        firstGlyph: endpoints[0]!,
        lastGlyph: endpoints.at(-1)!,
        seededPairs: (n) => seededPairs(endpoints, n, f.name),
        dragSelect,
        textRange: (start, count) => page.evaluate(([k, s, c]) => (window as any)[k].textRange(s, c), [tl, start, count] as const),
        alignment: () => page.evaluate((k) => (window as any)[k].alignment(), tl),
        selectAllText: () => page.evaluate((k) => (window as any)[k].selectAll(), tl),
        async dragColumns() {
          const t = await page.evaluate((k) => (window as any)[k].columnTargets(), tl);
          if (!t) throw new Error(`${f.name}: no column 1 bottom line or column 2 top line found`);
          const r = await dragSelect(t.a, t.b);
          return { ranges: r.ranges, domText: r.domText.replace(/\s+/g, ' ') };
        },
        runDirs: () => page.evaluate((k) => (window as any)[k].runDirs(), tl),
      };
    });
  },

  objectsPage: async ({ spikePage, server }, use) => {
    await use(async (file, pageIndex, opts = {}) => {
      if (file === 'papers') {
        const names = opts.timing ?? [];
        if (names.length === 0) throw new Error("objectsPage('papers') needs `timing`: the paper names");
        const urls = names.map((n) => server.url(`classifier/learning/${n}.pdf`));
        const r = await spikePage({ check: 'objects', papers: urls.join(','), names: names.join(','), pages: opts.pages ?? 10 }, { timeout: 110_000 });
        const resnet = r.pages.find((p: { name: string; pageIndex: number }) => p.name.includes('resnet') && p.pageIndex === 0);
        return { ...r, resnetPage0Labels: resnet ? resnet.figures.map((f: { label: string | null }) => f.label) : [] };
      }
      return spikePage({ check: 'objects', file: server.url(file), page: pageIndex, detect: opts.detect ? 1 : 0, textRuns: opts.textRuns ? 1 : 0 });
    });
  },
});

/** Deterministic drag endpoints: even pairs anywhere among `glyphs`, odd pairs at most 40 glyphs apart. */
export function seededPairs(glyphs: number[], n: number, seed: string): [number, number][] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let state = h >>> 0;
  const rand = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = () => Math.floor(rand() * glyphs.length);
  const pairs: [number, number][] = [];
  while (pairs.length < n) {
    const i = pick();
    const j = pairs.length % 2 === 0 ? pick() : Math.min(glyphs.length - 1, Math.max(0, i + Math.round((rand() - 0.5) * 80)));
    if (i !== j) pairs.push([glyphs[i]!, glyphs[j]!]);
  }
  return pairs;
}

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
