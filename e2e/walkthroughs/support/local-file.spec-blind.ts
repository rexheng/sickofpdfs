// Opening a local PDF the way a double-click does, and getting the viewer ready for marking, for the Phase 3 walkthroughs that start from files.
import type { BrowserContext, Page } from '@playwright/test';
import { expect, hooks } from '../../support/test';
import { setZoom, settle, waitForTextLayer } from '../../support/tl-blind.spec-blind';
import { WIDE } from './marks.spec-blind';
import { OUR_VIEWER_RE } from './takeover';
import { waitForStore, waitViewerReady } from './library-p3.spec-blind';

/** A new tab at the file's own address (`file:///...`); returns once the takeover has it in our viewer and the library is connected. */
export async function openLocalFile(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url).catch(() => {}); // the takeover replaces the navigation Playwright started
  await expect.poll(() => page.url(), { message: 'the tab should be showing our viewer', timeout: 20_000 }).toMatch(OUR_VIEWER_RE);
  await page.setViewportSize(WIDE);
  await waitViewerReady(page);
  await waitForStore(page);
  return page;
}

/** What openFixture does for a page that was opened by address: 100%, rail shut, page `pageIndex` with its text layer. */
export async function readyForMarks(page: Page, pageIndex = 0): Promise<void> {
  if (await hooks(page).eval((h) => h.viewer.snapshot().railOpen)) {
    await page.keyboard.press('F4');
    await page.waitForFunction(() => !(globalThis as unknown as { __sopTest: { viewer: { snapshot(): { railOpen: boolean } } } }).__sopTest.viewer.snapshot().railOpen);
  }
  await setZoom(page, 1);
  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), pageIndex);
  await waitForTextLayer(page, pageIndex);
  await settle(page);
}
