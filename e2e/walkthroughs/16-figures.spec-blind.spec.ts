// Walkthrough 16, figures, areas and pins (Phase 2 Round 3, slice S16). Gate 1, plan section 4 item 11 ("Figures (walkthrough 6, Test build 3)"):
//   "Hovering outlines a figure, and a click selects it. Ctrl+Alt+M makes a card with a thumbnail and the label 'Figure N · p. M'. The figure's
//    menu offers Comment and Copy image. Ctrl+C copies a PNG. A pin and an Alt+drag area both survive a reload. Links don't fire while Alt is held."
// plus "On scan-120.pdf, page, point and area notes all work" (item 7), and the speed bound of item 13 for the outline.
//
// Spec, "Figures and areas": "figures, charts, photos, tables and equation images are found on each page. Hovering one gives it a faint outline
// (nothing pops up); a click selects it, and Ctrl+Alt+M, or right-click -> Comment, comments on it. With nothing selected, Ctrl+Alt+M over a figure
// drops a numbered pin at that spot. Alt+drag (links are ignored while Alt is held), or the area tool in the toolbar, draws any rectangle, such as
// one panel of a chart or part of a scan. A figure comment shows an outline, not a highlight." "Figure and area anchor: the page and a rectangle in
// page units from 0 to 1. A figure anchor also keeps a fingerprint ... Pins and sub-areas are stored relative to the figure." Shortcuts: "Select a
// figure: Click"; "Copy a figure as an image: Ctrl+C, a figure is selected". Plan S16: "Hover shows a faint outline within 100 ms. A click without a
// drag selects the figure with a 2 px primary outline; a drag still selects text. Right-click offers Comment and Copy image ... Ctrl+C copies the
// figure as a PNG rendered at 2x ... Ctrl+Alt+M comments on the figure, with no highlight. With nothing selected over a figure, it drops a numbered
// pin. Alt+drag draws an area mark, or a sub-area inside a figure. Links are ignored while Alt is held. Figure cards show a 64 px thumbnail and a
// label." Research 06 section 4: "Cards for figure comments show a 64 px thumbnail ... and the label 'Figure 3 · p. 5'"; "Esc, or click on empty
// page: deselect"; "Drag inside the figure: text selection, as always (axis labels stay selectable)"; "F4 rail -> Figures tab". Design tokens (plan S4):
// the area outline, the faint 1 px hover outline and the solid 2 px selected outline.
//
// WHERE THE FIGURES ARE comes from the answer key of the figure reference set (e2e/reference/figures/labels.json), not from the product.
// WHAT IS DRAWN is judged from screenshots: an outline is a line along each side of the figure (support/rings.spec-blind.ts), found where the pixels
// changed, or where they have the colour of the design token. WHAT IS KEPT is read from the store (contracts section 2).
//
// GUESSES (the spec is silent): see the list at the end of p2r3-tests-report.md. The ones that decide a verdict here: the outline of a figure may sit
// a little inside or outside the hand-drawn box (the box found from the four lines must overlap it by 0.55 or more); a figure's comment keeps
// showing its outline when nothing is selected; the pin shows its number 1 as text or as an accessible name; the margin note of a figure carries
// "Figure N · Page M" in its text (ruling R74: "Page N" everywhere; plan 4 item 11 said "p. M") and a picture of at most 72 px; Ctrl+C hands
// the PNG to navigator.clipboard.write.
import type { Page } from '@playwright/test';
import { budgetMs, budgetNote } from '../support/perf-budget';
import { changed, dist, findRing, meanChange, near, describeRing, shareOf, variety, iou, type Frame, type Ring, type RGB } from '../support/rings.spec-blind';
import { expect, hooks, test } from '../support/test';
import { clearSelection, dragGlyphs, findOnPage, readSelection } from '../support/tl-blind.spec-blind';
import {
  AWAY,
  BODY_TEXT_POINT,
  FIG_COLUMN,
  FIG_PICTURE,
  FIG_PLOTS,
  altDrag,
  boxOfNorm,
  centreOf,
  clientOfPoint,
  clipboardWrites,
  copiedPngs,
  figureBox,
  grow,
  normOfBox,
  numberedPinNear,
  openFigurePaper,
  outlineTokens,
  pageSizePt,
  snapFrame,
  stableFrame,
  storedNotes,
  thumbnailOf,
  useClipboardRecorder,
  within,
  type Box,
  type FigureSpec,
} from './support/figures.spec-blind';
import {
  NO_SAVING,
  SAVING_AVAILABLE,
  SCAN,
  WIDE,
  allCards,
  answerSavePrompt,
  anyBox,
  boxOf,
  cardWith,
  markMenu,
  menuRow,
  note,
  pageRect,
  reloadAndWait,
  rightClickAt,
  settle,
  startNoteAnswering,
  swatch,
  waitSaved,
  waitStored,
  watchContextMenu,
} from './support/marks.spec-blind';
import { ensureNav, historyInfo, linkSpot, navUrl, openRail, placeAt, pointVisible, watchStrays } from './support/nav.spec-blind';
import { rt, waitReady } from './support/viewer.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(180_000);

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** How far from its spot a pin's centre may be (px): its tail is on the spot, not its middle. */
const PIN_NEAR = 30;

// ---------------------------------------------------------------------------------------------------------------
// A figure on the screen

interface View {
  page: Page;
  fig: FigureSpec;
  /** The figure's hand-drawn box, window px. */
  box: Box;
  centre: { x: number; y: number };
  /** How far from each side of the box an outline may lie. */
  band: number;
  /** What is photographed: the box and its surroundings. */
  clip: Box;
}

async function viewOf(page: Page, fig: FigureSpec): Promise<View> {
  const box = await figureBox(page, fig);
  const band = Math.max(20, 0.15 * Math.min(box.right - box.left, box.bottom - box.top));
  return { page, fig, box, centre: within(box, fig.aim.x, fig.aim.y), band, clip: grow(box, band + 12) };
}

/** The outline in `after`, found where it differs from `baseline` (the same clip with the pointer away and nothing selected). */
const outlineOf = (v: View, baseline: Frame, after: Frame, prefer?: RGB): Ring => findRing(after, changed(baseline, after), v.box, { band: v.band, ...(prefer ? { prefer } : {}) });

/**
 * Parks the pointer away, takes the picture of the figure's surroundings, then rests the pointer on the figure until its outline shows.
 * "Figure detection never delays drawing a page" (spec): it runs when the page is idle, so the first hover may come before it; the walkthrough
 * keeps trying for a while, and only then says there is no outline.
 */
async function warmUp(v: View): Promise<{ baseline: Frame; hover: Ring; shotMs: number }> {
  await v.page.mouse.move(AWAY.x, AWAY.y);
  const { frame: baseline, shotMs } = await stableFrame(v.page, v.clip);
  const deadline = Date.now() + 25_000;
  let last: Ring | null = null;
  while (Date.now() < deadline) {
    await v.page.mouse.move(v.centre.x, v.centre.y);
    await v.page.waitForTimeout(350);
    last = outlineOf(v, baseline, await snapFrame(v.page, v.clip));
    if (last.found === 4) return { baseline, hover: last, shotMs };
    await v.page.mouse.move(AWAY.x, AWAY.y);
    await v.page.waitForTimeout(500);
  }
  throw new Error(`no outline appeared on ${v.fig.label} of ${v.fig.paperId} (${v.fig.name}; hand-drawn box ${Math.round(v.box.left)},${Math.round(v.box.top)} to ${Math.round(v.box.right)},${Math.round(v.box.bottom)}) in 25 s of hovering it: ${last ? describeRing(last) : 'no picture was taken'}`);
}

const FIGURE_TYPES = [FIG_PICTURE, FIG_PLOTS];

// ---------------------------------------------------------------------------------------------------------------
// Hovering and clicking

for (const fig of FIGURE_TYPES) {
  test(`resting the pointer on ${fig.name} outlines it within the smoke bound, as a thin line, and nothing pops up; leaving takes it off`, async ({ openViewer, server }, testInfo) => {
    const page = await openFigurePaper(openViewer, server, fig);
    const v = await viewOf(page, fig);
    const { baseline, hover, shotMs } = await warmUp(v);
    note(testInfo, 'hover outline', describeRing(hover));
    expect(hover.iou, `the outline lies around the figure (${describeRing(hover)})`).toBeGreaterThanOrEqual(0.55);
    expect(hover.thickness, 'the hover is an outline of a pixel or two, not a fill or a frame').toBeLessThanOrEqual(3);
    await page.waitForTimeout(500);
    await shot(page, testInfo, 'hover-outline');

    // "Nothing pops up": no menu, no note box, no card, no dialog by itself.
    await expect(markMenu(page), 'no menu opens by itself').toHaveCount(0);
    await expect(anyBox(page), 'no note box opens by itself').toHaveCount(0);
    await expect(allCards(page), 'no card appears by itself').toHaveCount(0);
    await expect(page.getByRole('dialog'), 'no dialog opens by itself').toHaveCount(0);

    // "figure outline under 100 ms after hovering" (loose: perf-budget.ts). The time is measured with the picture-taking taken off.
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(AWAY.x, AWAY.y);
      await page.waitForTimeout(300);
      const t0 = Date.now();
      await page.mouse.move(v.centre.x, v.centre.y);
      for (;;) {
        const f = await snapFrame(page, v.clip);
        if (outlineOf(v, baseline, f).found === 4) break;
        if (Date.now() - t0 > 4000) throw new Error('the outline did not come back on the second hover');
      }
      times.push(Math.max(0, Date.now() - t0 - shotMs));
    }
    note(testInfo, 'outline after the pointer arrived, ms (5 tries, one picture-taking taken off)', times.map((t) => t.toFixed(0)).join(', '));
    expect(median(times), `the outline shows quickly (${budgetNote(100)})`).toBeLessThanOrEqual(budgetMs(100));
    const marks = await page.evaluate(() => performance.getEntriesByName('sop:figure-outline').length);
    expect.soft(marks, 'the page makes the perf mark the plan names, sop:figure-outline').toBeGreaterThan(0);

    // Leaving the figure takes the outline off.
    await page.mouse.move(AWAY.x, AWAY.y);
    await page.waitForTimeout(400);
    const gone = outlineOf(v, baseline, await snapFrame(page, v.clip));
    expect(gone.found, `the outline goes when the pointer leaves: ${describeRing(gone)}`).toBe(0);
  });

  test(`hovering and clicking plain text beside ${fig.name} outlines nothing`, async ({ openViewer, server }, testInfo) => {
    const page = await openFigurePaper(openViewer, server, fig);
    const v = await viewOf(page, fig);
    await warmUp(v); // the figure is found, so a false outline elsewhere would show
    await page.mouse.move(AWAY.x, AWAY.y);
    await page.waitForTimeout(300);
    const pageBox = await pageRect(page, fig.pageIndex);
    const { frame: quiet } = await stableFrame(page, pageBox);
    const { frame: quietFigure } = await stableFrame(page, v.clip);
    const body = BODY_TEXT_POINT[fig.paperId];
    const at = await clientOfPoint(page, fig.pageIndex, body.x, body.y);
    await page.mouse.move(at.x, at.y, { steps: 6 });
    await page.waitForTimeout(500);
    const hovered = await snapFrame(page, pageBox);
    expect(shareOf(hovered, changed(quiet, hovered), pageBox), 'hovering text changes nothing on the page (no outline, no chip)').toBeLessThan(0.0005);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(400);
    await clearSelection(page);
    const clicked = await snapFrame(page, v.clip);
    const ring = findRing(clicked, changed(quietFigure, clicked), v.box, { band: v.band });
    expect(ring.found, `a click on text does not select a figure: ${describeRing(ring)}`).toBe(0);
    await shot(page, testInfo, 'text-hovered-and-clicked');
  });

  test(`a click on ${fig.name} selects it with a solid 2 px blue outline; Esc and a click on the empty page both let go`, async ({ openViewer, server }, testInfo) => {
    const page = await openFigurePaper(openViewer, server, fig);
    const v = await viewOf(page, fig);
    const tokens = await outlineTokens(page);
    const { baseline, hover } = await warmUp(v);

    await page.mouse.click(v.centre.x, v.centre.y);
    await page.waitForTimeout(300);
    const selected = outlineOf(v, baseline, await snapFrame(page, v.clip), tokens.selected);
    note(testInfo, 'selected outline', describeRing(selected));
    expect(selected.found, `the click selects the figure: ${describeRing(selected)}`).toBe(4);
    expect(selected.iou, 'the outline lies around the figure').toBeGreaterThanOrEqual(0.55);
    expect(selected.thickness, 'the selected outline is 2 px, heavier than the faint hover line').toBeGreaterThanOrEqual(1.8);
    expect(selected.thickness, 'no thinner than the hover line').toBeGreaterThanOrEqual(hover.thickness);
    for (const side of [selected.top!, selected.bottom!, selected.left!, selected.right!]) {
      expect(dist(side.colour, tokens.selected), `the selected outline is the primary blue (${side.colour.join(',')} against ${tokens.selected.join(',')})`).toBeLessThanOrEqual(45);
    }
    expect((await readSelection(page)).ranges, 'a click selects the figure, not text').toHaveLength(0);
    await expect(markMenu(page), 'and opens no menu').toHaveCount(0);
    await shot(page, testInfo, 'figure-selected');

    // Esc lets go.
    await page.keyboard.press('Escape');
    await page.mouse.move(AWAY.x, AWAY.y);
    await page.waitForTimeout(400);
    const afterEsc = outlineOf(v, baseline, await snapFrame(page, v.clip));
    expect(afterEsc.found, `Esc deselects the figure: ${describeRing(afterEsc)}`).toBe(0);

    // A click on the empty page lets go too (the left margin of the page, level with the figure).
    await page.mouse.click(v.centre.x, v.centre.y);
    await page.waitForTimeout(300);
    expect(outlineOf(v, baseline, await snapFrame(page, v.clip)).found, 'selected again').toBe(4);
    const margin = await clientOfPoint(page, fig.pageIndex, 14, fig.rect.y + fig.rect.height / 2);
    await page.mouse.click(margin.x, margin.y);
    await page.waitForTimeout(400);
    const afterClick = outlineOf(v, baseline, await snapFrame(page, v.clip));
    expect(afterClick.found, `a click on the empty page deselects it: ${describeRing(afterClick)}`).toBe(0);
  });
}

test('a drag that starts on the text inside a figure still selects text (axis labels stay selectable), and Ctrl+C then copies words, not a picture', async ({ context, openViewer, server }, testInfo) => {
  await useClipboardRecorder(context);
  const fig = FIG_PLOTS;
  const page = await openFigurePaper(openViewer, server, fig);
  const v = await viewOf(page, fig);
  const tokens = await outlineTokens(page);
  const { baseline } = await warmUp(v);
  // Triage note: the axis labels of this paper are in a Type3 font with no Unicode map, so PDFium (and Chrome's viewer) has no "Time post" to
  // find; the panel label "(a)" inside the figure is real text, so the drag runs over it.
  const label = await findOnPage(page, fig.pageIndex, '(a)');
  const after = await dragGlyphs(page, fig.pageIndex, label.start, label.start + label.count - 1);
  expect(after.domText, 'the drag over a label inside the figure selects its words').toContain('(a)');
  expect(after.ranges.length).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const ring = outlineOf(v, baseline, await snapFrame(page, v.clip), tokens.selected);
  const looksSelected = ring.found === 4 && ring.thickness >= 1.8 && dist(ring.top!.colour, tokens.selected) <= 45;
  expect(looksSelected, `a drag is not a click: the figure is not selected (${describeRing(ring)})`).toBe(false);
  await shot(page, testInfo, 'drag-inside-figure');
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(600);
  expect((await copiedPngs(page)).length, 'Ctrl+C with words selected copies the words, not the figure as a picture').toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------
// Ctrl+Alt+M on a figure: the card

test('Ctrl+Alt+M on a selected figure makes a card with a 64 px thumbnail and "Figure 1 · Page 1"; the figure keeps an outline, no highlight; it is all back after a reload', async ({ openViewer, server }, testInfo) => {
  const fig = FIG_PICTURE;
  const page = await openFigurePaper(openViewer, server, fig);

  // A document note first, so that the margin column is open and the page is where it will stay: the figure's outline is then the only change.
  await page.mouse.move(AWAY.x, AWAY.y);
  await startNoteAnswering(page, 'Yes', 'Control+Alt+Shift+m');
  await page.keyboard.type('About the whole paper', { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, 'About the whole paper')).toBeVisible({ timeout: 5000 });
  await settle(page, 600);

  const v = await viewOf(page, fig);
  const tokens = await outlineTokens(page);
  await warmUp(v);
  const pageBefore = await pageRect(page, fig.pageIndex);
  await page.mouse.move(AWAY.x, AWAY.y);
  const plain = (await stableFrame(page, v.clip)).frame;

  await page.mouse.click(v.centre.x, v.centre.y);
  await page.waitForTimeout(300);
  expect(outlineOf(v, plain, await snapFrame(page, v.clip), tokens.selected).found, 'the figure is selected').toBe(4);

  await startNoteAnswering(page, 'Yes');
  await page.waitForTimeout(400);
  await shot(page, testInfo, 'figure-note-box');
  await page.keyboard.type('The picture shows the two topics', { delay: 8 });
  await page.keyboard.press('Enter');
  const card = cardWith(page, 'The picture shows the two topics');
  await expect(card, 'the note becomes a card').toBeVisible({ timeout: 5000 });
  await settle(page, 600);

  // The card says which figure and which page, and shows the figure small.
  await expect(card, 'the card is labelled "Figure 1 · Page 1"').toContainText(fig.cardLabel);
  const thumb = await thumbnailOf(card);
  expect(thumb, 'the card shows a picture of the figure').not.toBeNull();
  expect(Math.max(thumb!.width, thumb!.height), `the thumbnail is 64 px (it is ${thumb!.width.toFixed(0)} x ${thumb!.height.toFixed(0)})`).toBeGreaterThanOrEqual(56);
  expect(Math.max(thumb!.width, thumb!.height)).toBeLessThanOrEqual(72);
  expect(variety(thumb!.img), 'the thumbnail is a picture, not a blank box').toBeGreaterThan(0.05);
  const cardBox = await boxOf(card);
  expect(Math.abs(cardBox.top - v.box.top), `the card lines up with the top of the figure (card at ${cardBox.top.toFixed(0)}, figure at ${v.box.top.toFixed(0)})`).toBeLessThanOrEqual(90);
  await shot(page, testInfo, 'figure-card');

  // The outline stays as the comment's mark when nothing is selected, and the figure is not tinted.
  const margin = await clientOfPoint(page, fig.pageIndex, 14, fig.rect.y + fig.rect.height / 2);
  await page.mouse.click(margin.x, margin.y);
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.waitForTimeout(600);
  const pageAfter = await pageRect(page, fig.pageIndex);
  expect(Math.abs(pageAfter.left - pageBefore.left) + Math.abs(pageAfter.top - pageBefore.top), 'the page did not move when the comment was made, so the two pictures can be compared').toBeLessThanOrEqual(2);
  const marked = (await stableFrame(page, v.clip)).frame;
  const outline = outlineOf(v, plain, marked);
  note(testInfo, 'outline of the commented figure, nothing selected', describeRing(outline));
  expect(outline.found, `the commented figure keeps an outline: ${describeRing(outline)}`).toBe(4);
  expect(outline.iou).toBeGreaterThanOrEqual(0.55);
  expect(meanChange(plain, marked, v.box, 8), 'a figure comment is an outline, not a highlight: the figure itself is not tinted').toBeLessThan(4);
  await shot(page, testInfo, 'figure-comment-outline');

  const live = await hooks(page).eval((h) => h.annotations?.state().marks.map((m) => m.style) ?? null);
  expect(live, 'the notes model is published').not.toBeNull();
  expect(live!.filter((style) => style === 'highlight'), 'no highlight is made with a figure comment ("a figure comment shows an outline, not a highlight")').toEqual([]);

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    const a = await waitStored(page, (x) => x.threads.filter((t) => t.anchor.kind === 'figure').length === 1, 'a figure thread is stored');
    const t = a.threads.find((x) => x.anchor.kind === 'figure')! as unknown as { anchor: { page: number; rect: [number, number, number, number]; figure: { label: string | null } } };
    expect(t.anchor.page, 'on page 1 (index 0)').toBe(fig.pageIndex);
    expect(t.anchor.figure.label, 'with the figure\'s label in its fingerprint').toMatch(/figure\s*1/i);
    const size = await pageSizePt(page, fig.pageIndex);
    const want: [number, number, number, number] = [fig.rect.x / size.width, fig.rect.y / size.height, (fig.rect.x + fig.rect.width) / size.width, (fig.rect.y + fig.rect.height) / size.height];
    expect(iou({ left: t.anchor.rect[0], top: t.anchor.rect[1], right: t.anchor.rect[2], bottom: t.anchor.rect[3] }, { left: want[0], top: want[1], right: want[2], bottom: want[3] }), 'the stored rectangle (0 to 1 of the page) is the figure\'s').toBeGreaterThanOrEqual(0.55);
    expect(a.marks.filter((m) => m.style === 'highlight' && m.deletedAt === null), 'no highlight is stored with it').toHaveLength(0);

    // After a reload: the card, its label, its thumbnail and the outline are all back.
    await reloadAndWait(page, fig.fx);
    const back = cardWith(page, 'The picture shows the two topics');
    await expect(back, 'the figure comment is back after a reload').toBeVisible({ timeout: 10_000 });
    await expect(back).toContainText(fig.cardLabel);
    expect(await thumbnailOf(back), 'with its thumbnail').not.toBeNull();
    await settle(page, 800);
    await page.mouse.move(AWAY.x, AWAY.y);
    const boxBack = await figureBox(page, fig);
    expect(Math.abs(boxBack.left - v.box.left) + Math.abs(boxBack.top - v.box.top), 'the page is where it was before the reload, so the pictures can be compared').toBeLessThanOrEqual(3);
    const reloaded = (await stableFrame(page, v.clip)).frame;
    const again = outlineOf(v, plain, reloaded);
    expect(again.found, `the outline is back after a reload: ${describeRing(again)}`).toBe(4);
    await shot(page, testInfo, 'figure-comment-after-reload');
  } else {
    note(testInfo, 'reload', NO_SAVING);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The right-click menu, Copy image and Ctrl+C

test('right-clicking a figure offers Comment and Copy image; Copy image and Ctrl+C both put a PNG of the figure (2x) on the clipboard; Comment writes a note', async ({ context, openViewer, server }, testInfo) => {
  await useClipboardRecorder(context);
  const fig = FIG_PICTURE;
  const page = await openFigurePaper(openViewer, server, fig);
  const v = await viewOf(page, fig);
  await warmUp(v);

  // Right-clicking plain text with nothing selected is Chrome's own menu, as everywhere else.
  const body = BODY_TEXT_POINT[fig.paperId];
  const bodyAt = await clientOfPoint(page, fig.pageIndex, body.x, body.y);
  await clearSelection(page);
  const text = await watchContextMenu(page);
  await rightClickAt(page, bodyAt);
  const onText = await text();
  expect(onText.prevented, 'right-click on text with nothing selected leaves Chrome\'s menu alone').toBe(false);
  await expect(markMenu(page)).toHaveCount(0);

  // On a figure: our menu, with Comment and Copy image.
  await page.mouse.move(AWAY.x, AWAY.y);
  const read = await watchContextMenu(page);
  await rightClickAt(page, v.centre);
  await expect(markMenu(page), 'right-clicking a figure opens a menu').toBeVisible({ timeout: 3000 });
  expect((await read()).prevented, 'in place of Chrome\'s menu').toBe(true);
  await expect(menuRow(page, /^comment\b/i), 'the menu offers Comment').toBeVisible();
  await expect(menuRow(page, /^copy image\b/i), 'and Copy image').toBeVisible();
  const names = await markMenu(page).getByRole('menuitem').allInnerTexts();
  note(testInfo, 'figure menu items', names.map((n) => n.replace(/\s+/g, ' ').trim()).join(' | '));
  expect.soft(await swatch(page, 'green').count(), 'a figure has no highlight colours to pick').toBe(0);
  await shot(page, testInfo, 'figure-menu');

  // Copy image from the menu.
  await menuRow(page, /^copy image\b/i).click();
  await expect.poll(async () => (await copiedPngs(page)).length, { message: 'Copy image hands a PNG to the clipboard', timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const first = (await copiedPngs(page))[0];
  const scale = first.width / fig.rect.width;
  note(testInfo, 'copied picture', `${first.width} x ${first.height} px for a figure of ${fig.rect.width.toFixed(0)} x ${fig.rect.height.toFixed(0)} pt (x${scale.toFixed(2)})`);
  expect(scale, 'the picture is rendered at 2x (a figure of 198 pt is about 400 px)').toBeGreaterThanOrEqual(1.5);
  expect(scale).toBeLessThanOrEqual(3.1);
  expect((first.width / first.height) / (fig.rect.width / fig.rect.height), 'and it is the figure, not the page: the same shape').toBeGreaterThan(0.8);
  expect((first.width / first.height) / (fig.rect.width / fig.rect.height)).toBeLessThan(1.25);
  expect(variety(first), 'with the figure drawn in it').toBeGreaterThan(0.05);

  // Ctrl+C with the figure selected.
  await page.keyboard.press('Escape');
  await page.mouse.click(v.centre.x, v.centre.y);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+c');
  await expect.poll(async () => (await copiedPngs(page)).length, { message: 'Ctrl+C on a selected figure hands a PNG to the clipboard', timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const second = (await copiedPngs(page)).at(-1)!;
  expect(Math.abs(second.width - first.width) + Math.abs(second.height - first.height), 'Ctrl+C and Copy image give the same picture size').toBeLessThanOrEqual(4);
  const types = (await clipboardWrites(page)).map((w) => w.types.join(','));
  note(testInfo, 'clipboard writes', types.join(' | '));
  await shot(page, testInfo, 'figure-copied');

  // Comment from the menu writes a note on the figure.
  await rightClickAt(page, v.centre);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  await menuRow(page, /^comment\b/i).click();
  await startNoteAfterMenu(page);
  await page.keyboard.type('Comment from the menu', { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, 'Comment from the menu'), 'the menu\'s Comment makes a figure comment').toBeVisible({ timeout: 5000 });
  await expect(cardWith(page, 'Comment from the menu')).toContainText(fig.cardLabel);
});

/** After a menu's Comment: the note box is open (the prompt that asks about saving is answered Yes when it comes). */
async function startNoteAfterMenu(page: Page) {
  const box = page.getByRole('textbox', { name: /^(?!.*\b(?:reply|edit)\b).*\b(?:note|comment)\b/i });
  await Promise.race([box.waitFor({ state: 'visible', timeout: 2500 }).catch(() => undefined), page.getByText(/save this pdf to keep your notes/i).first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => undefined)]);
  await answerSavePrompt(page, 'Yes', 300);
  await expect(box, 'Comment opens a note box').toBeVisible({ timeout: 3000 });
  return box;
}

// ---------------------------------------------------------------------------------------------------------------
// A pin, and an Alt+drag area, survive a reload

test('with nothing selected, Ctrl+Alt+M over a figure drops a numbered pin; an Alt+drag area draws in the area colour and selects no text; both are back after a reload', async ({ openViewer, server }, testInfo) => {
  const fig = FIG_PICTURE;
  const page = await openFigurePaper(openViewer, server, fig);
  const v = await viewOf(page, fig);
  const tokens = await outlineTokens(page);
  await warmUp(v);

  // The pin: pointer on the figure, nothing selected.
  await clearSelection(page);
  const pin = within(v.box, 0.3, 0.7);
  await page.mouse.move(pin.x, pin.y);
  await page.waitForTimeout(300);
  const before = await pageRect(page, fig.pageIndex);
  const pinOnPage = { x: (pin.x - before.left) / (before.right - before.left), y: (pin.y - before.top) / (before.bottom - before.top) };
  await startNoteAnswering(page, 'Yes');
  await page.keyboard.type('A pin on the picture', { delay: 8 });
  await page.keyboard.press('Enter');
  const card = cardWith(page, 'A pin on the picture');
  await expect(card, 'the pin\'s note becomes a card').toBeVisible({ timeout: 5000 });
  await expect(card, 'a note on a figure says which figure').toContainText(fig.cardLabel);
  await settle(page, 700);
  const afterShift = await pageRect(page, fig.pageIndex);
  const pinNow = { x: afterShift.left + pinOnPage.x * (afterShift.right - afterShift.left), y: afterShift.top + pinOnPage.y * (afterShift.bottom - afterShift.top) };
  await page.mouse.move(AWAY.x, AWAY.y);
  // Triage note: the pin's tail (its square corner) sits on the spot and the 28 px marker stands above it, so its centre is about 20 px away;
  // "near" is 30 px (the first guess, 18 px, assumed a centred dot).
  const dot = await numberedPinNear(page, pinNow, 1, PIN_NEAR);
  expect(dot.found, `a small numbered pin (1) sits where the pointer was; small things near ${pinNow.x.toFixed(0)},${pinNow.y.toFixed(0)}: ${dot.seen.slice(0, 6).join(' / ') || 'none'}`).toBe(true);
  await shot(page, testInfo, 'pin-dropped');

  // The area: Alt+drag over the abstract (the left column), which has text in it.
  // Triage note: the top and bottom sides sit 4 pt higher than the first guess (300 and 385 pt), between two lines of text; there they ran
  // through the middle of a line, where the glyphs hide a 1 px line (measured: 2 of 4 sides found at 300/385, 4 of 4 at 296/381).
  const aFrom = await clientOfPoint(page, fig.pageIndex, 80, 296);
  const aTo = await clientOfPoint(page, fig.pageIndex, 250, 381);
  const dragBox: Box = { left: aFrom.x, top: aFrom.y, right: aTo.x, bottom: aTo.y };
  await clearSelection(page);
  await altDrag(page, aFrom, aTo);
  await answerSavePrompt(page, 'Yes', 500);
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.waitForTimeout(400);
  expect((await readSelection(page)).ranges, 'Alt+drag over text draws an area; it does not select the words').toHaveLength(0);
  const areaRing = findRing(await snapFrame(page, grow(dragBox, 20)), near(await snapFrame(page, grow(dragBox, 20)), tokens.area, 40), dragBox, { band: 8, prefer: tokens.area });
  note(testInfo, 'area outline', describeRing(areaRing));
  expect(areaRing.found, `the area is a rectangle in the area colour ${tokens.area.join(',')}: ${describeRing(areaRing)}`).toBe(4);
  expect(areaRing.iou, 'exactly where it was dragged').toBeGreaterThanOrEqual(0.9);
  await shot(page, testInfo, 'area-drawn');
  const dragNorm = await normOfBox(page, fig.pageIndex, dragBox);

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    await waitStored(page, (a) => a.marks.some((m) => m.style === 'area') && a.threads.some((t) => t.anchor.kind === 'figure'), 'the area and the pin are stored');
    const notes = await storedNotes(page);
    const area = notes.marks.find((m) => m.style === 'area')!;
    expect(area.anchor.kind, 'an area off any figure is an area anchor').toBe('area');
    expect(area.anchor.page, 'on page 1').toBe(fig.pageIndex);
    expect(area.color, 'an area has no colour slot').toBeNull();
    area.anchor.rect!.forEach((n, i) => expect(Math.abs(n - dragNorm[i]), `the stored rectangle (0 to 1 of the page) is the dragged one, coordinate ${i}`).toBeLessThan(0.02));
    const pinThread = notes.threads.find((t) => t.anchor.kind === 'figure')!;
    const rect = pinThread.anchor.rect!;
    const point = pinThread.anchor.sub?.point;
    expect(point, 'a pin is stored as a point inside the figure (sub.point)').toBeDefined();
    const relative = [(pinOnPage.x - rect[0]) / (rect[2] - rect[0]), (pinOnPage.y - rect[1]) / (rect[3] - rect[1])];
    expect(Math.abs(point![0] - relative[0]), 'the pin is stored relative to the figure: across').toBeLessThan(0.04);
    expect(Math.abs(point![1] - relative[1]), 'and down').toBeLessThan(0.04);

    // Reload: the card, the area and the pin are all back.
    await reloadAndWait(page, fig.fx);
    await expect(cardWith(page, 'A pin on the picture'), 'the pin\'s note is back after a reload').toBeVisible({ timeout: 10_000 });
    await settle(page, 800);
    await page.mouse.move(AWAY.x, AWAY.y);
    const areaBox = await boxOfNorm(page, fig.pageIndex, area.anchor.rect!);
    const f = await snapFrame(page, grow(areaBox, 20));
    const ring = findRing(f, near(f, tokens.area, 40), areaBox, { band: 8, prefer: tokens.area });
    expect(ring.found, `the area is back after a reload: ${describeRing(ring)}`).toBe(4);
    const figureBack = await boxOfNorm(page, fig.pageIndex, rect);
    const pinBack = { x: figureBack.left + point![0] * (figureBack.right - figureBack.left), y: figureBack.top + point![1] * (figureBack.bottom - figureBack.top) };
    const dotBack = await numberedPinNear(page, pinBack, 1, PIN_NEAR);
    expect(dotBack.found, `the numbered pin is back where it was: ${dotBack.seen.slice(0, 6).join(' / ') || 'nothing small near it'}`).toBe(true);
    await shot(page, testInfo, 'pin-and-area-after-reload');
  } else {
    note(testInfo, 'reload', NO_SAVING);
  }
});

test('an Alt+drag that starts inside a figure is a sub-area of that figure, stored relative to it, and it is back after a reload', async ({ openViewer, server }, testInfo) => {
  const fig = FIG_PLOTS;
  const page = await openFigurePaper(openViewer, server, fig);
  const v = await viewOf(page, fig);
  const tokens = await outlineTokens(page);
  await warmUp(v);
  await page.mouse.move(AWAY.x, AWAY.y);

  // Triage note: the right side ends at 0.36, inside panel (a); at 0.42 it lay on the panel's yellow colour bar, where a line in the area colour
  // cannot be seen (the drawn rectangle was there: 3 sides found, the fourth hidden by the bar).
  const from = within(v.box, 0.1, 0.1);
  const to = within(v.box, 0.36, 0.42);
  const dragBox: Box = { left: from.x, top: from.y, right: to.x, bottom: to.y };
  await clearSelection(page);
  await altDrag(page, from, to);
  await answerSavePrompt(page, 'Yes', 500);
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.waitForTimeout(400);
  expect((await readSelection(page)).ranges, 'Alt+drag over a chart\'s labels draws a region; it does not select their words').toHaveLength(0);
  const f = await snapFrame(page, grow(dragBox, 20));
  const ring = findRing(f, near(f, tokens.area, 40), dragBox, { band: 8, prefer: tokens.area });
  expect(ring.found, `a thin rectangle shows inside the figure, in the area colour: ${describeRing(ring)}`).toBe(4);
  await shot(page, testInfo, 'sub-area-drawn');
  const dragNorm = await normOfBox(page, fig.pageIndex, dragBox);

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    await waitStored(page, (a) => a.marks.length + a.threads.length > 0, 'the sub-area is stored');
    const notes = await storedNotes(page);
    const anchors = [...notes.marks.map((m) => m.anchor), ...notes.threads.map((t) => t.anchor)];
    const sub = anchors.find((a) => a.kind === 'figure' && a.sub?.rect !== undefined);
    expect(sub, `a region drawn inside a figure is stored as a figure anchor with sub.rect ("Pins and sub-areas are stored relative to the figure"); the stored anchors are ${JSON.stringify(anchors.map((a) => a.kind))}`).toBeDefined();
    const r = sub!.rect!;
    const rel = [(dragNorm[0] - r[0]) / (r[2] - r[0]), (dragNorm[1] - r[1]) / (r[3] - r[1]), (dragNorm[2] - r[0]) / (r[2] - r[0]), (dragNorm[3] - r[1]) / (r[3] - r[1])];
    sub!.sub!.rect!.forEach((n, i) => expect(Math.abs(n - rel[i]), `the sub-area is stored relative to the figure, coordinate ${i}`).toBeLessThan(0.04));
    expect(sub!.figure?.label, 'with the figure it belongs to').toMatch(/figure\s*1/i);

    await reloadAndWait(page, fig.fx);
    await settle(page, 1200);
    await page.mouse.move(AWAY.x, AWAY.y);
    const dragBack = await boxOfNorm(page, fig.pageIndex, dragNorm);
    const g = await snapFrame(page, grow(dragBack, 20));
    const back = findRing(g, near(g, tokens.area, 40), dragBack, { band: 8, prefer: tokens.area });
    expect(back.found, `the sub-area is back after a reload: ${describeRing(back)}`).toBe(4);
    await shot(page, testInfo, 'sub-area-after-reload');
  } else {
    note(testInfo, 'reload', NO_SAVING);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Links are ignored while Alt is held

test('an Alt+drag that starts on a link draws an area and does not follow the link; a plain click on the same link still does', async ({ openViewer, server }, testInfo) => {
  await ensureNav();
  const page = await openViewer(server.url(navUrl));
  await page.setViewportSize(WIDE);
  await waitReady(page);
  const tokens = await outlineTokens(page);
  const strays = watchStrays(page);

  // The control: a plain click on the contents link goes to page 4 ("3.2 Experimental setup").
  await placeAt(page, 0);
  const spot = await linkSpot(page, 'contents');
  await page.mouse.click(spot.x, spot.y);
  await expect.poll(() => pointVisible(page, 3, 318), { message: 'a plain click on the link follows it (the control)', timeout: 6000 }).toBe(true);
  await placeAt(page, 0);
  const history = await historyInfo(page);

  // Alt+drag from the same spot.
  const from = await linkSpot(page, 'contents');
  const to = { x: from.x + 160, y: from.y + 22 };
  const top0 = await rt(page).scrollTop();
  await altDrag(page, from, to);
  await answerSavePrompt(page, 'Yes', 500);
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.waitForTimeout(500);
  expect(await pointVisible(page, 3, 318), 'Alt held: the link is not followed (page 4 is not shown)').toBe(false);
  expect(Math.abs((await rt(page).scrollTop()) - top0), 'and the page did not move').toBeLessThanOrEqual(2);
  const after = await historyInfo(page);
  expect(after.length, 'and no history entry was added').toBe(history.length);
  expect(after.state, 'and no jump was recorded').toEqual(history.state);
  expect(strays.opened, 'no tab opened').toEqual([]);
  const dragBox: Box = { left: from.x, top: from.y, right: to.x, bottom: to.y };
  const frame = await snapFrame(page, grow(dragBox, 20));
  const ring = findRing(frame, near(frame, tokens.area, 40), dragBox, { band: 8, prefer: tokens.area });
  expect(ring.found, `the drag drew an area over the link: ${describeRing(ring)}`).toBe(4);
  await shot(page, testInfo, 'alt-drag-on-a-link');
});

// ---------------------------------------------------------------------------------------------------------------
// A scan

test('on scan-120.pdf an Alt+drag area takes a note, which is saved with the PDF and is back after a reload', async ({ openViewer, server }, testInfo) => {
  test.setTimeout(240_000);
  const page = await openViewer(server.url(`/f/${SCAN.file}`));
  await page.setViewportSize(WIDE);
  await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 40_000 });
  await hooks(page).eval((h) => h.viewer.setScale(1));
  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), 2); // the third page: the earlier walkthrough uses the first
  await settle(page, 1500);
  const tokens = await outlineTokens(page);
  const p = await pageRect(page, 2);
  const from = { x: p.left + 120, y: p.top + 220 };
  const to = { x: p.left + 380, y: p.top + 340 };
  const dragBox: Box = { left: from.x, top: from.y, right: to.x, bottom: to.y };
  await altDrag(page, from, to);
  await page.waitForTimeout(400);
  const drawn = await snapFrame(page, grow(dragBox, 20));
  const ring = findRing(drawn, near(drawn, tokens.area, 40), dragBox, { band: 8, prefer: tokens.area });
  expect(ring.found, `an area is drawn on a page with no text: ${describeRing(ring)}`).toBe(4);
  await shot(page, testInfo, 'scan-area-drawn');
  const dragNorm = await normOfBox(page, 2, dragBox);

  // Comment on it. The question about saving a scan is answered Yes, so the area and its note are kept.
  await page.mouse.move(AWAY.x, AWAY.y);
  const area = centreOf(dragBox);
  await page.mouse.move(area.x, area.y);
  await startNoteAnswering(page, 'Yes');
  await page.keyboard.type('Table of results, handwritten', { delay: 8 });
  await page.keyboard.press('Enter');
  const card = cardWith(page, 'Table of results, handwritten');
  await expect(card, 'a note on an area of a scan becomes a card').toBeVisible({ timeout: 5000 });
  await expect(card, 'on page 3').toContainText(/p(?:age|\.)\s*3(?!\d)/i);

  if (SAVING_AVAILABLE) {
    await waitSaved(page, 90_000);
    await waitStored(page, (a) => a.threads.some((t) => t.anchor.kind === 'area'), 'the note is stored on an area (not as a point or a page note)');
    const notes = await storedNotes(page);
    const thread = notes.threads.find((t) => t.anchor.kind === 'area')!;
    expect(thread.anchor.page, 'on the third page').toBe(2);
    thread.anchor.rect!.forEach((n, i) => expect(Math.abs(n - dragNorm[i]), `the area is the dragged rectangle, coordinate ${i}`).toBeLessThan(0.03));
    expect(notes.marks.filter((m) => m.style === 'area').length, 'the drawn rectangle is an area mark').toBeGreaterThanOrEqual(1);

    await page.reload();
    await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 60_000 });
    await hooks(page).eval((h) => h.viewer.setScale(1));
    await hooks(page).eval((h, i) => h.viewer.scrollTo(i), 2);
    await expect(cardWith(page, 'Table of results, handwritten'), 'the area note is back after a reload').toBeVisible({ timeout: 20_000 });
    await settle(page, 1500);
    await page.mouse.move(AWAY.x, AWAY.y);
    const back = await boxOfNorm(page, 2, thread.anchor.rect!);
    const g = await snapFrame(page, grow(back, 20));
    const again = findRing(g, near(g, tokens.area, 40), back, { band: 8, prefer: tokens.area });
    expect(again.found, `and so is the area's outline: ${describeRing(again)}`).toBe(4);
    await shot(page, testInfo, 'scan-area-after-reload');
  } else {
    note(testInfo, 'reload', NO_SAVING);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The rail's Figures tab

test('the rail has a Figures tab that lists the figures with their labels; choosing one jumps to it and selects it', async ({ openViewer, server }, testInfo) => {
  const fig = FIG_COLUMN;
  const page = await openFigurePaper(openViewer, server, fig);
  const v = await viewOf(page, fig);
  await warmUp(v); // detection has run
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.setViewportSize({ width: 1500, height: 1160 });
  await hooks(page).eval((h) => h.viewer.scrollTo(0)); // away from the figure's page, so that a jump is seen
  await settle(page, 600);
  await openRail(page);
  const named = /^figures$/i;
  const tab = page.getByRole('button', { name: named }).or(page.getByRole('tab', { name: named })).or(page.getByRole('radio', { name: named })).or(page.getByRole('menuitemradio', { name: named })).or(page.getByRole('switch', { name: named })).or(page.getByRole('checkbox', { name: named }));
  await expect(tab.first(), 'the rail has a "Figures" tab beside Thumbnails and Outline').toBeVisible({ timeout: 5000 });
  await tab.first().click();
  const item = page
    .getByRole('button', { name: /\bfigure 2\b/i })
    .or(page.getByRole('option', { name: /\bfigure 2\b/i }))
    .or(page.getByRole('listitem').filter({ hasText: /\bfigure 2\b/i }))
    .or(page.getByRole('treeitem', { name: /\bfigure 2\b/i }))
    .or(page.getByRole('link', { name: /\bfigure 2\b/i }));
  await expect(item.first(), 'the tab lists "Figure 2" with its page').toBeVisible({ timeout: 8000 });
  // Triage note: the row shows "Figure 2" and "Page 5" on two lines, so its textContent is "Figure 2Page 5" (no word break); read the text as shown.
  await expect.poll(() => item.first().evaluate((el) => (el as HTMLElement).innerText), { message: 'the row says which page' }).toMatch(/\b(?:p\.?|page)\s*5\b/i);
  await shot(page, testInfo, 'figures-tab');
  await item.first().focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => rt(page).currentPage(), { message: 'Enter jumps to the figure\'s page', timeout: 6000 }).toBe(fig.pageIndex);
  await settle(page, 800);
  const box = await figureBox(page, fig);
  const frame = await snapFrame(page, grow(box, 40));
  const tokens = await outlineTokens(page);
  const ring = findRing(frame, near(frame, tokens.selected, 45), box, { band: Math.max(20, 0.15 * Math.min(box.right - box.left, box.bottom - box.top)), prefer: tokens.selected });
  expect(ring.found, `and selects it (a solid outline in the primary blue): ${describeRing(ring)}`).toBe(4);
  await shot(page, testInfo, 'figure-jumped-to');
});


// ---------------------------------------------------------------------------------------------------------------
// One menu (ruling R80; added at integration, not by the spec-blind author): right-click on an area mark opens the mark
// menu (R72) with Comment and "Remove area"; right-click on a figure where there is no area mark opens the figure menu.

test('R80: right-click on an area mark inside a figure opens one menu, the mark menu (Comment, "Remove area"); right-click on the figure beside it opens the figure menu', async ({ openViewer, server }, testInfo) => {
  const fig = FIG_PICTURE;
  const page = await openFigurePaper(openViewer, server, fig);
  const v = await viewOf(page, fig);
  await warmUp(v);
  await page.mouse.move(AWAY.x, AWAY.y);

  // An area mark over the top half of the figure.
  await clearSelection(page);
  await altDrag(page, within(v.box, 0.08, 0.08), within(v.box, 0.6, 0.45));
  await answerSavePrompt(page, 'Yes', 500);
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.keyboard.press('Escape');
  await settle(page, 500);

  // On the area mark: exactly one menu, the mark menu.
  const read = await watchContextMenu(page);
  await rightClickAt(page, within(v.box, 0.3, 0.25));
  await expect(markMenu(page), 'one menu opens on the area mark').toHaveCount(1, { timeout: 3000 });
  expect((await read()).prevented, 'in place of Chrome\'s menu').toBe(true);
  await expect(menuRow(page, /^remove area\b/i), 'its Remove reads "Remove area"').toBeVisible();
  await expect(menuRow(page, /^comment\b/i), 'it offers Comment').toBeVisible();
  await expect(menuRow(page, /^copy image\b/i), 'it is not the figure menu as well').toHaveCount(0);
  note(testInfo, 'area mark menu', (await markMenu(page).getByRole('menuitem').allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').trim()).join(' | '));
  await shot(page, testInfo, 'r80-area-mark-menu');

  // Its Comment makes a note on the area, which is a part of the figure.
  await menuRow(page, /^comment\b/i).click();
  await startNoteAfterMenu(page);
  await page.keyboard.type('A note on the area', { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, 'A note on the area'), 'the mark menu\'s Comment makes a note on the area').toBeVisible({ timeout: 5000 });
  await expect(cardWith(page, 'A note on the area')).toContainText(/part of figure 1\s*·\s*page 1(?!\d)/i);
  await page.keyboard.press('Escape');
  await page.mouse.click(AWAY.x, AWAY.y);
  await settle(page, 600);

  // On the figure where there is no area mark: exactly one menu, the figure menu.
  const box = await figureBox(page, fig); // the first note may have moved the page over (R79)
  await rightClickAt(page, within(box, 0.5, 0.8));
  await expect(markMenu(page), 'one menu opens on the figure').toHaveCount(1, { timeout: 3000 });
  await expect(menuRow(page, /^copy image\b/i), 'the figure menu: Copy image').toBeVisible();
  await expect(menuRow(page, /^comment\b/i), 'and Comment').toBeVisible();
  await expect(menuRow(page, /^remove\b/i), 'and no Remove: there is no mark here').toHaveCount(0);
  await shot(page, testInfo, 'r80-figure-menu-beside-area');
  await page.keyboard.press('Escape');
  await settle(page, 300);

  // "Remove area" takes the area mark off.
  await rightClickAt(page, within(box, 0.3, 0.25));
  await expect(menuRow(page, /^remove area\b/i)).toBeVisible({ timeout: 3000 });
  await menuRow(page, /^remove area\b/i).click();
  if (SAVING_AVAILABLE) await waitStored(page, (a) => !a.marks.some((m) => m.style === 'area' && m.deletedAt === null), 'Remove area takes the area mark off');
});
