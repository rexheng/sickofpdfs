// Walkthrough 12, the rail: "F4 opens thumbnails and outline" (Task 24).
// Spec: Reading basics, "Navigate: Thumbnails, outline, ... go to page"; shortcuts, "Notes panel / thumbnails and outline: Shift+F4 / F4";
// criterion 6, "Print, find, zoom, rotate, links, outline, thumbnails ... work at least as well as in Chrome's viewer"; Viewer specifics,
// "At narrow widths ... the thumbnail rail collapses first".
// Interface file (Task 24): a rail with "Thumbnails" and "Outline" toggles (Outline hidden when the PDF has no outline); thumbnails are
// 73 px wide pictures with the page number beside them; the current page's thumbnail has `outline: 2px solid`; a "Hide navigation
// pane" pill; collapsed by default when innerWidth < 1100; the outline is role="tree" and each treeitem's aria-label is its title;
// "Thumbnail and outline clicks do not touch history".
//
// The rail is found the way a person sees it: a "Hide navigation pane" pill, toggles with their names, pictures with a number beside
// them. The numbers on the pages of book-400 are read from the screen.
import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { FIXTURES, ensureBook, served } from './support/fixtures.spec-blind';
import {
  ATTENTION,
  type Thumb,
  clickThumb,
  expectRailOpen,
  hidePill,
  historyInfo,
  isJumpState,
  openRail,
  outlineTree,
  pointVisible,
  railOpen,
  railToggle,
  thumb,
  thumbs,
  treeItem,
} from './support/nav.spec-blind';
import { decodePng, inkBox } from './support/pixels.spec-blind';
import { expect, hooks, rt, settled, shoot, snap, test, waitForFirstPage, waitForPageOnScreen } from './support/viewer.spec-blind';

test.beforeAll(async () => {
  await ensureBook();
});

/** The thumbnail has something drawn on it: some dark ink on the screen where its picture is. */
async function thumbHasInk(page: Page, t: Thumb): Promise<boolean> {
  const img = decodePng(await page.screenshot());
  const ratio = img.width / (await page.evaluate(() => window.innerWidth));
  return inkBox(img, ratio, t.rect, 150) !== null;
}

/** Page `n` has the only ring, and its thumbnail is on screen (the rail scrolled to it). */
async function expectCurrentThumb(page: Page, n: number, why: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const all = await thumbs(page);
        const rung = all.filter((t) => t.ring).map((t) => t.n);
        const mine = all.find((t) => t.n === n);
        return JSON.stringify({ ringed: rung, onScreen: mine?.onScreen ?? false });
      },
      { message: `${why}: the only ringed thumbnail should be page ${n}, and it should be on screen`, timeout: 6_000, intervals: [60, 120, 250] },
    )
    .toBe(JSON.stringify({ ringed: [n], onScreen: true }));
}

test('F4 opens the rail, pressing the thumbnail for page 5 shows page 5, and F4 shuts it again', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);

  // F4 toggles, whichever way the window starts (the interface file opens it by default only on a wide window).
  const wasOpen = await railOpen(page);
  await page.keyboard.press('F4');
  await expectRailOpen(page, !wasOpen);
  if (wasOpen) {
    await page.keyboard.press('F4');
    await expectRailOpen(page, true);
  }
  await expect.poll(async () => (await thumbs(page)).length, { message: 'the rail shows thumbnails', timeout: 8_000 }).toBeGreaterThan(3);
  await snap(page, testInfo, '12-rail-open');

  // Small pictures, 73 px wide, drawn (not blank), numbered, and not covering the page.
  const first = (await thumb(page, 1))!;
  expect(first, 'there is a thumbnail for page 1').toBeDefined();
  expect(Math.abs(first.rect.width - 73), `thumbnails are 73 px wide (this one is ${first.rect.width})`).toBeLessThanOrEqual(3);
  await expect.poll(async () => thumbHasInk(page, (await thumb(page, 1))!), { message: 'the thumbnail of page 1 gets a picture', timeout: 8_000 }).toBe(true);
  const shot = await shoot(page);
  const pageOne = shot.canvases.find((c) => c.page === 0);
  expect(pageOne, 'page 1 is still on screen with the rail open').toBeDefined();
  expect(first.rect.x + first.rect.width, 'the rail does not cover the page').toBeLessThanOrEqual(pageOne!.x + 1);
  await expect.poll(async () => (await thumb(page, 1))?.ring, { message: 'on page 1 the current thumbnail is the first one' }).toBe(true);

  // A book with no outline: the Outline toggle is not offered.
  await expect(railToggle(page, 'Outline'), 'no outline in this PDF, so no Outline toggle').toBeHidden();

  // Press the thumbnail for page 5.
  const before = await historyInfo(page);
  await clickThumb(page, 5);
  await waitForPageOnScreen(page, 5, 8_000);
  expect(await rt(page).currentPage(), 'page 5 is the current page').toBe(4);
  await expectCurrentThumb(page, 5, 'after pressing page 5');
  await snap(page, testInfo, '12-after-thumbnail-5');
  const after = await historyInfo(page);
  expect(after.length, 'a thumbnail press adds no history entry').toBe(before.length);
  expect(isJumpState(after.state), 'a thumbnail press leaves no jump marker in the history state').toBe(false);

  // F4 again shuts the rail; the reader stays where they were.
  await page.keyboard.press('F4');
  await expectRailOpen(page, false);
  expect(await rt(page).currentPage(), 'shutting the rail does not move the reader').toBe(4);
  expect((await thumbs(page)).filter((t) => t.onScreen), 'a shut rail leaves no thumbnails on screen').toEqual([]);
  await snap(page, testInfo, '12-rail-shut');
});

test('the ringed thumbnail follows the page you are on, and the rail scrolls to show it', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(served(FIXTURES.book)));
  await waitForFirstPage(page);
  await openRail(page);
  await expectCurrentThumb(page, 1, 'at the start');

  // A jump far down the book (as the page box or a link would do).
  await rt(page).scrollToPage(11);
  await expectCurrentThumb(page, 12, 'after going to page 12');
  await snap(page, testInfo, '12-thumbnail-follows-12');
  await rt(page).scrollToPage(39);
  await expectCurrentThumb(page, 40, 'after going to page 40');
  await snap(page, testInfo, '12-thumbnail-follows-40');

  // Scrolling with the wheel, a little at a time, as one reads.
  const centre = await page.evaluate(() => {
    const r = document.querySelector('[role="document"]')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 700);
  await expect.poll(() => rt(page).currentPage(), { message: 'the wheel moved the reader down the book' }).toBeGreaterThan(40);
  await settled(() => rt(page).scrollTop(), 1, 3_000);
  const now = (await rt(page).currentPage()) + 1;
  await expectCurrentThumb(page, now, `after the wheel (the reader is on page ${now})`);

  // The two ends.
  await page.keyboard.press('End');
  await expectCurrentThumb(page, 400, 'at the end of the book');
  await snap(page, testInfo, '12-thumbnail-follows-end');
  await page.keyboard.press('Home');
  await expectCurrentThumb(page, 1, 'back at the start');
});

test.describe('a narrow window', () => {
  test.use({ viewport: { width: 1000, height: 700 } });

  test('starts with the rail shut so the pages have the room, and F4 opens it', async ({ openViewer, server }, testInfo) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await waitForFirstPage(page);
    expect(await railOpen(page), 'under 1100 px wide the rail starts collapsed').toBe(false);
    await expect(hidePill(page)).toBeHidden();
    expect((await thumbs(page)).filter((t) => t.onScreen), 'no thumbnails on screen').toEqual([]);
    await snap(page, testInfo, '12-narrow-shut');
    const pageOneShut = (await shoot(page)).canvases.find((c) => c.page === 0);

    await page.keyboard.press('F4');
    await expectRailOpen(page, true);
    await expect.poll(async () => (await thumbs(page)).length, { message: 'the rail shows thumbnails', timeout: 8_000 }).toBeGreaterThan(2);
    await snap(page, testInfo, '12-narrow-open');
    // Still reading page 1 with the rail open. Triage note (navprint): under 1100 px the plan lays the rail over the
    // pages ("F4 overlays it"; the pages do not reflow), so the check is that page 1 stays where it was, not that the
    // rail leaves it uncovered.
    const shot = await shoot(page);
    const pageOne = shot.canvases.find((c) => c.page === 0);
    expect(pageOne, 'page 1 is on screen').toBeDefined();
    expect(pageOneShut, 'page 1 was on screen before').toBeDefined();
    expect(Math.abs(pageOne!.x - pageOneShut!.x), 'the rail lies over the pages: page 1 does not move').toBeLessThanOrEqual(1);
    expect(Math.abs(pageOne!.cssWidth - pageOneShut!.cssWidth), 'and does not shrink').toBeLessThanOrEqual(1);
  });
});

test('the outline lists a paper\'s sections at every depth, and pressing one opens that section', async ({ openViewer, server }, testInfo) => {
  test.skip(!existsSync(ATTENTION.file), 'test-assets/classifier/learning/arxiv-1706.03762-attention.pdf is missing; run pnpm fixtures');
  const page = await openViewer(server.url(ATTENTION.url));
  await waitForFirstPage(page);
  await openRail(page);

  // What the engine reads from the file is the truth the panel is compared with.
  interface Node {
    title: string;
    target: { kind: 'page'; pageIndex: number; top: number | null; left: number | null } | { kind: 'url'; url: string } | null;
    children: Node[];
  }
  const outline = await hooks(page).eval<Node[]>((h) => h.backend.getOutline(h.doc()!.open.doc));
  const byTitle = (title: string, nodes: Node[] = outline): Node | undefined => {
    for (const n of nodes) {
      if (n.title === title) return n;
      const deeper = byTitle(title, n.children);
      if (deeper) return deeper;
    }
    return undefined;
  };
  expect(outline.length, 'precondition: the paper has an outline of 7 top-level sections').toBe(7);

  const toggle = railToggle(page, 'Outline');
  await expect(toggle, 'a PDF with an outline offers the Outline toggle').toBeVisible();
  await toggle.click();
  await expect(outlineTree(page), 'the outline is a tree').toBeVisible();
  await snap(page, testInfo, '12-outline-open');
  for (const top of outline) await expect(treeItem(page, top.title), `"${top.title}" is listed`).toBeVisible();

  const before = await historyInfo(page);
  /** Presses a row's title and checks the reader lands on its destination. */
  const openSection = async (title: string): Promise<void> => {
    const target = byTitle(title)?.target;
    if (!target || target.kind !== 'page') throw new Error(`precondition: "${title}" should go to a page`);
    await treeItem(page, title).click({ position: { x: 40, y: 10 } });
    await expect
      .poll(() => pointVisible(page, target.pageIndex, target.top ?? 0, target.left ?? 0), { message: `"${title}": its place (page ${target.pageIndex + 1}, ${Math.round(target.top ?? 0)} pt down) should be on screen`, timeout: 6_000 })
      .toBe(true);
    // A place far down its page can leave the next page the larger part of the window, so only a high one names the page.
    if ((target.top ?? 0) <= 400) expect(await rt(page).currentPage(), `"${title}" opens page ${target.pageIndex + 1}`).toBe(target.pageIndex);
  };
  /** Opens a parent row with the arrow key a tree uses, if it is shut. */
  const expand = async (title: string): Promise<void> => {
    const item = treeItem(page, title);
    if ((await item.getAttribute('aria-expanded')) === 'false') {
      await item.focus();
      await page.keyboard.press('ArrowRight');
      await expect(item, `"${title}" opens with the Right arrow`).toHaveAttribute('aria-expanded', 'true');
    }
  };

  // A top-level section, and one two levels down.
  await openSection('Results');
  await snap(page, testInfo, '12-outline-results');
  await expand('Results');
  await expect(treeItem(page, 'English Constituency Parsing'), 'the sections inside Results are listed').toBeVisible();
  await openSection('English Constituency Parsing');
  await expand('Model Architecture');
  await expand('Attention');
  await expect(treeItem(page, 'Multi-Head Attention'), 'three levels down is reachable').toBeVisible();
  await openSection('Multi-Head Attention');
  await snap(page, testInfo, '12-outline-three-deep');

  const after = await historyInfo(page);
  expect(after.length, 'outline presses add no history entry').toBe(before.length);
  expect(isJumpState(after.state), 'outline presses leave no jump marker').toBe(false);

  // Back to the thumbnails: the current page has the ring.
  await railToggle(page, 'Thumbnails').click();
  await expect(outlineTree(page)).toBeHidden();
  const here = (await rt(page).currentPage()) + 1;
  await expect.poll(async () => (await thumbs(page)).filter((t) => t.ring).map((t) => t.n), { message: 'thumbnails are back with the current page ringed' }).toEqual([here]);
  await snap(page, testInfo, '12-back-to-thumbnails');
});
