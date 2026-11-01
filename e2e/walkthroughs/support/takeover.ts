import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import { parseViewerUrl, type ViewerParams } from '../../../apps/extension/src/shared/viewer-url';
import { REPO_ROOT } from '../../support/launch';
import { EXTENSION_ID, VIEWER_ROOT, expect, test as harness } from '../../support/test';
import { startSite, type Site } from './site';

// Shared by the takeover walkthroughs (PDF links, local files, embedded PDFs, the escape hatch, privacy).
// What "the owner sees" is the tab's address and the controls on the page, because the viewer is still a stub.

/** Our viewer's address, up to the query. */
export const OUR_VIEWER = `chrome-extension://${EXTENSION_ID}/viewer.html`;
/** The id of Chromium's built-in PDF viewer extension. Its page is what Chrome's own viewer looks like to Playwright. */
export const CHROME_PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

export const isOurViewer = (url: string): boolean => url.startsWith(OUR_VIEWER);
export const OUR_VIEWER_RE = new RegExp(`^${OUR_VIEWER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);

/** The address as Chrome writes it, so that two spellings of one address compare equal. */
export const normalize = (url: string | null): string | null => (url === null ? null : new URL(url).href);

export const viewerParams = (page: Page): ViewerParams => parseViewerUrl(page.url());

/** The last part of the address, decoded: the name a person would call the file. */
export function fileNameOf(url: string): string {
  const path = new URL(url).pathname;
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * Opens `url` in `page` the way a click or a typed address does. A takeover or a download interrupts the navigation
 * Playwright started, which it reports as an error; the test then looks at where the tab ended up.
 */
export async function visit(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (/ERR_ABORTED|interrupted by another navigation|Download is starting/i.test(error instanceof Error ? error.message : '')) return;
    throw error;
  }
}

/** Clicks a link whose navigation a takeover may turn into another one, which Playwright reports as an error. */
export async function clickLink(link: Locator): Promise<void> {
  await link.click().catch((error: unknown) => {
    if (!/ERR_ABORTED|interrupted by another navigation/i.test(error instanceof Error ? error.message : '')) throw error;
  });
}

/** The addresses the tab's main frame has committed, in order. Start it before the first visit. */
export function trackNavigations(page: Page): { urls: string[]; ourViewerVisits: () => number } {
  const urls: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });
  return { urls, ourViewerVisits: () => urls.filter(isOurViewer).length };
}

/** Waits `ms`, to see that nothing moves: a takeover that fires late, or a tab that bounces back. */
export const quietFor = (page: Page, ms = 2000): Promise<void> => page.waitForTimeout(ms);

/**
 * The tab shows our viewer for `source`. Checks the address (the original link is in it, as the viewer's
 * address form says), that the file's name is what the link says, and that the viewer page has started.
 */
export async function expectOurViewer(page: Page, source: string, want: { back?: string | null; page?: number | null } = {}): Promise<void> {
  await expect.poll(() => page.url(), { message: 'the tab should be showing our viewer', timeout: 10_000 }).toMatch(OUR_VIEWER_RE);
  const got = viewerParams(page);
  expect(normalize(got.source), 'the viewer address carries the original link').toBe(normalize(source));
  expect(fileNameOf(got.source ?? ''), 'the file name').toBe(fileNameOf(source));
  if ('back' in want) expect(normalize(got.back), 'the page to go back to').toBe(normalize(want.back ?? null));
  if ('page' in want) expect(got.page, 'the page to open at').toBe(want.page ?? null);
  await page.waitForSelector(VIEWER_ROOT, { state: 'attached', timeout: 10_000 });
}

/** The tab shows `url` in Chrome's own PDF viewer: its address is the PDF's own, and Chrome's viewer is on the page. */
export async function expectChromesOwnViewer(page: Page, url: string): Promise<void> {
  await expect.poll(() => page.url(), { message: "the tab should be on the PDF's own address", timeout: 10_000 }).toBe(normalize(url));
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(CHROME_PDF_VIEWER)), { message: "Chrome's own PDF viewer should be on the page", timeout: 10_000 })
    .toBe(true);
}

/** A screenshot at a key moment, saved under test-results/ and attached to the report. */
const shots = new WeakMap<TestInfo, number>();
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const n = (shots.get(testInfo) ?? 0) + 1;
  shots.set(testInfo, n);
  const path = testInfo.outputPath(`${String(n).padStart(2, '0')}-${name}.png`);
  try {
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  } catch {
    // a screenshot is evidence, not a check: a page that is mid-navigation cannot be shot
  }
}

// ---- controls the owner sees ----

/** "Back to page" (Task 17: a text button with an arrow). Matched by what a person reads. */
export const backToPage = (page: Page): Locator => page.getByRole('button', { name: /back to page/i }).or(page.getByRole('link', { name: /back to page/i }));

/**
 * The way to switch file access on, shown when a local PDF cannot be read yet: a button or a link whose name talks
 * about file access, turning it on, or the extension's settings (a person reads any of these as the way).
 */
export const fileAccessControl = (page: Page): Locator => {
  const name = /file|access|turn on|switch on|allow|enable|settings/i;
  return page.getByRole('button', { name }).or(page.getByRole('link', { name }));
};

/** Sends the extension a message, as the viewer's own code does. */
export async function sendRuntimeMessage<T = unknown>(page: Page, message: { type: string; [key: string]: unknown }): Promise<T> {
  const reply: unknown = await page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  return reply as T;
}

/**
 * The owner uses "Open in Chrome's viewer". If the viewer shows it (a button or link, or a menu item under "File"),
 * it is clicked; the viewer in this slice is still a stub, so otherwise the message that control sends is sent.
 */
export async function openInChromesViewer(viewer: Page, url: string, testInfo: TestInfo): Promise<void> {
  const label = /open in chrome/i;
  const control = viewer.getByRole('button', { name: label }).or(viewer.getByRole('menuitem', { name: label })).or(viewer.getByRole('link', { name: label }));
  const fileMenu = viewer.getByRole('button', { name: /^file$/i });
  if (!(await control.first().isVisible()) && (await fileMenu.first().isVisible())) await fileMenu.first().click();
  if (await control.first().isVisible()) {
    await control.first().click();
    return;
  }
  testInfo.annotations.push({ type: 'escape hatch', description: "no visible 'Open in Chrome's viewer' control yet: sent takeover:open-in-chrome instead" });
  await sendRuntimeMessage(viewer, { type: 'takeover:open-in-chrome', url }).catch(() => {}); // the tab leaves, so the reply may never come
}

/** The first tab (new or not) whose address is the extension's page on chrome://extensions. */
export async function findExtensionSettingsTab(context: BrowserContext, timeout = 10_000): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = context.pages().find((p) => p.url().startsWith('chrome://extensions') && p.url().includes(EXTENSION_ID));
        return found !== undefined;
      },
      { message: `a tab on chrome://extensions/?id=${EXTENSION_ID} should open`, timeout },
    )
    .toBe(true);
  return found!;
}

// ---- files ----

/** A copy of the 50-page paper under `fileName` in this test's own folder. Returns its path and its `file://` address. */
export async function localPdf(testInfo: TestInfo, fileName: string): Promise<{ path: string; url: string }> {
  const path = join(testInfo.outputPath('local-files'), fileName);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(join(REPO_ROOT, 'test-assets', 'paper-50.pdf'), path);
  return { path, url: pathToFileURL(path).href };
}

// ---- tests that need another origin ----

interface Sites {
  /** A course site at http://localhost:<port>. */
  site: Site;
  /** A file host at http://127.0.0.1:<port>, another origin and another cookie jar from the course site. */
  files: Site;
  /** Runs after the test: nothing but the fixture server and these two sites was contacted. */
  ownOriginsOnly: void;
}

/**
 * The harness `test` plus two extra sites. The network gate still holds: after the test, every request in the net log
 * must be to the fixture server or to one of these two sites (and the log must show the extension's own ping).
 */
export const siteTest = harness.extend<Sites>({
  // the same option the harness declares, with another default (the harness's own declaration is typed as a fixture here)
  networkGate: ['observe', { option: true } as never],
  // eslint-disable-next-line no-empty-pattern -- Playwright needs a destructuring pattern as the first parameter
  site: async ({}, provide) => {
    const site = await startSite('localhost');
    await provide(site);
    await site.close();
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright needs a destructuring pattern as the first parameter
  files: async ({}, provide) => {
    const files = await startSite('127.0.0.1');
    await provide(files);
    await files.close();
  },
  ownOriginsOnly: [
    async ({ netgate, site, files }, provide) => {
      await provide();
      const report = await netgate.report();
      expect(report.recording, "the net log does not show the extension's own ping: the gate is not recording").toBe(true);
      expect(
        report.external.filter((u) => !site.owns(u) && !files.owns(u)),
        'requests to anything but the fixture server and the two test sites',
      ).toEqual([]);
    },
    { auto: true },
  ],
});
