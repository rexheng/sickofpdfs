// Walkthrough 15, "Find (Ctrl+F)" (Task 25). The owner reads a real paper, presses Ctrl+F, types a word, steps through the hits,
// selects one and copies it, goes Back, and does the same in a 700-page book and on a scan.
//
// Spec: "Reading basics ... Print, find, zoom, rotate, links, outline, thumbnails and password-protected PDFs work at least as
// well as in Chrome's viewer"; "Find | Ctrl+F with match count, next and previous"; "Find / go to page | Ctrl+F / Ctrl+G";
// "Jumps inside a document (links, search results, next note) are kept in the page's history state and collapsed, so Back
// returns to where you were"; Scanned PDFs: "scans open normally" (Release 3 makes them searchable).
// Task 25's interface file: "Ctrl+F finds text at least as well as Chrome's own PDF viewer: case- and accent-insensitive;
// ligatures match their letters; a word split by a line-end hyphen matches; line breaks are spaces. Enter/Shift+Enter step and
// wrap; 'No results' when nothing matches; Esc closes; Alt+Enter selects the current hit as a real text selection; on a scan
// with no text it says so. Results stream so the first hit near the current page appears within about 100 ms, and a 600-page
// book never freezes the UI. Every jump to a hit is one Back step (jump history)."
//
// The expected counts and pages below were worked out before the feature existed, from two independent readers of each file:
// poppler's pdftotext (folded to lower case, accents removed, ligatures and line-end hyphens joined, line breaks as spaces) and
// the engine's own raw page text, read with the same folding. They agree on every number. Counts are substring counts, as
// Chrome's find counts them ("generation" also finds "generations").
import { collapse } from '../support/tl-copy.spec-blind';
import { budgetMs, budgetNote } from '../support/perf-budget';
import { clearSelection, copySelection, openClipboardReader, pageMap, rangeText, readSelection, th, waitForTextLayer } from '../support/tl-blind.spec-blind';
import type { Page } from '@playwright/test';
import {
  bar,
  expectCount,
  expectCurrentOnPage,
  expectTotal,
  field,
  FIND_HIT,
  fillQuery,
  findTokens,
  fold,
  lettersOnly,
  lineCount,
  openFind,
  paint,
  paintedRects,
  readBar,
} from './support/find.spec-blind';
import { expect, rt, settled, snap, test, waitForFirstPage, waitReady } from './support/viewer.spec-blind';

const PAPER = '/f/paper-50.pdf'; // pages 1-50 of an NBER working paper
const LEC1 = '/f/classifier/learning/lecture-notes-mit-6.006-lec1.pdf'; // 5 slides-style pages with fi / ffi ligatures
const PSET = '/f/classifier/learning/problem-set-mit-14.01-f23-pset4-solutions.pdf'; // ff / fi / ffi ligatures
const BOOK = '/f/classifier/learning/textbook-boyd-convex-optimization.pdf'; // 714 pages of real text
const SCAN = '/f/scan-120.pdf'; // 120 pages that are pictures only

test.setTimeout(120_000); // several searches in a row on real files; the book test sets its own

/** Page errors seen since now. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Where the reader is, as a person sees it. */
async function where(page: Page): Promise<{ page: number; top: number }> {
  return { page: await rt(page).currentPage(), top: await rt(page).scrollTop() };
}
const SAME_PLACE_PX = 60;
const near = (a: { page: number; top: number }, b: { page: number; top: number }) => a.page === b.page && Math.abs(a.top - b.top) <= SAME_PLACE_PX;

/**
 * Back to page 1 before a new search. A search starts from the page being read and wraps ("searches from startPage(), wraps"),
 * so the order of the hits depends on where the reader is: every test that counts on the order starts from the top.
 */
async function toTop(page: Page): Promise<void> {
  await settled(() => rt(page).scrollTop(), 1, 4_000); // a jump from the last search may still be moving the page
  await rt(page).scrollToPage(0);
  await expect.poll(async () => (await where(page)).page, { message: 'back at the top of the paper' }).toBe(0);
  await expect.poll(async () => (await where(page)).top, { message: 'back at the top of the paper' }).toBeLessThanOrEqual(1);
}

/** Presses Enter `times` times in the search box, one step at a time, waiting for the count to follow. */
async function stepForward(page: Page, from: number, times: number, total: number): Promise<void> {
  for (let i = 1; i <= times; i++) {
    await page.keyboard.press('Enter');
    await expectCount(page, ((from - 1 + i) % total) + 1, total, `Enter #${i}`);
  }
}

test('Find: Ctrl+F counts and paints hits, steps through them, and matches hyphens, ligatures, case, accents and line breaks', async ({ step }, testInfo) => {
  test.setTimeout(720_000);
  // ----------------------------------------------------------------------------------------------------------------
  await step('Ctrl+F opens the find bar; typing a word counts its hits and paints the current one where the word is', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    await expect(field(page), 'no find bar before Ctrl+F').toBeHidden();

    await openFind(page);
    await expect(bar(page), 'the bar holds the box and at least previous, next and close').toBeVisible();
    await snap(page, testInfo, '15-bar-open');

    await page.keyboard.type('disincentive'); // no click first: the box has the keyboard
    await expectCount(page, 1, 7, '"disincentive" in the paper');
    // The hits are painted with two tokens: --find-hit is the interface file's translucent amber. --find-current is any
    // translucent colour that tells the current hit apart (triage: it ships as orange at .5, for readable text under it).
    const tokens = await findTokens(page);
    expect(tokens.hit, '--find-hit is a colour').not.toBeNull();
    const { a: hitAlpha, ...hitRgb } = tokens.hit!;
    expect(hitRgb, '--find-hit is the amber of the interface file').toEqual({ r: FIND_HIT.r, g: FIND_HIT.g, b: FIND_HIT.b });
    expect(hitAlpha, '--find-hit is as translucent as the interface file says').toBeCloseTo(FIND_HIT.a, 2);
    const cur = tokens.current;
    expect(cur, '--find-current is a colour').not.toBeNull();
    expect(cur!.a, '--find-current is translucent, so the word under it shows').toBeGreaterThan(0);
    expect(cur!.a, '--find-current is translucent, so the word under it shows').toBeLessThan(1);
    expect(cur, '--find-current looks different from --find-hit').not.toEqual(tokens.hit);

    // The first hit (page 4) is brought into view, and its painted rectangle sits on the word. The expected place comes from the
    // engine's own search for the same word on the same page.
    const mine = await expectCurrentOnPage(page, 3, 'the first hit');
    const truth = await th(page).eval((h) => h.backend.searchPage(h.doc()!.open.doc, 3, 'disincentive', { matchCase: false, wholeWord: false }));
    expect(truth.length, 'precondition: the engine sees two "disincentive" on page 4').toBe(2);
    const map = await pageMap(page, 3);
    const want = map.box(truth[0].rects[0]);
    const painted = mine[0];
    const centre = { x: painted.x + painted.width / 2, y: painted.y + painted.height / 2 };
    expect(centre.x, 'the painted hit is over the word (left-right)').toBeGreaterThanOrEqual(want.left - 4);
    expect(centre.x, 'the painted hit is over the word (left-right)').toBeLessThanOrEqual(want.right + 4);
    expect(centre.y, 'the painted hit is over the word (up-down)').toBeGreaterThanOrEqual(want.top - 4);
    expect(centre.y, 'the painted hit is over the word (up-down)').toBeLessThanOrEqual(want.bottom + 4);
    expect(painted.width / (want.right - want.left), 'the painted hit is as wide as the word').toBeGreaterThan(0.7);
    expect(painted.width / (want.right - want.left), 'the painted hit is as wide as the word').toBeLessThan(1.4);
    expect((await paint(page)).others.length, 'the other "disincentive" on the page is painted in the quieter colour').toBeGreaterThanOrEqual(1);
    await snap(page, testInfo, '15-first-hit');
    expect(errors).toEqual([]);
  }, 120_000);
  await step('Enter and Shift+Enter step through the hits and wrap around; the arrow buttons do the same', async ({ openViewer, server }) => {
    const pages = [4, 4, 37, 38, 41, 41, 49]; // "disincentive", 1-based
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    await openFind(page);
    await page.keyboard.type('disincentive');
    await expectCount(page, 1, 7, 'typed');
    await expectCurrentOnPage(page, pages[0] - 1, 'hit 1');

    for (let k = 2; k <= 7; k++) {
      await page.keyboard.press('Enter');
      await expectCount(page, k, 7, `Enter to hit ${k}`);
      await expectCurrentOnPage(page, pages[k - 1] - 1, `hit ${k}`);
      if (k === 2) await expect(field(page), 'Enter leaves the keyboard in the box, so the next Enter steps again').toBeFocused();
      if (k === 4) await snap(page, testInfo, '15-hit-4-of-7');
    }
    await page.keyboard.press('Enter');
    await expectCount(page, 1, 7, 'Enter after the last hit wraps to the first');
    await expectCurrentOnPage(page, pages[0] - 1, 'wrapped to hit 1');
    await snap(page, testInfo, '15-wrapped-forward');

    await page.keyboard.press('Shift+Enter');
    await expectCount(page, 7, 7, 'Shift+Enter at the first hit wraps to the last');
    await expectCurrentOnPage(page, pages[6] - 1, 'wrapped back to hit 7');
    await page.keyboard.press('Shift+Enter');
    await expectCount(page, 6, 7, 'Shift+Enter steps back');
    await expectCurrentOnPage(page, pages[5] - 1, 'hit 6');

    // The buttons (guessed names: next, previous), in the same wrapping order.
    const buttons = bar(page).getByRole('button');
    const next = bar(page).getByRole('button', { name: /next|down/i }).or(buttons.nth(1)).first();
    const previous = bar(page).getByRole('button', { name: /prev|up/i }).or(buttons.nth(0)).first();
    await next.click();
    await expectCount(page, 7, 7, 'the next button');
    await next.click();
    await expectCount(page, 1, 7, 'the next button wraps too');
    await previous.click();
    await expectCount(page, 7, 7, 'the previous button wraps back');
    await previous.click();
    await expectCount(page, 6, 7, 'the previous button');
    expect(errors).toEqual([]);
  }, 120_000);
  await step('a word split by a line-end hyphen is found, counted once, and painted on both lines', async ({ openViewer, server }) => {
    // [word, total, pages (1-based), index of the hit PDFium shows split over two lines]
    const words: [string, number, number[], number][] = [
      ['contribution', 10, [2, 2, 2, 5, 23, 25, 37, 41, 46, 47], 3], // "contribu-" / "tion" on page 5
      ['estimation', 5, [7, 9, 13, 18, 28], 0], // "esti-" / "mation" on page 7
      ['entrepreneurship', 3, [2, 5, 43], 2], // "entrepreneur-" / "ship" on page 43
    ];
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    await openFind(page);
    for (const [word, total, pages, splitAt] of words) {
      await toTop(page);
      await fillQuery(page, word);
      await expectCount(page, 1, total, `"${word}" (the hit split at a line end counts as one)`);
      await stepForward(page, 1, splitAt, total);
      const rects = await expectCurrentOnPage(page, pages[splitAt] - 1, `the split hit of "${word}"`);
      expect(lineCount(rects), `"${word}" is split over two lines, so its highlight covers two lines`).toBe(2);
      await snap(page, testInfo, `15-split-${word}`);
      // And an ordinary hit of the same word is painted on one line.
      const ordinary = splitAt === 0 ? 1 : 0;
      await stepForward(page, splitAt + 1, (ordinary - splitAt + total) % total, total);
      const one = await expectCurrentOnPage(page, pages[ordinary] - 1, `an ordinary hit of "${word}"`);
      expect(lineCount(one), 'an unbroken word is highlighted on one line').toBe(1);
    }
    expect(errors).toEqual([]);
  }, 120_000);
  await step('ligatures match their letters: "first", "efficient", "profit" and "off" are found where the page prints ﬁ, ﬃ and ﬀ', async ({ openViewer, server }) => {
    // [file, [query typed, hits, first page of the first hit (1-based)]]  The ligature glyphs are in the files (checked with two readers).
    const sets: [string, [string, number, number][]][] = [
      [LEC1, [['first', 9, 2], ['efficient', 4, 1], ['EFFICIENT', 4, 1], ['ﬁrst', 9, 2], ['eﬃcient', 4, 1]]],
      [PSET, [['off', 7, 6], ['profit', 3, 1], ['efficient', 2, 1], ['oﬀ', 7, 6], ['proﬁt', 3, 1], ['eﬃcient', 2, 1]]],
    ];
    for (const [file, queries] of sets) {
      const page = await openViewer(server.url(file));
      const errors = watchErrors(page);
      await waitForFirstPage(page);
      await openFind(page);
      for (const [q, total, firstPage] of queries) {
        await toTop(page);
        await fillQuery(page, q);
        await expectCount(page, 1, total, `"${q}" in ${file.split('/').pop()}`);
        await expectCurrentOnPage(page, firstPage - 1, `the first hit of "${q}"`);
      }
      await snap(page, testInfo, `15-ligatures-${file.split('/').pop()!.slice(0, 12)}`);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 120_000);
  await step('case and accents do not matter, in either direction, and the hits are the words as printed', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    await openFind(page);
    // "Östling" is printed 5 times (pages 5, 5, 6, 6, 27) and "Bardóczy" once (page 5).
    for (const q of ['ostling', 'OSTLING', 'Östling', 'östling', 'ÖSTLING', 'OStLiNg']) {
      await toTop(page);
      await fillQuery(page, q);
      await expectCount(page, 1, 5, `"${q}"`);
      await expectCurrentOnPage(page, 4, `the first hit of "${q}"`);
    }
    for (const q of ['bardoczy', 'Bardóczy', 'BARDÓCZY']) {
      await fillQuery(page, q);
      await expectCount(page, 1, 1, `"${q}"`);
    }
    // The other direction: an accent typed over a plain letter of the page still finds it.
    // (Triage: a new search's current hit is the first at or after the page being read, as in Chrome, so only the total is
    // checked here; the reader is on page 5 after "bardoczy".)
    await fillQuery(page, 'disincentivé');
    await expectTotal(page, 7, 'an accent typed over a plain "e"');
    // Folding is not guessing: a respelling is a different word.
    await fillQuery(page, 'oestling');
    await expect.poll(async () => (await readBar(page)).noResults, { message: '"oestling" is not "Östling"', timeout: 10_000 }).toBe(true);
    await snap(page, testInfo, '15-accents');
    expect(errors).toEqual([]);
  }, 120_000);
  await step('a phrase is found across a line break, because a line break is a space', async ({ openViewer, server }) => {
    // [phrase, total, pages (1-based), indexes of the hits that PDFium has over two lines]
    const phrases: [string, number, number[], number[]][] = [
      ['average household', 5, [37, 37, 37, 40, 44], [0, 4]],
      ['fourth quartile', 3, [20, 23, 25], [1]],
    ];
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    await openFind(page);
    for (const [phrase, total, pages, broken] of phrases) {
      await toTop(page);
      await fillQuery(page, phrase);
      await expectCount(page, 1, total, `"${phrase}"`);
      for (let k = 1; k <= total; k++) {
        if (k > 1) {
          await page.keyboard.press('Enter');
          await expectCount(page, k, total, `Enter to hit ${k} of "${phrase}"`);
        }
        const rects = await expectCurrentOnPage(page, pages[k - 1] - 1, `hit ${k} of "${phrase}"`);
        if (broken.includes(k - 1)) {
          expect(lineCount(rects), `hit ${k} of "${phrase}" runs over a line break, so it covers two lines`).toBe(2);
          await snap(page, testInfo, `15-phrase-${phrase.replace(' ', '-')}-${k}`);
        } else {
          expect(lineCount(rects), `hit ${k} of "${phrase}" is on one line`).toBe(1);
        }
      }
    }
    // Case does not matter for a phrase either.
    await toTop(page);
    await fillQuery(page, 'Average HOUSEHOLD');
    await expectCount(page, 1, 5, 'the same phrase in other capitals');
    expect(errors).toEqual([]);
  }, 120_000);
});

test('Find: no results, Esc, selecting a hit, Back from a jump, a scan, and a 700-page book', async ({ step }, testInfo) => {
  test.setTimeout(900_000);
  await step('"No results" when nothing matches, and the old hits go away with the old query', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    await openFind(page);
    await fillQuery(page, 'disincentive');
    await expectCount(page, 1, 7, 'a word that is there');
    expect((await readBar(page)).noResults, 'no "No results" while there are hits').toBe(false);
    expect((await paintedRects(page)).length).toBeGreaterThan(0);

    await fillQuery(page, 'disincentivexq');
    await expect.poll(async () => (await readBar(page)).noResults, { message: 'the bar says "No results"', timeout: 10_000 }).toBe(true);
    expect((await readBar(page)).count, 'no count when there is nothing to count').toBeNull();
    await expect.poll(async () => (await paintedRects(page)).length, { message: 'the old hits are no longer painted' }).toBe(0);
    await snap(page, testInfo, '15-no-results');

    const before = await where(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(400);
    expect(near(await where(page), before), 'Enter with no hits goes nowhere').toBe(true);
    expect((await readBar(page)).noResults).toBe(true);

    await fillQuery(page, '');
    await expect.poll(async () => (await readBar(page)).noResults, { message: 'an empty box says nothing' }).toBe(false);
    expect((await readBar(page)).count).toBeNull();

    await fillQuery(page, 'generation');
    await expectCount(page, 1, 4, 'a new word after "No results"');
    expect(errors).toEqual([]);
  }, 120_000);
  await step('Esc closes the bar and takes the highlights with it; Ctrl+F opens it again', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    await openFind(page);
    await page.keyboard.type('disincentive');
    await expectCount(page, 1, 7, 'typed');
    await stepForward(page, 1, 2, 7); // now on the hit on page 37
    await expectCurrentOnPage(page, 36, 'hit 3');
    expect((await paintedRects(page)).length).toBeGreaterThan(0);

    await page.keyboard.press('Escape');
    await expect(field(page), 'Esc closes the bar').toBeHidden();
    await expect.poll(async () => (await paintedRects(page)).length, { message: 'the highlights go when the bar closes' }).toBe(0);
    await snap(page, testInfo, '15-after-esc');

    // The reader is back in the document: the page keys work again, and the page did not jump.
    const stay = await where(page);
    await page.keyboard.press('PageDown');
    await expect.poll(async () => (await where(page)).top, { message: 'PageDown scrolls the document once the bar is closed' }).toBeGreaterThan(stay.top + 100);

    await openFind(page);
    await expect(field(page), 'Ctrl+F opens the bar again').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(field(page)).toBeHidden();
    expect(errors).toEqual([]);
  }, 120_000);
  await step('Alt+Enter selects the current hit as real text, and Ctrl+C copies it', async ({ openViewer, server, context }) => {
    const reader = await openClipboardReader(context, server);
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);

    // [query, total, which hit (1-based), its page (1-based), what Ctrl+C must give: exactly this, or these letters]
    const cases: { q: string; total: number; hit: number; pageNo: number; exact?: string; letters?: string; words?: string }[] = [
      { q: 'disincentive', total: 7, hit: 3, pageNo: 37, exact: 'disincentive' },
      { q: 'disincentive', total: 7, hit: 4, pageNo: 38, letters: 'disincentive' }, // split over two lines: "disin-" / "centive"
      { q: 'ostling', total: 5, hit: 1, pageNo: 5, exact: 'Östling' }, // the page's own capital and accent, not what was typed
      { q: 'average household', total: 5, hit: 1, pageNo: 37, words: 'average household' }, // over a line break
    ];
    for (const c of cases) {
      await toTop(page);
      await openFind(page);
      await fillQuery(page, c.q);
      await expectCount(page, 1, c.total, `"${c.q}"`);
      await stepForward(page, 1, c.hit - 1, c.total);
      await expectCurrentOnPage(page, c.pageNo - 1, `hit ${c.hit} of "${c.q}"`);
      // A person looks at the highlighted word for a moment before pressing Alt+Enter; the page's text is there by then.
      await waitForTextLayer(page, c.pageNo - 1);
      await page.waitForTimeout(300);

      await page.keyboard.press('Alt+Enter');
      await expect(field(page), 'Alt+Enter closes the bar').toBeHidden();
      await expect.poll(async () => (await readSelection(page)).ranges.length, { message: 'Alt+Enter makes a real text selection', timeout: 10_000 }).toBe(1);
      const { ranges, domText } = await readSelection(page);
      expect(ranges[0].pageIndex, 'the selection is on the hit').toBe(c.pageNo - 1);
      const engine = await rangeText(page, ranges[0].pageIndex, ranges[0].start, ranges[0].end);
      expect(fold(engine), 'the selected chars are the hit').toBe(fold(c.q));
      expect(domText.length, 'the browser has the selection too (a real selection, not a painted one)').toBeGreaterThan(0);
      await snap(page, testInfo, `15-alt-enter-${c.q.replace(' ', '-')}-${c.hit}`);

      const copied = await copySelection(page, reader);
      expect(copied, 'Ctrl+C copied something').not.toBe('');
      if (c.exact !== undefined) expect(copied.trim()).toBe(c.exact);
      if (c.letters !== undefined) expect(lettersOnly(copied)).toBe(c.letters);
      if (c.words !== undefined) expect(collapse(copied)).toBe(c.words);
      await clearSelection(page);
    }
    expect(errors).toEqual([]);
    await reader.close();
  }, 120_000);
  // Triage: the spec says jumps are "collapsed, so Back returns to where you were without needing many presses to leave", and
  // Task 24's jump history keeps a chain of jumps as one entry. So the walk through the hits is one Back step, not one per hit.
  await step('the jumps to the hits are one Back step, which returns to where the reader was', async ({ openViewer, server }) => {
    const pages = [7, 32, 43, 49]; // "generation", 1-based; far apart on purpose
    const page = await openViewer(server.url(PAPER));
    const errors = watchErrors(page);
    await waitForFirstPage(page);
    const viewerUrl = new URL(page.url());
    const start = await where(page);
    expect(start.top, 'precondition: the paper opens at the top').toBeLessThanOrEqual(1);

    await openFind(page);
    await page.keyboard.type('generation');
    await expectCount(page, 1, 4, 'typed');
    await expectCurrentOnPage(page, pages[0] - 1, 'the first hit');
    for (let k = 2; k <= 4; k++) {
      await page.keyboard.press('Enter');
      await expectCount(page, k, 4, `Enter to hit ${k}`);
      await expectCurrentOnPage(page, pages[k - 1] - 1, `hit ${k}`);
    }
    const last = await where(page);
    await snap(page, testInfo, '15-before-back');

    await page.goBack({ timeout: 10_000 });
    await expect
      .poll(async () => near(await where(page), start), { message: `one Back returns to where the reader was before searching (page ${start.page + 1})`, timeout: 10_000 })
      .toBe(true);
    const now = new URL(page.url());
    expect([now.origin + now.pathname, now.searchParams.get('source')], 'Back stays in the viewer, on the same PDF').toEqual([
      viewerUrl.origin + viewerUrl.pathname,
      viewerUrl.searchParams.get('source'),
    ]);
    await snap(page, testInfo, '15-back-at-start');

    // Forward goes to the last hit again.
    await page.goForward({ timeout: 10_000 });
    await expect.poll(async () => (await where(page)).page, { message: 'Forward returns to the last hit', timeout: 10_000 }).toBe(last.page);
    expect(errors).toEqual([]);
  }, 120_000);
  await step('on a scan with no text, the bar says so instead of "No results"', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(SCAN));
    const errors = watchErrors(page);
    await waitReady(page, 60_000);
    await openFind(page);
    await page.keyboard.type('the');
    const scanMessage = /\b(scan|scanned|no text|no searchable text|not searchable|can.?t search|cannot search|isn.?t searchable|text recognition|ocr)\b/i;
    await expect
      .poll(async () => scanMessage.test((await readBar(page)).text), {
        message: 'the bar should say that this PDF is a scan / has no text to search (any wording about scans or missing text)',
        timeout: 60_000,
        intervals: [200, 400, 800],
      })
      .toBe(true);
    const shown = await readBar(page);
    expect(shown.noResults, `a scan must not just say "No results" (it said: "${shown.text}")`).toBe(false);
    expect(shown.count, 'there is nothing to count on a scan').toBeNull();
    expect((await paintedRects(page)).length, 'nothing is painted on a scan').toBe(0);
    await snap(page, testInfo, '15-scan-message');

    // The bar still works as a bar: Esc closes it.
    await page.keyboard.press('Escape');
    await expect(field(page)).toBeHidden();
    expect(errors).toEqual([]);
  }, 120_000);
  await step('a 700-page book: hits stream in from the current page and scrolling and typing stay smooth', async ({ openViewer, server }) => {
    const DEBOUNCE_MS = 150; // FindController.setQuery: "150 ms debounce"
    const FIRST_HIT_MS = DEBOUNCE_MS + budgetMs(100) + 50; // the first hit "within about 100 ms", after the debounce, plus a frame or two
    const STALL_MS = budgetMs(200); // no frame is held up longer than this
    const INPUT_MS = budgetMs(100); // a key press reaches the page's input handler within this
    const SCROLL_EXTRA_MS = budgetMs(150); // searching may add this much to the time a wheel turn takes to move the page

    const page = await openViewer(server.url(BOOK));
    const errors = watchErrors(page);
    await waitReady(page, 90_000);
    const doc = await rt(page).doc();
    expect(doc!.pageCount, 'precondition: the book has 714 pages').toBe(714);
    const START = 299; // page 300
    await rt(page).scrollToPage(START);
    await expect.poll(() => rt(page).currentPage()).toBe(START);
    await page.waitForTimeout(500);

    // One wheel turn: how long until the page has moved, as the test sees it (this includes the test tool's own round trips).
    const cx = 640;
    const cy = 450;
    await page.mouse.move(cx, cy);
    const wheelTurn = async (what: string): Promise<number> => {
      const was = await rt(page).scrollTop();
      const t0 = Date.now();
      await page.mouse.wheel(0, 500);
      await expect.poll(async () => Math.abs((await rt(page).scrollTop()) - was), { message: `${what} moves the page`, timeout: 10_000, intervals: [10, 20, 40] }).toBeGreaterThan(1);
      return Date.now() - t0;
    };
    // With no search running, so that the bound below is "what searching adds" and not this machine's own speed.
    const idle: number[] = [];
    for (let i = 0; i < 4; i++) {
      idle.push(await wheelTurn(`idle wheel turn ${i + 1}`));
      await page.waitForTimeout(150);
    }
    await rt(page).scrollToPage(START);
    await expect.poll(() => rt(page).currentPage()).toBe(START);
    await page.waitForTimeout(500);

    // Probes that live in the page: frame gaps, key-to-handler delay, and when the first count appears after the last key.
    await page.evaluate(() => {
      type Count = { current: number; total: number };
      const w = window as unknown as { __find: { maxGap: number; last: number; inputMax: number; lastKeyAt: number; firstCountAt: number | null; firstCount: Count | null; stop: boolean } };
      const s = { maxGap: 0, last: performance.now(), inputMax: 0, lastKeyAt: 0, firstCountAt: null as number | null, firstCount: null as Count | null, stop: false };
      w.__find = s;
      const tick = (t: number) => {
        s.maxGap = Math.max(s.maxGap, t - s.last);
        s.last = t;
        if (!s.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame((t) => {
        s.last = t;
        requestAnimationFrame(tick);
      });
      addEventListener(
        'input',
        (e) => {
          s.inputMax = Math.max(s.inputMax, performance.now() - e.timeStamp);
          s.lastKeyAt = performance.now();
          s.firstCountAt = null;
          s.firstCount = null;
        },
        true,
      );
      const count = (): Count => {
        const box = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="search"]'))[0];
        let node: HTMLElement | null = box ?? null;
        while (node && node.querySelectorAll('button').length < 3) node = node.parentElement;
        const m = node ? /(\d[\d,.]*)\s+of\s+(\d[\d,.]*)/i.exec(node.innerText) : null;
        return m ? { current: Number(m[1].replace(/[^\d]/g, '')), total: Number(m[2].replace(/[^\d]/g, '')) } : { current: 0, total: 0 };
      };
      // Triage (R65 round): the count is kept as it was the moment it first showed. Read later, the stream has moved on (on a
      // loaded box the bar already said "60 of …" because hits before page 300 had come in), so the test waits on the stream's
      // own first count instead of reading the bar some time after it.
      new MutationObserver(() => {
        if (s.firstCountAt !== null || s.lastKeyAt === 0) return;
        const c = count();
        if (c.total >= 1) {
          s.firstCountAt = performance.now();
          s.firstCount = c;
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const probes = () =>
      page.evaluate(() => {
        const s = (window as unknown as { __find: { inputMax: number; lastKeyAt: number; firstCountAt: number | null; firstCount: { current: number; total: number } | null } }).__find;
        return { inputMax: s.inputMax, firstHitMs: s.firstCountAt === null ? null : s.firstCountAt - s.lastKeyAt, firstCount: s.firstCount };
      });
    // The longest gap between frames since the last call, which starts the next window. Screenshots stall the page's frames by
    // themselves, so each one is taken between two windows and its own window is thrown away.
    const takeGap = () =>
      page.evaluate(() => {
        const s = (window as unknown as { __find: { maxGap: number; last: number } }).__find;
        const g = s.maxGap;
        s.maxGap = 0;
        s.last = performance.now();
        return g;
      });
    const gaps: number[] = [];

    await openFind(page);
    await page.keyboard.type('the'); // 17,133 hits in this book: the heaviest honest query
    await expect.poll(async () => (await probes()).firstHitMs, { message: 'a first hit shows', timeout: 20_000, intervals: [25, 50, 100] }).not.toBeNull();
    const first = await probes();
    expect(first.firstHitMs!, `the first hit shows within the debounce plus about 100 ms of the last key (${budgetNote(100)}; the debounce is ${DEBOUNCE_MS} ms)`).toBeLessThanOrEqual(FIRST_HIT_MS);
    expect(first.firstCount?.current, 'the search starts from the page being read, so the first hit is the first one there').toBe(1);
    await expect
      .poll(async () => (await paint(page)).current[0]?.pageIndex ?? -1, { message: 'the first hit is painted on or just after the page being read (page 300)', timeout: 10_000 })
      .toBeGreaterThanOrEqual(START);
    expect((await paint(page)).current[0].pageIndex!, 'the first hit is near the page being read, not at the top of the book').toBeLessThanOrEqual(START + 2);
    gaps.push(await takeGap());
    await snap(page, testInfo, '15-book-first-hit');
    await takeGap();

    // While the rest of the book is still being searched, scroll: the page moves at once, every time.
    const totalThen = (await readBar(page)).count!.total;
    const wheel: number[] = [];
    for (let i = 0; i < 6; i++) {
      wheel.push(await wheelTurn(`wheel turn ${i + 1} while results stream`));
      await page.waitForTimeout(80);
    }
    const streamed = (await readBar(page)).count!.total;
    testInfo.annotations.push({ type: 'stream', description: `count when scrolling began: ${totalThen}; after six wheel turns: ${streamed}; wheel-to-move ms: ${wheel.join(', ')}` });

    // And keep typing: the new letters land at once, and the old search is dropped for the new one.
    await field(page).focus();
    const reading = await rt(page).currentPage();
    await page.keyboard.press('End');
    await page.keyboard.type(' convex', { delay: 30 });
    await expect(field(page), 'the letters typed while results stream all arrive').toHaveValue('the convex');
    await expectTotal(page, 79, '"the convex" in the whole book (an old "the" search must not leak in)', 120_000);
    // Triage: a new search starts at the first hit at or after the page being read (as Chrome's does), not at hit 1.
    await expect
      .poll(async () => (await paint(page)).current[0]?.pageIndex ?? -1, { message: `the new search's current hit is at or after the page being read (page ${reading + 1})`, timeout: 10_000 })
      .toBeGreaterThanOrEqual(reading);
    const k = (await readBar(page)).count!.current;
    await page.keyboard.press('Enter');
    await expectCount(page, (k % 79) + 1, 79, 'Enter steps once the whole book is searched');
    gaps.push(await takeGap());
    await snap(page, testInfo, '15-book-done');

    const end = { ...(await probes()), maxGap: Math.max(...gaps) };
    const description = `longest frame gap ${Math.round(end.maxGap)} ms, slowest key ${Math.round(end.inputMax)} ms, first hit ${Math.round(first.firstHitMs!)} ms after the last key; wheel turns idle ${idle.join('/')} ms, streaming ${wheel.join('/')} ms`;
    testInfo.annotations.push({ type: 'responsiveness', description });
    console.log(`15-find book: ${description}`);
    const SCROLL_MS = Math.max(...idle) + SCROLL_EXTRA_MS;
    expect(Math.max(...wheel), `every wheel turn moves the page within ${SCROLL_MS} ms (the slowest idle turn, ${Math.max(...idle)} ms, plus ${SCROLL_EXTRA_MS} ms for searching; ${budgetNote(150)}); took ${wheel.join(', ')} ms`).toBeLessThanOrEqual(SCROLL_MS);
    expect(end.inputMax, `a key reaches the page within ${INPUT_MS} ms while results stream (${budgetNote(100)})`).toBeLessThanOrEqual(INPUT_MS);
    expect(end.maxGap, `the page never stalls longer than ${STALL_MS} ms between frames while results stream (${budgetNote(200)})`).toBeLessThanOrEqual(STALL_MS);
    expect(errors).toEqual([]);
  }, 300_000);
});
