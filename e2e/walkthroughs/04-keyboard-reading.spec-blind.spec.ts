// Walkthrough: reading with the keyboard. The owner opens a PDF and uses PgUp, PgDn, Space, Home, End and the arrows,
// without clicking anything first (Chrome's viewer works that way).
// Interface file (scroll keys): "ArrowUp and ArrowDown move 40 px; PageUp, PageDown, Space and Shift+Space move the viewport
// height - 40, or one page in fit-page mode; Home and End go to the start and the end; ArrowLeft and ArrowRight go to the
// previous or next page when there is no horizontal overflow, and otherwise scroll 40 px."
// Spec, Reading basics: "Zoom steps, fit modes and keyboard scrolling follow Chromium's open-source viewer".
import { FIXTURES, ensureBook, served } from './support/fixtures.spec-blind';
import { chooseFitPage, expect, rt, settled, snap, test, waitForFirstPage } from './support/viewer.spec-blind';
import type { Page } from '@playwright/test';

const PAGE_GAP = 16; // interface file

test.beforeAll(async () => {
  await ensureBook();
});

/** The document scrolls to `target` px and stops there (keys may scroll smoothly, so this waits for it). */
async function expectScrollTop(page: Page, target: number, what: string): Promise<void> {
  await expect.poll(() => rt(page).scrollTop(), { message: what, timeout: 3_000, intervals: [50, 100, 200] }).toBeGreaterThanOrEqual(target - 1.5);
  await expect.poll(() => settled(() => rt(page).scrollTop(), 0.5, 1_500), { message: `${what} (settled)` }).toBeLessThanOrEqual(target + 1.5);
}

test('arrow keys move 40 px, PgDn/PgUp and Space move a screen minus 40 px, Home and End go to the ends', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  const vh = await rt(page).viewportHeight();
  const screen = vh - 40;
  expect(await rt(page).scrollTop(), 'a PDF opens at the top').toBeLessThanOrEqual(1);

  await page.keyboard.press('ArrowDown');
  await expectScrollTop(page, 40, 'ArrowDown moves the document 40 px');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expectScrollTop(page, 120, 'three ArrowDown presses move 120 px');
  await page.keyboard.press('ArrowUp');
  await expectScrollTop(page, 80, 'ArrowUp moves back 40 px');

  await page.keyboard.press('PageDown');
  await expectScrollTop(page, 80 + screen, `PageDown moves a screen minus 40 px (${vh} - 40)`);
  await page.keyboard.press('PageDown');
  await expectScrollTop(page, 80 + 2 * screen, 'a second PageDown');
  await page.keyboard.press('PageUp');
  await expectScrollTop(page, 80 + screen, 'PageUp moves back a screen minus 40 px');

  await page.keyboard.press('Space');
  await expectScrollTop(page, 80 + 2 * screen, 'Space is PageDown');
  await page.keyboard.press('Shift+Space');
  await expectScrollTop(page, 80 + screen, 'Shift+Space is PageUp');
  await snap(page, testInfo, '04-keys-mid-document');

  await page.keyboard.press('End');
  await expect.poll(async () => (await rt(page).maxScrollTop()) - (await rt(page).scrollTop()), { message: 'End goes to the end' }).toBeLessThanOrEqual(2);
  await snap(page, testInfo, '04-keys-end');
  await page.keyboard.press('Home');
  await expectScrollTop(page, 0, 'Home goes to the start');
});

test('the keys stop at the ends instead of going past them', async ({ openViewer, server }) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('PageUp');
  await page.keyboard.press('Shift+Space');
  await page.waitForTimeout(300);
  expect(await rt(page).scrollTop(), 'up keys at the top change nothing').toBeLessThanOrEqual(1);

  await page.keyboard.press('End');
  await expect.poll(async () => (await rt(page).maxScrollTop()) - (await rt(page).scrollTop())).toBeLessThanOrEqual(2);
  const max = await rt(page).maxScrollTop();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  expect(await rt(page).scrollTop(), 'down keys at the end change nothing').toBeGreaterThanOrEqual(max - 2);
  expect(await rt(page).scrollTop()).toBeLessThanOrEqual(max + 2);
});

test('with nothing wider than the window, Left and Right arrows go to the previous and next page', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  await page.keyboard.press('Control+0'); // fit width: no sideways overflow
  await settled(() => rt(page).scale());
  const boxes = await rt(page).pageBoxes();
  const hasOverflow = await page.evaluate(() => {
    const s = document.querySelector('[role="document"]')!;
    return s.scrollWidth > s.clientWidth + 1;
  });
  expect(hasOverflow, 'precondition: fit width has no horizontal overflow').toBe(false);
  await page.keyboard.press('Home');
  await expectScrollTop(page, 0, 'Home');

  const atPageTop = async (index: number, what: string) => {
    const want = boxes[index].top;
    await expect
      .poll(async () => Math.abs((await rt(page).scrollTop()) - want), { message: `${what}: page ${index + 1}'s top (${want}) should be at the top of the view`, timeout: 3_000 })
      .toBeLessThanOrEqual(PAGE_GAP + 4);
  };
  await page.keyboard.press('ArrowRight');
  await atPageTop(1, 'ArrowRight');
  await page.keyboard.press('ArrowRight');
  await atPageTop(2, 'ArrowRight again');
  await snap(page, testInfo, '04-arrow-right-twice');
  await page.keyboard.press('ArrowLeft');
  await atPageTop(1, 'ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await atPageTop(0, 'ArrowLeft again');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  expect(await rt(page).scrollTop(), 'ArrowLeft on the first page stays on it').toBeLessThanOrEqual(PAGE_GAP + 4);
});

test('when the page is wider than the window, Left and Right scroll sideways by 40 px and do not change page', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  for (let i = 0; i < 12; i++) await page.keyboard.press('Control+='); // to 400%
  await expect.poll(() => rt(page).scale()).toBeCloseTo(4, 3);
  await page.evaluate(() => {
    document.querySelector('[role="document"]')!.scrollLeft = 0;
  });
  const scrollLeft = () => page.evaluate(() => document.querySelector('[role="document"]')!.scrollLeft);
  expect(
    await page.evaluate(() => {
      const s = document.querySelector('[role="document"]')!;
      return s.scrollWidth - s.clientWidth;
    }),
    'precondition: at 400% the page is wider than the window',
  ).toBeGreaterThan(100);
  const topBefore = await rt(page).scrollTop();
  await page.keyboard.press('ArrowRight');
  await expect.poll(scrollLeft, { message: 'ArrowRight scrolls 40 px to the right' }).toBeGreaterThanOrEqual(38);
  expect(await settled(scrollLeft, 0.5, 1_500)).toBeLessThanOrEqual(42);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => settled(scrollLeft, 0.5, 1_500), { message: 'ArrowLeft scrolls back' }).toBeLessThanOrEqual(2);
  expect(Math.abs((await rt(page).scrollTop()) - topBefore), 'the page did not change').toBeLessThanOrEqual(2);
  await snap(page, testInfo, '04-sideways-at-400');
});

test('in fit-page mode, PageDown and PageUp move exactly one page', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  await chooseFitPage(page);
  await expect.poll(async () => (await rt(page).snapshot()).zoom.kind).toBe('fit-page');
  await settled(() => rt(page).scale());
  const boxes = await rt(page).pageBoxes();
  await rt(page).scrollToPage(24); // page 25 lined up at the top of the window
  await settled(() => rt(page).scrollTop(), 1);
  const atPageTop = async (index: number, what: string) => {
    await expect
      .poll(async () => Math.abs((await rt(page).scrollTop()) - boxes[index].top), { message: `${what}: page ${index + 1} should be lined up at the top`, timeout: 3_000 })
      .toBeLessThanOrEqual(PAGE_GAP + 4);
  };
  await atPageTop(24, 'start');
  await page.keyboard.press('PageDown');
  await atPageTop(25, 'PageDown');
  await page.keyboard.press('PageDown');
  await atPageTop(26, 'PageDown again');
  await page.keyboard.press('PageUp');
  await atPageTop(25, 'PageUp');
  await snap(page, testInfo, '04-fit-page-pgdn');
});
