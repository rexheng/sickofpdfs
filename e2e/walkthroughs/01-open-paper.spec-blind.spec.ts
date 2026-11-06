// Walkthrough 1, "You click any PDF link": a real 50-page paper opens in our viewer and its first page shows quickly.
// Spec: Release 1 is done when "A 50-page paper shows its first page in under 1 second on the reference laptop" (criterion 1);
// Speed budgets: "first page under 1 s for a 50-page paper ... CI runs looser smoke versions".
// The clock is the page's own: milliseconds from the start of the viewer page's navigation to the first picture of a
// page on screen. The bound is the spec's 1 s with SOP_PERF_STRICT=1 (the reference laptop), and looser otherwise
// (support/perf-budget.ts).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { budgetMs, budgetNote } from '../support/perf-budget';
import { REAL } from './support/fixtures.spec-blind';
import { inkBox } from './support/pixels.spec-blind';
import { expect, note, probe, rt, shoot, snap, test, waitForFirstPage } from './support/viewer.spec-blind';

const FIRST_PAGE_SPEC_MS = 1000;
const FIRST_PAGE_BUDGET_MS = budgetMs(FIRST_PAGE_SPEC_MS);

test('Opening a paper: the first page comes in under a second, is the right page, and the viewer reports the file truly', async ({ step }, testInfo) => {
  test.setTimeout(180_000);
  await step('a 50-page paper shows its first page in under a second', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(REAL.paper50.url));
    const firstInkMs = await waitForFirstPage(page);
    note(testInfo, 'first page on screen (ms)', firstInkMs.toFixed(0));
    await snap(page, testInfo, '01-first-page');

    expect(firstInkMs, `first picture of page 1 after ${firstInkMs.toFixed(0)} ms; ${budgetNote(FIRST_PAGE_SPEC_MS)}`).toBeLessThan(FIRST_PAGE_BUDGET_MS);

    // The viewer's own mark for "page 0 fully drawn" (interface file: performance.mark('sop:first-page')) exists and agrees.
    await expect
      .poll(() => page.evaluate(() => performance.getEntriesByName('sop:first-page').length), { message: "the viewer never set performance.mark('sop:first-page')" })
      .toBeGreaterThan(0);
    const markMs = await page.evaluate(() => performance.getEntriesByName('sop:first-page')[0].startTime);
    note(testInfo, 'sop:first-page mark (ms)', markMs.toFixed(0));
    expect(markMs, `the fully drawn first page took ${markMs.toFixed(0)} ms; ${budgetNote(FIRST_PAGE_SPEC_MS)}`).toBeLessThan(FIRST_PAGE_BUDGET_MS);
  }, 60_000);
  await step('the first page is page 1 of this paper, drawn on a white page with real text on it', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(REAL.paper50.url));
    await waitForFirstPage(page);
    // Give a sharp redraw (after the quick preview) time to land before looking.
    await page.waitForTimeout(800);
    const shot = await shoot(page, testInfo.outputPath('01-paper-page-1.png'));
    const canvas = shot.canvases.find((c) => c.page === 0);
    expect(canvas, 'a canvas for page 1 is on screen').toBeDefined();
    const rect = { x: canvas!.x, y: canvas!.y, width: canvas!.cssWidth, height: canvas!.cssHeight };
    const box = inkBox(shot.img, shot.ratio, rect, 140);
    expect(box, 'there is ink on page 1').not.toBeNull();
    // A paper's first page: a title block near the top, then text; not a page of solid black or one speck.
    expect(box!.top, 'ink starts in the upper part of the page').toBeLessThan(0.3);
    expect(box!.share, 'text covers a few percent of the page').toBeGreaterThan(0.01);
    expect(box!.share).toBeLessThan(0.35);
    // The page is white paper, not the dark viewer background showing through.
    const corner = { x: rect.x + rect.width * 0.02, y: rect.y + rect.height * 0.01, width: rect.width * 0.04, height: rect.height * 0.01 };
    expect(inkBox(shot.img, shot.ratio, corner, 250), 'the page corner is white paper').toBeNull();
  }, 60_000);
  await step('what the viewer reports about the opened file is true: its size, its hash, its name, its page count', async ({ openViewer, server }) => {
    const url = server.url(REAL.paper50.url);
    const page = await openViewer(url);
    await waitForFirstPage(page);
    const bytes = await readFile(REAL.paper50.file);
    const doc = await rt(page).doc();
    expect(doc, 'the viewer publishes the opened document').not.toBeNull();
    expect(doc!.size).toBe(bytes.length);
    expect(doc!.sha256, 'the streaming hash equals the file SHA-256').toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(doc!.pageCount).toBe(REAL.paper50.pages);
    expect(doc!.displayName).toMatch(/paper-50/);
    expect(doc!.sourceUrl).toBe(url);
    // The reading area is named after the file (interface: aria-label = file name), for screen readers.
    await expect(page.getByRole('document', { name: /paper-50/ })).toBeVisible();
    expect(await probe(page).inkNow()).toBe(true);
  }, 60_000);
});
