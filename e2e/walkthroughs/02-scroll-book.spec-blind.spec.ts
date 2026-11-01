// Walkthrough: "Scroll fast through a 400-page book." No page stays blank for more than 150 ms, and End shows the last page.
// Spec, Speed budgets: "a 600-page scanned textbook scrolls without a blank page showing for more than 150 ms".
// Interface file: ENGINE_WORKERS = 1; "R24: a jump during a full render stays within 150 ms (no blank page longer than 150 ms
// while scrolling, as P0-3)"; "Home and End go to the start and the end".
//
// book-400 has page-number strips on every page (see support/fixtures.spec-blind.ts), so the probe in the page can
// tell a blank page from a page showing the WRONG picture. "Blank" runs from the moment a page's place scrolls into
// view until its own picture is on its canvas (the spike's definition, P0-3).
import { budgetMs, budgetNote } from '../support/perf-budget';
import { REAL, FIXTURES, BOOK_PAGES, ensureBook, served } from './support/fixtures.spec-blind';
import { regionStats } from './support/pixels.spec-blind';
import { expect, note, probe, rt, shoot, snap, test, waitForFirstPage, waitForPageOnScreen, type BlankReport } from './support/viewer.spec-blind';

// The spec's 150 ms with SOP_PERF_STRICT=1 (the reference laptop), looser otherwise (support/perf-budget.ts).
const BLANK_SPEC_MS = 150;
const BLANK_BUDGET_MS = budgetMs(BLANK_SPEC_MS);

test.beforeAll(async () => {
  await ensureBook();
});

function summarise(r: BlankReport): string {
  return `${r.pagesSeen} pages entered view; blank max ${r.maxMs.toFixed(0)} ms, p95 ${r.p95Ms.toFixed(0)} ms; ${r.wrong.length} wrong pictures; ${r.frames} frames (longest gap ${r.maxFrameGapMs.toFixed(0)} ms)`;
}

function expectNoLongBlank(r: BlankReport, what: string): void {
  const worst = [...r.records].sort((a, b) => b.ms - a.ms).slice(0, 3).map((x) => `page ${x.page + 1}: ${x.ms.toFixed(0)} ms${x.left ? ' (left view unpainted)' : ''}${x.pending ? ' (still blank)' : ''}`);
  expect(r.wrong, `${what}: a page showed another page's picture`).toEqual([]);
  expect(r.maxMs, `${what}: longest blank ${r.maxMs.toFixed(0)} ms (${budgetNote(BLANK_SPEC_MS)}); worst: ${worst.join('; ')}`).toBeLessThanOrEqual(BLANK_BUDGET_MS);
}

test('a 400-page book: fast steady scrolling never leaves a page blank for more than 150 ms', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  expect((await rt(page).doc())?.pageCount).toBe(BOOK_PAGES);
  await waitForPageOnScreen(page, 1);
  await snap(page, testInfo, '02-book-opened');

  // 3000 px/s is the Phase 0 "steady" speed: about two pages a second at fit width.
  await probe(page).startBlank();
  const moved = await probe(page).steady(3000, 6);
  await page.waitForTimeout(500); // the page where the scroll ends gets time to draw
  const report = await probe(page).stopBlank();
  await snap(page, testInfo, '02-book-after-steady-scroll');
  note(testInfo, 'steady scroll', `${summarise(report)}; scrolled ${(moved.to - moved.from).toFixed(0)} px in ${moved.ms.toFixed(0)} ms over ${moved.frames} frames`);
  await testInfo.attach('steady-scroll-blank-report.json', { body: JSON.stringify(report, null, 1), contentType: 'application/json' });

  expect(report.pagesSeen, 'the scroll actually went through the book').toBeGreaterThanOrEqual(6);
  expectNoLongBlank(report, 'steady scroll at 3000 px/s');
});

test('a 400-page book: a flick of the mouse wheel never leaves a page blank for more than 150 ms', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  await page.mouse.move(640, 400);
  await probe(page).startBlank();
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 160); // a hard flick: about 6000 px in under a second of input
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(600);
  const report = await probe(page).stopBlank();
  await snap(page, testInfo, '02-book-after-wheel-flick');
  note(testInfo, 'wheel flick', summarise(report));
  expect(await rt(page).scrollTop(), 'the wheel moved the document').toBeGreaterThan(3000);
  expectNoLongBlank(report, 'wheel flick');
});

test('a 400-page book: End shows the last page, Home the first, and jumps are not blank for more than 150 ms', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  await waitForPageOnScreen(page, 1);

  await probe(page).startBlank();

  await page.keyboard.press('End');
  const endMs = await waitForPageOnScreen(page, BOOK_PAGES, 5_000);
  await expect.poll(async () => (await rt(page).maxScrollTop()) - (await rt(page).scrollTop()), { message: 'End scrolls to the very end of the document' }).toBeLessThanOrEqual(2);
  await snap(page, testInfo, '02-book-end');
  const onScreen = await probe(page).readCanvases();
  expect(onScreen.some((c) => c.state === 'page' && c.n === BOOK_PAGES), 'the picture of page 400 is on a canvas').toBe(true);
  const current = await rt(page).currentPage();
  expect([BOOK_PAGES - 1, BOOK_PAGES], `the current page after End is the last one (0-based ${BOOK_PAGES - 1} or 1-based ${BOOK_PAGES}), got ${current}`).toContain(current);
  note(testInfo, 'currentPage base', current === BOOK_PAGES - 1 ? '0-based (page index)' : '1-based (page number)');

  await page.keyboard.press('Home');
  const homeMs = await waitForPageOnScreen(page, 1, 5_000);
  await expect.poll(() => rt(page).scrollTop(), { message: 'Home scrolls to the very top' }).toBeLessThanOrEqual(2);
  await snap(page, testInfo, '02-book-home');

  await rt(page).scrollToPage(199);
  await waitForPageOnScreen(page, 200, 5_000);

  await page.keyboard.press('End');
  await waitForPageOnScreen(page, BOOK_PAGES, 5_000);

  await page.waitForTimeout(300);
  const report = await probe(page).stopBlank();
  note(testInfo, 'jumps', `${summarise(report)}; End ${endMs} ms, Home ${homeMs} ms (including screenshot polling)`);
  expectNoLongBlank(report, 'jumps with End, Home and a jump to page 200');
});

test('a real 404-page textbook: End shows its last page with real content, Home brings back the first', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(REAL.book404.url));
  await waitForFirstPage(page);
  expect((await rt(page).doc())?.pageCount).toBe(REAL.book404.pages);

  await page.keyboard.press('End');
  await expect.poll(async () => (await rt(page).maxScrollTop()) - (await rt(page).scrollTop())).toBeLessThanOrEqual(2);
  // The last page is the index: a page of text. Wait for it to be drawn, then look at what is on screen.
  await expect
    .poll(async () => {
      const s = await shoot(page);
      return regionStats(s.img, s.ratio, s.scroller).dark;
    }, { message: 'the last page of the textbook never showed any text', timeout: 8_000 })
    .toBeGreaterThan(0.005);
  await snap(page, testInfo, '02-textbook-end');

  await page.keyboard.press('Home');
  await expect.poll(() => rt(page).scrollTop()).toBeLessThanOrEqual(2);
  await expect
    .poll(async () => {
      const s = await shoot(page);
      return regionStats(s.img, s.ratio, s.scroller).dark;
    }, { timeout: 8_000 })
    .toBeGreaterThan(0.001);
  await snap(page, testInfo, '02-textbook-home');
});
