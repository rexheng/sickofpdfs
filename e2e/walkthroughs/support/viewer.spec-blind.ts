// Helpers for the walkthrough user tests: the `test` with the in-page probe installed, typed access to the viewer's
// published test hooks (the interface file's ViewerRuntime fields), and "what is on screen" measurements.
// Hooks are used for what a person cannot read off the screen (zoom value, scroll offsets, page count, the loaded
// file's hash). Everything about what is SHOWN is measured from the screen or the canvases.
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, freshOutputPath, hooks, test as harnessTest } from '../../support/test';
import { BAR } from './fixtures.spec-blind';
import { decodePng, readAllStrips, type CssRect, type Rgba } from './pixels.spec-blind';
import { installProbe, type BlankReport, type CanvasRead, type Probe } from './probe.spec-blind';

export { expect, hooks };
export type { BlankReport, CanvasRead };

// ---- The hooks, as the interface file declares them -----------------------------------------------------------

export type ViewerState = 'loading' | 'ready' | 'error' | 'bounced';
export type ZoomMode = { kind: 'fit-width' } | { kind: 'fit-page' } | { kind: 'scale'; scale: number };
export interface PageBox {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  rotation: number;
}
export interface Snapshot {
  zoom: ZoomMode;
  scale: number;
  currentPage: number;
  viewRotation: number;
  spread: string;
  darkPages: boolean;
  railOpen: boolean;
}
export interface DocInfo {
  size: number;
  sha256: string;
  displayName: string;
  sourceUrl: string | null;
  pageCount: number;
  pages: { width: number; height: number; rotation: number }[];
  encrypted: boolean;
  password: string | null;
}
interface ViewerHooks {
  scale(): number;
  setScale(s: number): void;
  currentPage(): number;
  scrollTo(pageIndex: number): Promise<void>;
  snapshot(): Snapshot;
  scrollTop(): number;
  maxScrollTop(): number;
  viewportHeight(): number;
  pageBoxes(): PageBox[];
  pdfPointAt(x: number, y: number): { pageIndex: number; x: number; y: number } | null;
  clientPointOf(p: { pageIndex: number; x: number; y: number }): { x: number; y: number };
}
interface AllHooks {
  viewerState(): ViewerState;
  doc(): { loaded: { size: number; sha256: string; displayName: string; sourceUrl: string | null }; open: { pageCount: number; pages: { width: number; height: number; rotation: number }[]; encrypted: boolean }; password: string | null } | null;
  viewer: ViewerHooks;
}

/** The viewer's published runtime, one call each. Values that cannot be read yet come back as null. */
export const rt = (page: Page) => ({
  state: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewerState?.() ?? null),
  doc: (): Promise<DocInfo | null> =>
    hooks(page).eval((h) => {
      const d = (h as unknown as AllHooks).doc?.() ?? null;
      return d === null
        ? null
        : { size: d.loaded.size, sha256: d.loaded.sha256, displayName: d.loaded.displayName, sourceUrl: d.loaded.sourceUrl, pageCount: d.open.pageCount, pages: d.open.pages, encrypted: d.open.encrypted, password: d.password };
    }),
  scale: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewer.scale()),
  setScale: (s: number) => hooks(page).eval((h, v) => (h as unknown as AllHooks).viewer.setScale(v), s),
  currentPage: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewer.currentPage()),
  scrollToPage: (i: number) => hooks(page).eval((h, v) => (h as unknown as AllHooks).viewer.scrollTo(v), i),
  snapshot: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewer.snapshot()),
  scrollTop: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewer.scrollTop()),
  maxScrollTop: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewer.maxScrollTop()),
  viewportHeight: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewer.viewportHeight()),
  pageBoxes: () => hooks(page).eval((h) => (h as unknown as AllHooks).viewer.pageBoxes()),
  pdfPointAt: (x: number, y: number) => hooks(page).eval((h, p) => (h as unknown as AllHooks).viewer.pdfPointAt(p.x, p.y), { x, y }),
  clientPointOf: (p: { pageIndex: number; x: number; y: number }) => hooks(page).eval((h, q) => (h as unknown as AllHooks).viewer.clientPointOf(q), p),
});

// ---- The test, with the probe installed before any page loads --------------------------------------------------

export const test = harnessTest.extend({
  context: async ({ context }, provide) => {
    await context.addInitScript(installProbe, BAR);
    await provide(context);
  },
  // a walkthrough made of steps: each step's own browser gets the probe too
  step: async ({ step }, provide) => {
    await provide((title, body, timeout) =>
      step(
        title,
        async (b) => {
          await b.context.addInitScript(installProbe, BAR);
          await body(b);
        },
        timeout,
      ),
    );
  },
});

export const probe = (page: Page) => ({
  firstInkAt: () => page.evaluate(() => (window as unknown as { __wt: Probe }).__wt.firstInkAt),
  inkNow: () => page.evaluate(() => (window as unknown as { __wt: Probe }).__wt.inkNow()),
  readCanvases: (): Promise<CanvasRead[]> => page.evaluate(() => (window as unknown as { __wt: Probe }).__wt.readCanvases()),
  startBlank: () => page.evaluate(() => (window as unknown as { __wt: Probe }).__wt.startBlank()),
  stopBlank: (): Promise<BlankReport> => page.evaluate(() => (window as unknown as { __wt: Probe }).__wt.stopBlank()),
  steady: (pxPerSec: number, seconds: number) => page.evaluate(([p, s]) => (window as unknown as { __wt: Probe }).__wt.steady(p, s), [pxPerSec, seconds]),
  keys: () => page.evaluate(() => (window as unknown as { __wt: Probe }).__wt.keys),
});

// ---- Waiting ----------------------------------------------------------------------------------------------------

/** The viewer says it is ready (a document is open and shown). Fails with the viewer's own state if it never is. */
export async function waitReady(page: Page, timeout = 20_000): Promise<void> {
  await expect
    .poll(() => rt(page).state(), { message: 'the viewer never reached state "ready"', timeout, intervals: [50, 100, 200] })
    .toBe('ready');
  await expect(page.locator('[role="document"]')).toBeVisible({ timeout: 5_000 }); // not getByRole: <html> is a "document" too
}

/** Ready, and a page picture is on screen. Returns when (ms since the page began loading) the first ink showed. */
export async function waitForFirstPage(page: Page, timeout = 20_000): Promise<number> {
  await waitReady(page, timeout);
  await expect.poll(() => probe(page).firstInkAt(), { message: 'no page picture ever appeared', timeout, intervals: [25, 50, 100] }).not.toBeNull();
  return (await probe(page).firstInkAt())!;
}

/** Waits until a value stops changing (two reads 120 ms apart agree to within `eps`). */
export async function settled(read: () => Promise<number>, eps = 0.0005, timeout = 4_000): Promise<number> {
  const until = Date.now() + timeout;
  let a = await read();
  for (;;) {
    await new Promise((r) => setTimeout(r, 120));
    const b = await read();
    if (Math.abs(a - b) <= eps) return b;
    if (Date.now() > until) return b;
    a = b;
  }
}

// ---- What is on screen -------------------------------------------------------------------------------------------

export interface Shot {
  img: Rgba;
  /** Device pixels per CSS pixel. */
  ratio: number;
  /** The document scroller's place in the window, CSS px. */
  scroller: CssRect;
  canvases: CanvasRead[];
}

export async function scrollerRect(page: Page): Promise<CssRect> {
  return page.evaluate(() => {
    const r = document.querySelector('[role="document"]')!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

/** A screenshot of the window with the canvases' places. Dimensions come from the page itself. */
export async function shoot(page: Page, path?: string): Promise<Shot> {
  const png = await page.screenshot(path ? { path } : {});
  const img = decodePng(png);
  const cssWidth = await page.evaluate(() => window.innerWidth);
  return { img, ratio: img.width / cssWidth, scroller: await scrollerRect(page), canvases: await probe(page).readCanvases() };
}

/** The page numbers of book-400 that can be read from the screen right now. */
export async function pagesOnScreen(page: Page): Promise<number[]> {
  const s = await shoot(page);
  return readAllStrips(s.img, s.ratio, s.canvases.map((c) => ({ x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight })), s.scroller);
}

/** Waits until page `n` (1-based, as printed on it) can be read on screen. Returns the ms it took, from the call. */
export async function waitForPageOnScreen(page: Page, n: number, timeout = 5_000): Promise<number> {
  const t0 = Date.now();
  await expect.poll(async () => (await pagesOnScreen(page)).includes(n), { message: `page ${n} never showed on screen`, timeout, intervals: [60, 100, 150] }).toBe(true);
  return Date.now() - t0;
}

/** Saves a screenshot under test-results/ and attaches it to the report. */
export async function snap(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = freshOutputPath(testInfo, `${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

export function note(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

// ---- Input -------------------------------------------------------------------------------------------------------

/** Ctrl + wheel with the pointer at (x, y) in the window; deltaY < 0 zooms in (a wheel turned away from you). */
export async function ctrlWheel(page: Page, x: number, y: number, deltaY: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
}

/** The centre of the document scroller, CSS px in the window. */
export async function viewportCentre(page: Page): Promise<{ x: number; y: number }> {
  const r = await scrollerRect(page);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Picks "Fit page" the way the owner would: from a zoom control in the viewer. The interface file gives no
 * control for it in this slice (only Ctrl+0, fit width), so this looks for the obvious ones and says so if there is none.
 */
export async function chooseFitPage(page: Page): Promise<void> {
  const direct: Locator = page.getByRole('menuitem', { name: /fit.*page|page.*fit/i }).or(page.getByRole('button', { name: /fit.*page|page.*fit/i })).or(page.getByRole('option', { name: /fit.*page|page.*fit/i }));
  if (await direct.first().isVisible().catch(() => false)) return void (await direct.first().click());
  const opener = page.getByRole('button', { name: /zoom/i }).or(page.getByRole('combobox', { name: /zoom/i })).or(page.getByRole('menuitem', { name: /^view$/i })).or(page.getByRole('button', { name: /^view$/i }));
  if (await opener.first().isVisible().catch(() => false)) {
    await opener.first().click();
    const item = page.getByRole('menuitem', { name: /fit.*page|page.*fit/i }).or(page.getByRole('option', { name: /fit.*page|page.*fit/i })).or(page.getByText(/fit (to )?page/i));
    await item.first().click({ timeout: 3_000 });
    return;
  }
  throw new Error('There is no way to choose "Fit page" in the viewer: no control named like "Fit page" or "Zoom" was found. (Spec: "Zoom: Fit width, fit page, 25 to 400%".)');
}

export { BAR };
