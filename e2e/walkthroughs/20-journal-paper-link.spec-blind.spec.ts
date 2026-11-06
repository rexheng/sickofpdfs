// Gate 1, Phase 3 plan, item 1: "A journal paper link."
//   "The chip says 'Saved to library'. The tooltip names reasons such as the References section. The library lists it with a proper
//    title. Close it, reopen it: it opens where you stopped."
// Spec, "How it feels to use" 1: 'A chip in the top bar reads "Saved to library" (reasons on hover, such as "References section, DOI,
// 40 pages"). If you have read it before, it opens where you stopped.' "Learning PDFs are saved automatically." Library: "title, authors,
// year, DOI or arXiv id ... from the PDF itself, its first page and its ids"; history: "first and last opened, total reading time,
// last position (opening resumes there), pages visited". Phase 3 done-when 5: "a reading reopens where you stopped, and shows time
// read and last opened."
//
// The paper: "Attention Is All You Need" (arXiv, 15 pages, References). Its Info title is empty, so the proper title can only come
// from page 1. No click saves it: the filter does.
//
// Guard: FILTER_IN_VIEWER (the real filter). GUESSES: the tooltip is a Radix tooltip (role "tooltip"); a reading's resume spot is
// saved within a few seconds and on closing the tab (the plan's own wording is "after 5 s and on hide"); `getReading().lastPosition.page`
// may be 0- or 1-based, so both are accepted.
import { expect, hooks, test } from '../support/test';
import { store as storeOf } from '../support/store-probe.spec-blind';
import { libraryId } from './support/marks.spec-blind';
import { shot } from './support/takeover';
import { ATTENTION, FILTER_IN_VIEWER, NO_FILTER, chipOf, chipTooltip, fixtureUrl, note, openLibrary, rowFor, shaOf, stateKind, waitForStore, waitViewerReady } from './support/library-p3.spec-blind';

test.skip(!FILTER_IN_VIEWER, NO_FILTER);
test.setTimeout(180_000);

test('a journal paper is saved by itself, listed with its real title, and reopens where you stopped', async ({ context, openViewer, server }, testInfo) => {
  const url = fixtureUrl(server, ATTENTION);
  const page = await openViewer(url);
  await waitViewerReady(page);
  await waitForStore(page);

  // 1. The chip says it, with no click.
  await expect(chipOf(page), 'the chip says "Saved to library" with no click').toContainText(/saved to library/i, { timeout: 45_000 });
  expect(await stateKind(page)).toBe('saved');
  await shot(page, testInfo, 'chip-saved');

  // 2. The tooltip gives the reasons.
  const tip = await chipTooltip(page);
  note(testInfo, 'the chip tooltip says', tip);
  // Triage (S11, rule 7): Attention's References heading is on page 10 of 15, outside the first and last 5 pages the filter reads
  // (spec, Learning filter step 1), so it is saved on its arXiv number, citations and Abstract. The hover lists those, strongest first.
  // Triage (Phase 3 gate, TB4 fix A item 6): the hover is now one plain sentence, "Saved because it looks like a paper: it has
  // an arXiv number, many citations and an abstract.", still strongest first.
  expect(tip, 'the reasons name what the filter found, strongest first').toMatch(/^Saved because it looks like a paper: it has an arXiv number\b/i);
  const found = tip.replace(/^.*?\bit has\s+/i, '').replace(/\.$/, '').split(/,\s*|\s+and\s+/);
  expect(found.length, `at least three of them (${found.join(' | ')})`).toBeGreaterThanOrEqual(3);
  await shot(page, testInfo, 'chip-reasons');

  const id = await libraryId(page);
  expect(id, "a document's id is its fingerprint").toBe(await shaOf(ATTENTION));

  // 3. Read: stop on page 7, long enough for the resume spot to be kept, then close the tab.
  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), 6);
  await expect.poll(() => hooks(page).eval((h) => h.viewer.currentPage()), { message: 'the viewer is on page 7' }).toBe(6);
  await page.mouse.move(300, 300);
  await page.waitForTimeout(7000);
  await shot(page, testInfo, 'stopped-on-page-7');
  await page.close();

  // 4. The library lists it, with the paper's real title (the file name is "arxiv-1706.03762-attention.pdf").
  const library = await openLibrary(context, 'library');
  const row = rowFor(library, ATTENTION.rowName);
  await expect(row, 'My library lists the paper').toBeVisible({ timeout: 15_000 });
  await expect(row, 'with its real title, from page 1').toContainText(ATTENTION.title);
  await shot(library, testInfo, 'library-lists-it');
  await library.close();

  // 5. Reopen it: it opens where you stopped.
  const again = await openViewer(url);
  await waitViewerReady(again);
  await expect.poll(() => hooks(again).eval((h) => h.viewer.currentPage()), { message: 'the paper reopens on page 7, where you stopped', timeout: 15_000 }).toBe(6);
  await shot(again, testInfo, 'reopened-where-you-stopped');
  await expect(chipOf(again), 'and it is still saved (a known fingerprint is not judged again)').toContainText(/saved to library/i);

  // 6. The history behind it: opened twice, some time read, the spot kept.
  await waitForStore(again);
  const reading = await storeOf(again).call<{ lastPosition: { page: number } | null; readingMs: number; openCount: number; pagesVisited: number[] } | null>('getReading', id);
  expect(reading, 'the library keeps a reading history for it').not.toBeNull();
  expect(reading!.openCount, 'opened twice').toBeGreaterThanOrEqual(2);
  expect(reading!.readingMs, 'some reading time was counted').toBeGreaterThan(0);
  expect([6, 7], 'the last position is page 7').toContain(reading!.lastPosition?.page);
  expect(reading!.pagesVisited.some((n) => n === 6 || n === 7), 'page 7 counts as visited').toBe(true);
  note(testInfo, 'the history says', JSON.stringify(reading));
});
