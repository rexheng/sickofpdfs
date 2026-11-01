// Walkthrough 13, links inside a PDF and Back (Task 24).
// Spec: Reading basics, "Navigate: ... links inside the PDF (contents, citations) and out to the web"; shortcuts paragraph, "Jumps inside a
// document (links, search results, next note) are kept in the page's history state and collapsed, so Back returns to where you were
// without needing many presses to leave."; Select-and-mark, "Alt+drag (links are ignored while Alt is held)".
// Interface file (Task 24): "a link with a scheme other than http, https or mailto is inert. Drags that start on a link still select
// text, and Alt ignores links."; page targets are <a class="sop-link" data-kind="page" href="#page=N">; URL targets are
// <a href rel="noopener noreferrer"> for http:, https: and mailto: only; before the first jump the viewer records where you were,
// then adds ONE history entry; later jumps replace that entry; Back goes to the recorded place. "Thumbnail and outline clicks do not
// touch history. Internal links and find results do."
//
// The documents: nav-8 (see support/nav.spec-blind.ts) for exact positions, and a real arXiv paper for real destinations.
// People press links with the mouse; Back is the browser's Back (page.goBack(), which is what the Back button and Alt+Left do).
import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { FIXTURES, ensureBook, served } from './support/fixtures.spec-blind';
import {
  ATTENTION,
  NAV_LINKS,
  SENTENCE_END_X,
  bringIntoView,
  clickLink,
  ensureNav,
  historyInfo,
  isJumpState,
  linkSpot,
  navUrl,
  placeAt,
  pointVisible,
  watchStrays,
} from './support/nav.spec-blind';
import { steadyScroll } from '../support/test';
import { expect, hooks, rt, scrollerRect, settled, snap, test, waitForFirstPage, waitForPageOnScreen } from './support/viewer.spec-blind';

test.beforeAll(async () => {
  await ensureBook();
  await ensureNav();
});

interface Place {
  scrollTop: number;
  scale: number;
}
const placeOf = async (page: Page): Promise<Place> => ({ scrollTop: await rt(page).scrollTop(), scale: await rt(page).scale() });

/** The reader is back exactly where `at` was: the same distance down the document at the same zoom. */
async function expectBackAt(page: Page, at: Place, why: string): Promise<void> {
  await expect
    .poll(async () => Math.abs((await rt(page).scrollTop()) - at.scrollTop), { message: `${why}: the scroll position should be ${at.scrollTop} px`, timeout: 6_000, intervals: [60, 120, 250] })
    .toBeLessThanOrEqual(3);
  await expect.poll(async () => Math.abs((await rt(page).scale()) - at.scale), { message: `${why}: the zoom should be ${at.scale}`, timeout: 3_000 }).toBeLessThanOrEqual(0.005);
}

/** The reader is shown the destination of `goes`: its place is in the window. */
async function expectLanded(page: Page, goes: { page: number; top: number }, why: string): Promise<void> {
  await expect
    .poll(() => pointVisible(page, goes.page, goes.top), { message: `${why}: page ${goes.page + 1}, ${goes.top} pt down, should be on screen`, timeout: 6_000, intervals: [60, 120, 250] })
    .toBe(true);
  await settled(() => rt(page).scrollTop(), 1, 2_000);
  expect(await pointVisible(page, goes.page, goes.top), `${why}: and stay on screen once the scrolling stops`).toBe(true);
}

test('a contents link jumps to its section and Back returns to the exact spot, zoom and all, every time', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(navUrl));
  await waitForFirstPage(page);
  const strays = watchStrays(page);
  await placeAt(page, 100); // 100% zoom, a little way down page 1, so that "the top of the page" would be the wrong place to come back to
  const h0 = await historyInfo(page);

  for (const round of [1, 2]) {
    const spot = await linkSpot(page, 'contents');
    const start = await placeOf(page);
    await page.mouse.click(spot.x, spot.y);
    await expectLanded(page, NAV_LINKS.contents.goes, `round ${round}: the contents link`);
    await waitForPageOnScreen(page, 4, 8_000);
    expect((await rt(page).currentPage()) + 1, `round ${round}: the reader is on page 4`).toBe(4);
    await snap(page, testInfo, `13-contents-jumped-${round}`);
    const h1 = await historyInfo(page);
    expect(h1.length, `round ${round}: a jump adds exactly one history entry`).toBe(h0.length + 1);

    // Change the zoom after the jump: the earlier zoom is part of "where you were".
    await page.keyboard.press('Control+=');
    await expect.poll(() => rt(page).scale()).toBeGreaterThan(start.scale + 0.05);

    await page.goBack();
    await expectBackAt(page, start, `round ${round}: after Back`);
    expect((await rt(page).currentPage()) + 1, `round ${round}: back on page 1`).toBe(1);
    await snap(page, testInfo, `13-contents-back-${round}`);
    expect((await historyInfo(page)).href.replace(/#.*$/, ''), 'Back stayed in the viewer').toBe(h0.href.replace(/#.*$/, ''));
  }
  expect(strays.dialogs, 'no alert, confirm or prompt').toEqual([]);
  expect(strays.opened, 'no new tab or window').toEqual([]);
});

test('a chain of jumps is one step back, and Alt+Left goes Back once', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(navUrl));
  await waitForFirstPage(page);
  await placeAt(page, 100);
  const h0 = await historyInfo(page);

  // Alt+Left is the browser's Back. The viewer must not use it for its own arrow-key paging, nor swallow it without going Back.
  await page.evaluate(() => {
    const w = window as unknown as { __altLeft: boolean[] };
    w.__altLeft = [];
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft') setTimeout(() => w.__altLeft.push(e.defaultPrevented), 0);
    });
  });

  const start = await (async () => {
    await linkSpot(page, 'contents'); // scrolls the link into view, if it is not
    return placeOf(page);
  })();
  const chain: { id: 'contents' | 'next' | 'back'; why: string }[] = [
    { id: 'contents', why: 'jump 1, from the contents to page 4' },
    { id: 'next', why: 'jump 2, from page 4 to page 7' },
    { id: 'back', why: 'jump 3, from page 7 to page 2' },
  ];
  for (const { id, why } of chain) {
    await clickLink(page, id);
    const goes = NAV_LINKS[id].goes;
    await expectLanded(page, goes, why);
    const h = await historyInfo(page);
    expect(h.length - h0.length, `${why}: all the jumps so far share one history entry`).toBe(1);
  }
  expect((await rt(page).currentPage()) + 1, 'the chain ends on page 2').toBe(2);
  await snap(page, testInfo, '13-chain-end');

  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __altLeft: boolean[] }).__altLeft.length), { message: 'the page saw Alt+Left' }).toBe(1);
  // Triage note (navprint): the viewer may run Alt+Left itself (history.back()) and prevent Chrome's copy, so the key
  // goes Back once wherever the focus is. What counts is one Back; a viewer that swallows the key must go Back itself.
  const prevented = await page.evaluate(() => (window as unknown as { __altLeft: boolean[] }).__altLeft[0]);
  // A real Chrome window goes Back on Alt+Left. The automated browser has no window frame to take that key, so if it did not move, use the Back button's call.
  let moved = false;
  for (const stop = Date.now() + 1_200; Date.now() < stop && !moved; ) {
    moved = Math.abs((await rt(page).scrollTop()) - start.scrollTop) <= 3;
    if (!moved) await page.waitForTimeout(100);
  }
  if (!moved) {
    expect(prevented, 'the viewer swallowed Alt+Left (preventDefault stops the browser going Back) but did not go Back itself').toBe(false);
    testInfo.annotations.push({ type: 'note', description: 'Alt+Left reached the page but the automated browser did not act on it; history.back() was used instead' });
    await page.goBack();
  }
  await expectBackAt(page, start, 'one Back after three jumps');
  expect((await rt(page).currentPage()) + 1, 'one Back is all it takes to be on page 1 again').toBe(1);
  await snap(page, testInfo, '13-chain-back');
  const h2 = await historyInfo(page);
  expect(h2.href.replace(/#.*$/, ''), 'still in the viewer after one Back').toBe(h0.href.replace(/#.*$/, ''));
});

test('ordinary scrolling, zooming and keys never add a history entry', async ({ openViewer, server }) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  const h0 = await historyInfo(page);

  const r = await scrollerRect(page);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
  for (const key of ['PageDown', 'PageDown', 'PageDown', 'ArrowDown', 'ArrowDown', 'Space', 'PageUp', 'End', 'Home', 'ArrowRight', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(40);
  }
  await steadyScroll(page, { pxPerSec: 3000, seconds: 1 });
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+0');
  await rt(page).scrollToPage(199);
  await page.mouse.wheel(0, -900);
  // The address follows the page 300 ms after it settles (replaceState): give that time to happen, so a bad implementation shows itself.
  await page.waitForTimeout(900);

  const h1 = await historyInfo(page);
  expect(h1.length, 'scrolling, zooming and paging added no history entry').toBe(h0.length);
  expect(isJumpState(h1.state), 'and left no jump marker in the history state').toBe(false);
});

const INERT = ['script', 'data', 'file', 'chrome', 'ftp'] as const;

test('a link that is not a page, http, https or mailto does nothing: no dialog, no navigation, no new tab', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(navUrl));
  await waitForFirstPage(page);
  await placeAt(page, 0);
  const strays = watchStrays(page);
  const address = strays.address();
  const h0 = await historyInfo(page);

  // What the page offers: only page links, and web or mail links that cannot reach back into the viewer.
  await expect.poll(() => page.locator('[data-page-index="0"] a').count(), { message: 'page 1 gets its link layer', timeout: 8_000 }).toBeGreaterThanOrEqual(5);
  const anchors = await page.$$eval('[data-page-index] a', (as) => as.map((a) => ({ href: a.getAttribute('href') ?? '', rel: a.getAttribute('rel') ?? '', kind: a.getAttribute('data-kind') ?? '' })));
  expect(anchors.length, 'page 1 offers its links').toBeGreaterThanOrEqual(5);
  for (const a of anchors) {
    expect(a.href, `an offered link points at a page, http, https or mailto (got "${a.href}")`).toMatch(/^(#page=\d+|https?:\/\/|mailto:)/i);
    if (!a.href.startsWith('#')) {
      const tokens = a.rel.split(/\s+/);
      expect(tokens, `the web or mail link ${a.href} has rel="noopener noreferrer"`).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
  }
  const web = anchors.filter((a) => a.href === NAV_LINKS.web.url);
  const mail = anchors.filter((a) => a.href === NAV_LINKS.mail.url);
  expect(web.length, 'the https link is offered once').toBe(1);
  expect(mail.length, 'the mailto link is offered once').toBe(1);
  expect(anchors.filter((a) => a.kind === 'page').length, 'the contents link, the citation and the sentence link are page links').toBeGreaterThanOrEqual(3);

  // Press each of the others where it is drawn. (The https and mailto links are left alone: they would leave the viewer.)
  for (const id of INERT) {
    await clickLink(page, id);
    await page.waitForTimeout(250);
    expect.soft(strays.dialogs, `${id} link: no alert, confirm or prompt`).toEqual([]);
    expect.soft(strays.opened, `${id} link: no new tab or window`).toEqual([]);
    expect.soft(strays.downloads, `${id} link: no download`).toEqual([]);
    expect.soft(strays.address(), `${id} link: the viewer's address did not change`).toBe(address);
    expect.soft((await historyInfo(page)).length, `${id} link: no history entry`).toBe(h0.length);
    expect.soft(await rt(page).state(), `${id} link: the viewer is still showing the PDF`).toBe('ready');
    expect.soft((await rt(page).currentPage()), `${id} link: still on page 1`).toBe(0);
  }
  await snap(page, testInfo, '13-inert-links-pressed');
});

test('a drag that starts on a link selects text instead of following it; Alt ignores links; a plain press still follows', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(navUrl));
  await waitForFirstPage(page);
  await placeAt(page, 400); // the sentence at 600 pt is well inside the window
  const strays = watchStrays(page);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
  const clearSelection = () => page.evaluate(() => window.getSelection()?.removeAllRanges());

  const sentence = NAV_LINKS.sentence;
  const y = sentence.top + sentence.h / 2;
  const at = (x: number) => bringIntoView(page, 0, x, y);
  const startFlat = await at(sentence.x + 20);
  const stayIn = await at(sentence.x + 80); // still inside the link (the link is 100 pt wide)
  const lineEnd = await at(SENTENCE_END_X); // past the last word
  const place = await placeOf(page);
  const h0 = await historyInfo(page);

  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
  };
  const notFollowed = async (why: string) => {
    await page.waitForTimeout(350);
    expect(await rt(page).currentPage(), `${why}: still on page 1`).toBe(0);
    expect(Math.abs((await rt(page).scrollTop()) - place.scrollTop), `${why}: the view did not move`).toBeLessThanOrEqual(2);
    expect((await historyInfo(page)).length, `${why}: no history entry`).toBe(h0.length);
  };

  // 1. A short drag that begins and ends inside the link: the case where a plain anchor would take it for a press.
  await drag(startFlat, stayIn);
  const short = norm(await selected());
  expect(short.length, 'dragging across some of the link\'s words selects them').toBeGreaterThanOrEqual(3);
  expect(sentence.text.includes(short), `the selection ("${short}") is words of that sentence`).toBe(true);
  await notFollowed('a drag inside the link');
  await snap(page, testInfo, '13-drag-inside-link');

  // 2. A long drag that starts on the link and runs to the end of the line.
  await clearSelection();
  await drag(startFlat, lineEnd);
  const long = norm(await selected());
  expect(long, 'dragging from the link to the end of the line selects the rest of the sentence too').toContain('by dragging from the first words to the end of this line');
  await notFollowed('a drag from the link to the end of the line');
  await snap(page, testInfo, '13-drag-from-link-to-end');

  // 3. Alt ignores links: Alt+press does not follow.
  await clearSelection();
  await page.keyboard.down('Alt');
  await page.mouse.click(startFlat.x, startFlat.y);
  await page.keyboard.up('Alt');
  await notFollowed('Alt+press on the link');

  // 4. And a plain press on the very same spot does follow (so the checks above are not passing for want of a live link).
  await clearSelection();
  await page.mouse.click(startFlat.x, startFlat.y);
  await expectLanded(page, sentence.goes, 'a plain press on the link');
  await snap(page, testInfo, '13-plain-press-followed');
  expect(strays.dialogs).toEqual([]);
});

test('a citation in a real paper jumps to its entry in the references, and Back returns to the exact spot', async ({ openViewer, server }, testInfo) => {
  test.skip(!existsSync(ATTENTION.file), 'test-assets/classifier/learning/arxiv-1706.03762-attention.pdf is missing; run pnpm fixtures');
  const page = await openViewer(server.url(ATTENTION.url));
  await waitForFirstPage(page);
  await rt(page).setScale(1);
  await settled(() => rt(page).scale());
  await rt(page).scrollToPage(1); // page 2 of the paper: many citations, whose targets are named destinations in the reference list

  // The links the file has on that page, as the engine reads them; the farthest-travelling one is the citation to press.
  interface Link {
    rect: { x: number; y: number; width: number; height: number };
    target: { kind: 'page'; pageIndex: number; top: number | null; left: number | null } | { kind: 'url'; url: string };
  }
  const links = await hooks(page).eval<Link[]>((h) => h.backend.getLinks(h.doc()!.open.doc, 1));
  // Only citations whose place is high on its page: then that page, not the next, is the one the reader is "on" after the jump.
  const pageLinks = links.filter((l): l is Link & { target: { kind: 'page'; pageIndex: number; top: number | null; left: number | null } } => l.target.kind === 'page' && l.target.top !== null && l.target.top <= 400);
  expect(pageLinks.length, 'precondition: page 2 of the paper has page links').toBeGreaterThan(10);
  const cite = pageLinks.reduce((far, l) => (Math.abs(l.target.pageIndex - 1) > Math.abs(far.target.pageIndex - 1) ? l : far));
  expect(cite.target.pageIndex, 'precondition: the citation points into the reference list near the end').toBeGreaterThanOrEqual(9);

  const spot = await bringIntoView(page, 1, cite.rect.x + cite.rect.width / 2, cite.rect.y + cite.rect.height / 2);
  const start = await placeOf(page);
  const h0 = await historyInfo(page);
  await snap(page, testInfo, '13-paper-before-citation');
  await page.mouse.click(spot.x, spot.y);
  await expectLanded(page, { page: cite.target.pageIndex, top: cite.target.top ?? 0 }, 'the citation');
  expect(await rt(page).currentPage(), 'the reader is in the reference list').toBe(cite.target.pageIndex);
  await snap(page, testInfo, '13-paper-after-citation');
  expect((await historyInfo(page)).length, 'one history entry for the jump').toBe(h0.length + 1);

  await page.goBack();
  await expectBackAt(page, start, 'after Back from the citation');
  expect(await rt(page).currentPage(), 'back on page 2 of the paper').toBe(1);
  await snap(page, testInfo, '13-paper-back');
});
