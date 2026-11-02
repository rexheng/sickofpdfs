// Walkthrough 18, rotate, two-page view and presentation mode (Task 26). Gate 1.
//
// Spec, Reading basics: "Rotate and views | Rotate 90°, two-page view, presentation mode for slides" (dark pages were dropped); the shortcut table:
// "Rotate | Ctrl+] / Ctrl+[ | Reading"; "Shortcut sheet | ?"; Marks ("marks live in our database and draw as an SVG overlay"), "Cards line up with
// their marks down the margin, like Google Docs", and Print ("Ctrl+P renders pages through PDFium into a print-only copy, with or without your marks").
// Interface file (Task 26), rulings:
//  - R81: rotation is a view setting for one tab. The file never changes; it is not saved, and the PDF reopens upright. Ctrl+] turns clockwise and
//    Ctrl+[ counter-clockwise, in 90 degree steps, all pages together. The page keeps its place: the passage at the centre of the screen is still in
//    view after the turn. Marks, notes, figures and pins turn with the page. Selecting and copying work exactly as when upright. A mark made while the
//    page is turned lands on the same chars as when upright. Margin cards line up with the on-screen top of their anchor. Print always prints upright.
//  - Two-page view (View menu, a toggle with a check mark): pairs 1-2, 3-4, ..., 16 px apart, centred. Fit width fits the pair. The page box shows the
//    left page of the pair in view. The margin cards sit to the right of the pair; with no room they fold into the notes panel (R60). Going to a page
//    scrolls to its pair. Not saved.
//  - Presentation mode (View menu): fullscreen, on black, one page fit to the screen; no header, toolbar, rail or margin cards; marks show, notes don't.
//    Arrow right/down, Space, PageDown go forward; arrow left/up, Shift+Space, PageUp go back; Home first page, End last page. A click on the right half
//    goes forward and on the left half back. The cursor hides after 2 s still. Esc, or leaving fullscreen any way, keeps the page reached and
//    restores the zoom (R99; on the same page the exact scroll).
//  - Wording: "Rotate clockwise", "Rotate counter-clockwise", "Two-page view", "Presentation mode"; the shortcut sheet lists all of them.
//  - Speed: a turn of a long PDF finishes in under 300 ms (spec's own budget with SOP_PERF_STRICT=1, looser otherwise).
//
// GUESSES (the rulings leave these open; each is also in the report):
//  G1  "the passage at the centre of the screen is still in view" is judged from the viewer's own geometry hooks (pdfPointAt before, clientPointOf after):
//      the point must be inside the visible area after every turn. Whether it stays at the centre is only a soft check (within a quarter of the window).
//  G2  A comment's passage is judged by the neutral wash its card gives it when the card is clicked (spec, Comments item 5); a highlight by its fill colour.
//  G3  "Level with the on-screen top of its anchor" means the card keeps the same offset from the top of its words as it had upright (within 12 px), and
//      stays within 60 px of it (the bound walkthrough comments uses for "level").
//  G4  After Go to page 12 in two-page view the page box shows 11 (the left page of the pair in view), not the 12 that was typed.
//  G5  The pair/margin test uses explicit 100% zoom (a window of 2300 px has room for the pair and the margin; 1280 px has not).
//  G6  Presentation: the page's element box is the page. "Fit to the screen" = the box touches both side edges or both top and bottom edges of the window
//      (within 2 px), is never larger than the window, and is centred. Neighbouring pages are outside the window.
//  G7  Presentation "click halves" are the halves of the SCREEN (x < half goes back), tried on the page and on the black beside it.
//  G8  The cursor is hidden when the computed `cursor` of whatever is under the pointer is "none".
//  G9  "Print stays upright" is read from the print copy the viewer builds (sheets, @page sizes), from the PDF the browser would print, from the
//      pictures it is asked of the engine at 200 dpi (viewRotation 0 only), and from the printed sheet's pixels.
//  G10 A turn is "finished" at the first frame after the key where the snapshot has the new viewRotation and the page in view is on screen turned that way
//      with ink on its canvas.
import { MIXED_PAGES, FIXTURES, REAL, ensureBook, ensureMixed, served } from './support/fixtures.spec-blind';
import { hidePill, railToggle, useRecordingPrint } from './support/nav.spec-blind';
import { inkBox } from './support/pixels.spec-blind';
import { budgetMs, budgetNote } from '../support/perf-budget';
import { changed, near, shareOf } from '../support/rings.spec-blind';
import { collapse } from '../support/tl-copy.spec-blind';
import { copySelection, inclusive, openClipboardReader, readSelection, waitForTextLayer } from '../support/tl-blind.spec-blind';
import {
  ATTENTION,
  LINES,
  SAVING_AVAILABLE,
  SENTENCE_3,
  allCards,
  answerSavePrompt,
  annotations,
  boxOf,
  cardWith,
  clearSelection,
  isPlain,
  isWashed,
  lineBoxes,
  markTokens,
  openPaper,
  overlapArea,
  pageRect,
  paintOfSelection,
  selectPassage,
  settle,
  startNoteAnswering,
  waitStored,
  type Passage,
  type Selected,
  type TlFixture,
} from './support/marks.spec-blind';
import { stableFrame } from './support/figures.spec-blind';
import {
  PAIR_WINDOW,
  ROWS,
  TURN_WINDOW,
  changedOutside,
  charsOf,
  chooseView,
  cursorAt,
  expectShown,
  installTurnTimer,
  isFullscreen,
  notBlackOutside,
  numbersShown,
  openPrintout,
  openViewMenu,
  pagesShown,
  passageAtCentre,
  printNow,
  printedPdf,
  rowIn,
  settleView,
  sheetOf,
  sheetSizes,
  startPresentation,
  timedTurn,
  turn,
  twoPageTicked,
  view,
  visibleArea,
  waitGlyph,
  waitNotFullscreen,
} from './support/views.spec-blind';
import { expect, hooks, note, rt, settled, shoot, snap, test, viewportCentre, waitForFirstPage, waitReady } from './support/viewer.spec-blind';
import type { Page, TestInfo } from '@playwright/test';

test.setTimeout(240_000);

test.beforeAll(async () => {
  await ensureBook();
  await ensureMixed();
});

const BOOK = served(FIXTURES.book);
const MIXED = served(FIXTURES.mixed);
const YELLOW = 0;
/** A page 2 passage of the Attention paper (one line, in the introduction). */
const ATTENTION_P2: TlFixture = { ...ATTENTION, name: 'attention-p2', page: 1 };
const P2_LINE: Passage = { from: 'Recurrent models typically factor', to: 'symbol positions of the input' };

/** Clicks the far-left gutter, where no page is: lets go of an active card and any selection. */
async function clickAway(page: Page): Promise<void> {
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
  await settle(page, 300);
}

/** Select a passage, Ctrl+Alt+M, type, Enter; answers "Save this PDF?" if it is asked. Leaves a posted card. */
async function postNoteSafe(page: Page, fx: TlFixture, p: Passage, text: string): Promise<Selected> {
  const sel = await selectPassage(page, fx, p);
  await startNoteAnswering(page, 'Yes');
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, text), `the note "${text}" becomes a card`).toBeVisible({ timeout: 5_000 });
  return sel;
}

/** Highlight (H) a passage; answers "Save this PDF?" if it is asked; lets go of the selection. */
async function highlight(page: Page, fx: TlFixture, p: Passage): Promise<Selected> {
  const sel = await selectPassage(page, fx, p);
  await page.keyboard.press('h');
  await answerSavePrompt(page, 'Yes', 800);
  await clearSelection(page);
  await settle(page, 300);
  return sel;
}

/** The one page number readable on the screen once it has settled (null if none or several are). Gives up waiting for `want` after 4 s. */
async function pageAfter(page: Page, want: number): Promise<number | null> {
  const until = Date.now() + 4_000;
  for (;;) {
    const now = await numbersShown(page);
    if (now.length === 1 && (now[0] === want || Date.now() > until)) return now[0];
    if (Date.now() > until) return null;
    await page.waitForTimeout(120);
  }
}

const onScreen = async (l: ReturnType<Page['locator']>, page: Page): Promise<boolean> => {
  if (!(await l.first().isVisible().catch(() => false))) return false;
  const b = await l.first().boundingBox();
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  return b !== null && b.x < size.width && b.x + b.width > 0 && b.y < size.height && b.y + b.height > 0;
};

// =================================================================================================================
// Rotate
// =================================================================================================================

test('View has the four rows by their names and no Dark pages; the shortcut sheet lists them with their keys', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(MIXED));
  await waitForFirstPage(page);
  const menu = await openViewMenu(page);
  await snap(page, testInfo, '18-view-menu');
  await expect(rowIn(menu, ROWS.cw), 'View has "Rotate clockwise"').toBeVisible();
  await expect(rowIn(menu, ROWS.ccw), 'View has "Rotate counter-clockwise"').toBeVisible();
  await expect(rowIn(menu, ROWS.two), 'View has "Two-page view"').toBeVisible();
  await expect(rowIn(menu, ROWS.present), 'View has "Presentation mode"').toBeVisible();
  await expect(rowIn(menu, ROWS.two), 'Two-page view is a toggle with a check mark: it says whether it is on').toHaveAttribute('aria-checked', /^(?:true|false)$/);
  await expect(rowIn(menu, /dark/i), 'Dark pages was dropped: no row for it').toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: /shortcuts/i });
  await expect(sheet, '"?" opens the shortcut sheet').toBeVisible({ timeout: 5_000 });
  const text = await sheet.innerText();
  await snap(page, testInfo, '18-shortcut-sheet');
  expect.soft(text, 'the sheet lists "Rotate clockwise"').toMatch(ROWS.cw);
  expect.soft(text, 'and "Rotate counter-clockwise"').toMatch(ROWS.ccw);
  expect.soft(text, 'and "Two-page view"').toMatch(ROWS.two);
  expect.soft(text, 'and "Presentation mode"').toMatch(ROWS.present);
  expect.soft(text, 'with Ctrl+] for clockwise').toMatch(/Ctrl\s*\+\s*\]/);
  expect.soft(text, 'and Ctrl+[ for counter-clockwise').toMatch(/Ctrl\s*\+\s*\[/);
  expect.soft(text, 'no Dark pages in the sheet either').not.toMatch(/dark pages/i);
  expect.soft(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dark-pages-filter').trim()), 'and no --dark-pages-filter design token').toBe('');
});

type Corner = 'TL' | 'TR' | 'BL' | 'BR';
/** Where "Page 1" (48 pt at the top-left of the upright page) is after the page is turned, and which corner is across from it. */
const LABEL_AT: Record<number, { label: Corner; opposite: Corner; horizontal: boolean }> = {
  0: { label: 'TL', opposite: 'BR', horizontal: true },
  90: { label: 'TR', opposite: 'BL', horizontal: false },
  180: { label: 'BR', opposite: 'TL', horizontal: true },
  270: { label: 'BL', opposite: 'TR', horizontal: false },
};
const cornerOf = (r: { x: number; y: number; width: number; height: number }, c: Corner, f = 0.35) => ({
  x: c[1] === 'L' ? r.x : r.x + r.width * (1 - f),
  y: c[0] === 'T' ? r.y : r.y + r.height * (1 - f),
  width: r.width * f,
  height: r.height * f,
});

test('Ctrl+] turns every page clockwise and Ctrl+[ counter-clockwise, in 90 degree steps; the file itself does not change', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(MIXED));
  await waitForFirstPage(page);
  await rt(page).setScale(0.5); // each whole page fits in the window
  await settled(() => rt(page).scale());
  const doc0 = await rt(page).doc();
  const boxes0 = await rt(page).pageBoxes();
  expect((await view(page)).viewRotation, 'the viewer starts upright').toBe(0);

  const steps = [
    { dir: 'cw', want: 90 },
    { dir: 'cw', want: 180 },
    { dir: 'cw', want: 270 },
    { dir: 'cw', want: 0 },
    { dir: 'ccw', want: 270 },
    { dir: 'ccw', want: 180 },
    { dir: 'ccw', want: 90 },
    { dir: 'ccw', want: 0 },
  ] as const;
  for (const step of steps) {
    expect(await turn(page, step.dir), `${step.dir === 'cw' ? 'Ctrl+]' : 'Ctrl+['} gives ${step.want} degrees`).toBe(step.want);
    const sideways = step.want % 180 === 90;
    const boxes = await rt(page).pageBoxes();
    expect(boxes).toHaveLength(MIXED_PAGES.length);
    boxes.forEach((b, i) => {
      // at the same zoom a page turned on its side is as wide as it was tall
      expect(b.width, `at ${step.want} degrees page ${i + 1} is ${sideways ? 'as wide as it was tall' : 'as wide as it was'}`).toBeCloseTo(sideways ? boxes0[i].height : boxes0[i].width, 0);
      expect(b.height, `and ${sideways ? 'as tall as it was wide' : 'as tall as it was'} (all pages turn together)`).toBeCloseTo(sideways ? boxes0[i].width : boxes0[i].height, 0);
    });
    // the pages are still stacked in order, none on top of another
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].top, `page ${i + 1} starts below page ${i}`).toBeGreaterThanOrEqual(boxes[i - 1].top + boxes[i - 1].height - 0.5);

    // Page 1's label "Page 1" is at the corner a clockwise turn takes the top-left to
    await rt(page).scrollToPage(0);
    const where = LABEL_AT[step.want];
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    let shot = await shoot(page);
    await expect
      .poll(
        async () => {
          shot = await shoot(page);
          const c = shot.canvases.find((k) => k.page === 0);
          if (!c) return false;
          rect = { x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight };
          return inkBox(shot.img, shot.ratio, cornerOf(rect, where.label), 128) !== null;
        },
        { message: `at ${step.want} degrees the label of page 1 shows at the ${where.label} corner`, timeout: 8_000 },
      )
      .toBe(true);
    const ink = inkBox(shot.img, shot.ratio, cornerOf(rect, where.label), 128)!;
    if (where.horizontal) expect(ink.aspect, `the label lies along the line at ${step.want} degrees (aspect ${ink.aspect.toFixed(2)})`).toBeGreaterThan(2);
    else expect(ink.aspect, `the label stands on end at ${step.want} degrees (aspect ${ink.aspect.toFixed(2)})`).toBeLessThan(0.5);
    expect(inkBox(shot.img, shot.ratio, cornerOf(rect, where.opposite, 0.25), 128), `nothing in the corner across from it (${where.opposite})`).toBeNull();
    if (step.dir === 'cw' && step.want !== 0) await snap(page, testInfo, `18-turned-${step.want}`);
  }

  // The file is the file: the engine still reports the pages as the file has them.
  const doc1 = await rt(page).doc();
  expect(doc1!.pages, 'the pages are as the file has them (the /Rotate 90 page still says 90)').toEqual(doc0!.pages);
  expect(doc1!.sha256, 'the same bytes').toBe(doc0!.sha256);

  // The menu does the same as the keys.
  await chooseView(page, ROWS.cw);
  await expect.poll(async () => (await view(page)).viewRotation, { message: 'View → Rotate clockwise turns the pages' }).toBe(90);
  await chooseView(page, ROWS.ccw);
  await expect.poll(async () => (await view(page)).viewRotation, { message: 'View → Rotate counter-clockwise turns them back' }).toBe(0);
});

test('the page keeps its place: after every turn the passage that was at the centre of the screen is still in view', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  await rt(page).scrollToPage(199);
  await page.evaluate(() => {
    document.querySelector('[role="document"]')!.scrollTop += 380;
  });
  await settleView(page);
  const at = await passageAtCentre(page);
  expect(Math.abs(at.pageIndex - 199), 'precondition: the centre of the screen is on page 200 or a neighbour').toBeLessThanOrEqual(1);
  await snap(page, testInfo, '18-place-before');

  for (const dir of ['cw', 'cw', 'cw', 'cw', 'ccw', 'ccw', 'ccw', 'ccw'] as const) {
    const now = await turn(page, dir);
    const p = await rt(page).clientPointOf(at);
    const area = await visibleArea(page);
    expect(
      p.x >= area.x && p.x <= area.x + area.width && p.y >= area.y && p.y <= area.y + area.height,
      `at ${now} degrees (${dir}) the passage from the centre of the screen is still in view: it is at (${p.x.toFixed(0)}, ${p.y.toFixed(0)}) in a view from (${area.x.toFixed(0)}, ${area.y.toFixed(0)}) of ${area.width.toFixed(0)} x ${area.height.toFixed(0)}`,
    ).toBe(true);
    expect.soft(Math.abs(p.y - (area.y + area.height / 2)), `and near the middle of the screen, top to bottom (${dir}, ${now} degrees)`).toBeLessThanOrEqual(area.height * 0.25);
    expect.soft(Math.abs(p.x - (area.x + area.width / 2)), `and near the middle, side to side (${dir}, ${now} degrees)`).toBeLessThanOrEqual(area.width * 0.25);
    const centreNow = await rt(page).pdfPointAt((await viewportCentre(page)).x, (await viewportCentre(page)).y);
    expect.soft(Math.abs((centreNow?.pageIndex ?? -99) - 199), `the reader is still on page 200 or next to it at ${now} degrees`).toBeLessThanOrEqual(1);
    if (dir === 'cw' && now === 90) await snap(page, testInfo, '18-place-after-first-turn');
  }
});

test('selecting and copying while turned gives the same chars and the same text as when upright', async ({ context, openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  const reader = await openClipboardReader(context, server);
  const upright = await selectPassage(page, ATTENTION, SENTENCE_3);
  const base = await readSelection(page);
  expect(base.ranges, 'upright: the drag selected from the first char to the last, both included').toEqual([inclusive(ATTENTION.page, upright.a, upright.b)]);
  const baseCopy = await copySelection(page, reader);
  expect(baseCopy.length, 'upright: something was copied').toBeGreaterThan(100);
  expect(collapse(baseCopy), 'upright: the copy is the sentence').toBe(collapse(upright.text));
  await clearSelection(page);

  for (const dir of ['cw', 'cw', 'cw', 'cw'] as const) {
    const now = await turn(page, dir);
    await waitGlyph(page, ATTENTION.page, upright.a);
    await waitGlyph(page, ATTENTION.page, upright.b);
    await clearSelection(page);
    const sel = await selectPassage(page, ATTENTION, SENTENCE_3);
    const picked = await readSelection(page);
    await snap(page, testInfo, `18-selected-at-${now}`);
    expect(picked.ranges, `at ${now} degrees the same chars are selected as upright`).toEqual(base.ranges);
    expect(collapse(picked.domText), `at ${now} degrees the browser's own selection holds the same words`).toBe(collapse(base.domText));
    const copied = await copySelection(page, reader);
    expect(copied, `at ${now} degrees Ctrl+C copies exactly what it copied upright`).toBe(baseCopy);
    expect(sel.text, 'the drag ran over the same engine text').toBe(upright.text);
    await clearSelection(page);
  }
});

// -----------------------------------------------------------------------------------------------------------------
// Marks and notes turn with the page

interface Made {
  hl: Selected;
  note: Selected;
  control: Selected;
  /** Words made bold, and how dark their lines are plain and bold when upright. */
  bold?: { sel: Selected; plain: number; bolded: number };
}
const NOTE_TEXT = 'Turns with the page';

/**
 * Judges the marks as the owner sees them on the lines of the passages: the highlight is on its own words in its colour (and not on the line
 * between), and the note's words show the neutral wash its clicked card gives them (and the line between does not).
 */
async function judgeMarks(page: Page, m: Made, where: string, testInfo: TestInfo): Promise<void> {
  const tokens = await markTokens(page);
  await clickAway(page);
  const h = await paintOfSelection(page, m.hl, { name: `18-${where}-highlight`, testInfo });
  expect.soft(h.paint.share(tokens.fill[YELLOW]), `${where}: the highlight is on its own words, in its colour`).toBeGreaterThanOrEqual(0.6);
  const control = await paintOfSelection(page, m.control);
  expect.soft(isPlain(control.paint), `${where}: the line that was never marked is plain paper`).toBe(true);
  if (m.bold) {
    const b = await paintOfSelection(page, m.bold.sel, { name: `18-${where}-bold`, testInfo });
    const { plain, bolded } = m.bold;
    expect.soft(b.paint.darkness, `${where}: the bold words are as heavy as they were upright (plain ${plain.toFixed(0)}, bold ${bolded.toFixed(0)}, now ${b.paint.darkness.toFixed(0)})`).toBeGreaterThanOrEqual(plain + 0.5 * (bolded - plain));
  }
  const card = cardWith(page, NOTE_TEXT);
  await card.click();
  await expect(card, `${where}: clicking the card makes it the active one`).toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(500);
  const n = await paintOfSelection(page, m.note, { name: `18-${where}-note`, testInfo });
  expect.soft(isWashed(n.paint, tokens), `${where}: the active note's own words get the neutral wash`).toBe(true);
  const control2 = await paintOfSelection(page, m.control);
  expect.soft(isPlain(control2.paint), `${where}: and the line that was never marked still does not`).toBe(true);
  await clickAway(page);
}

test('a highlight, bold and a comment made upright still sit on the same words when the page is turned, all the way round', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  const hl = await highlight(page, ATTENTION, LINES.l3);
  const noted = await postNoteSafe(page, ATTENTION, LINES.l7, NOTE_TEXT);
  const control = await charsOf(page, ATTENTION, LINES.l11);
  // bold: heavier ink on its own words (judged by how much black the words hold, as walkthrough 17 does)
  const boldSel = await charsOf(page, ATTENTION, LINES.l9);
  const plain = (await paintOfSelection(page, boldSel)).paint.darkness;
  await selectPassage(page, ATTENTION, LINES.l9);
  await page.keyboard.press('Control+b');
  await clearSelection(page);
  await settle(page, 400);
  const bolded = (await paintOfSelection(page, boldSel)).paint.darkness;
  expect(bolded, `upright: bold makes its words heavier (${plain.toFixed(0)} -> ${bolded.toFixed(0)})`).toBeGreaterThanOrEqual(plain * 1.03);
  const made: Made = { hl, note: noted, control, bold: { sel: boldSel, plain, bolded } };
  await judgeMarks(page, made, 'upright', testInfo);

  for (const dir of ['cw', 'cw', 'cw', 'cw'] as const) {
    const now = await turn(page, dir);
    await waitGlyph(page, ATTENTION.page, hl.a);
    await waitGlyph(page, ATTENTION.page, noted.a);
    await judgeMarks(page, made, `turned-${now}`, testInfo);
    await snap(page, testInfo, `18-marks-at-${now}`);
  }
});

test('a highlight and a comment made while the page is turned land on the same words, and stay there when it is turned back', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  expect(await turn(page, 'ccw'), 'turn the page counter-clockwise first').toBe(270);
  const target = await charsOf(page, ATTENTION, LINES.l3);
  const noteChars = await charsOf(page, ATTENTION, LINES.l7);
  await waitGlyph(page, ATTENTION.page, target.a);
  await waitGlyph(page, ATTENTION.page, target.b);
  const hl = await highlight(page, ATTENTION, LINES.l3);
  expect(hl.a, 'the drag in the turned page started on the first char of the words').toBe(target.a);
  expect(hl.b, 'and ended on the last').toBe(target.b);
  await waitGlyph(page, ATTENTION.page, noteChars.a);
  const noted = await postNoteSafe(page, ATTENTION, LINES.l7, NOTE_TEXT);
  expect(noted.a).toBe(noteChars.a);
  expect(noted.b).toBe(noteChars.b);
  const control = await charsOf(page, ATTENTION, LINES.l11);
  const made: Made = { hl, note: noted, control };

  if (SAVING_AVAILABLE) {
    // What was stored is the words that were dragged over, whichever way the page was turned.
    const stored = await waitStored(page, (a) => a.marks.some((m) => m.style === 'highlight' && m.deletedAt === null) && a.threads.some((t) => t.draftOfTab === null && t.deletedAt === null), 'the highlight and the note are stored');
    const mark = stored.marks.find((m) => m.style === 'highlight' && m.deletedAt === null)!;
    expect(collapse(mark.anchor.quote?.quote ?? ''), 'the stored highlight holds exactly the selected words').toBe(collapse(hl.text));
    const thread = stored.threads.find((t) => t.draftOfTab === null && t.deletedAt === null)!;
    expect(collapse(thread.anchor.quote?.quote ?? ''), 'the stored note is on exactly the selected words').toBe(collapse(noted.text));
    expect(thread.pageIndex ?? 0, 'on page 1').toBe(0);
    expect((await annotations(page)).marks.filter((m) => m.deletedAt === null).length, 'one highlight').toBe(1);
  }

  await judgeMarks(page, made, 'made-at-270', testInfo);
  for (const dir of ['cw', 'cw', 'cw'] as const) {
    const now = await turn(page, dir);
    await waitGlyph(page, ATTENTION.page, hl.a);
    await waitGlyph(page, ATTENTION.page, noted.a);
    await judgeMarks(page, made, `then-${now}`, testInfo);
  }
  await snap(page, testInfo, '18-marks-made-turned-then-turned-round');
});

test('margin cards stay level with the on-screen top of their words, to the right of the page, whichever way the page is turned', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  const sel = await postNoteSafe(page, ATTENTION, LINES.l5, NOTE_TEXT);
  await clickAway(page);
  const card = cardWith(page, NOTE_TEXT);

  const measure = async () => {
    const lines = await lineBoxes(page, sel);
    const anchorTop = Math.min(...lines.map((b) => b.top));
    const c = await boxOf(card);
    const pr = await pageRect(page, 0);
    const overlap = Math.max(...lines.map((l) => overlapArea(c, l)));
    return { d: c.top - anchorTop, cardLeft: c.left, pageRight: pr.right, overlap, anchorTop, cardTop: c.top };
  };
  const base = await measure();
  expect(Math.abs(base.d), `upright: the card is level with its words (card top ${base.cardTop.toFixed(0)}, words top ${base.anchorTop.toFixed(0)})`).toBeLessThanOrEqual(60);
  expect(base.cardLeft, 'upright: the card is in the margin, right of the page').toBeGreaterThanOrEqual(base.pageRight - 4);
  await snap(page, testInfo, '18-card-upright');

  const tops: string[] = [`0: card ${base.cardTop.toFixed(0)}, words ${base.anchorTop.toFixed(0)}`];
  for (const dir of ['cw', 'cw', 'cw', 'cw'] as const) {
    const now = await turn(page, dir);
    await waitGlyph(page, ATTENTION.page, sel.a);
    // The margin lays itself out again after the turn; give it a moment.
    await expect
      .poll(async () => Math.abs((await measure()).d - base.d), { message: `at ${now} degrees the card keeps the offset it had upright (${base.d.toFixed(0)} px) from the top of its words on the screen`, timeout: 4_000 })
      .toBeLessThanOrEqual(12);
    const m = await measure();
    tops.push(`${now}: card ${m.cardTop.toFixed(0)}, words ${m.anchorTop.toFixed(0)}`);
    expect(Math.abs(m.d), `at ${now} degrees the card is level with the top of its words`).toBeLessThanOrEqual(60);
    expect(m.cardLeft, `at ${now} degrees the card is in the margin, right of the page`).toBeGreaterThanOrEqual(m.pageRight - 4);
    expect(m.overlap, `at ${now} degrees the card does not cover its words`).toBeLessThanOrEqual(1);
    await snap(page, testInfo, `18-card-at-${now}`);
  }
  note(testInfo, 'card top and words top (px) at each turn', tops.join('; '));
});

test('rotation and two-page view are for this tab only: a reload, or a new tab, opens the PDF upright and one page at a time', async ({ context, openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  expect(await turn(page, 'cw')).toBe(90);
  const turned = (await rt(page).pageBoxes())[0];
  expect(turned.width, 'the page is on its side').toBeGreaterThan(turned.height);
  await page.reload();
  await waitReady(page, 30_000);
  expect((await view(page)).viewRotation, 'after a reload the PDF opens upright').toBe(0);
  const afterReload = (await rt(page).pageBoxes())[0];
  expect(afterReload.height, 'and its pages are upright').toBeGreaterThan(afterReload.width);
  await snap(page, testInfo, '18-reload-upright');

  // two-page view is not saved either
  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage, { message: 'two-page view is on' }).toBe(true);
  await page.reload();
  await waitReady(page, 30_000);
  expect((await view(page)).twoPage, 'after a reload it is one page at a time').toBe(false);
  expect(await twoPageTicked(page), 'and the View menu shows no check mark').toBe(false);
  const single = await rt(page).pageBoxes();
  expect(single[1].top - (single[0].top + single[0].height), 'page 2 is under page 1, 16 px below it').toBeGreaterThanOrEqual(15);
  expect(single[1].top - (single[0].top + single[0].height), 'page 2 is under page 1, 16 px below it').toBeLessThanOrEqual(17);
  await snap(page, testInfo, '18-reload-single-page');

  // a new tab on the same PDF opens upright too, though this tab is turned
  expect(await turn(page, 'ccw')).toBe(270);
  const fresh = await context.newPage();
  await fresh.goto(page.url());
  await waitReady(fresh, 30_000);
  expect((await view(fresh)).viewRotation, 'a new tab on the same PDF is upright').toBe(0);
  await fresh.close();
  // and so does one opened while this tab is in two-page view
  expect(await turn(page, 'cw')).toBe(0);
  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage).toBe(true);
  const fresh2 = await context.newPage();
  await fresh2.goto(page.url());
  await waitReady(fresh2, 30_000);
  expect((await view(fresh2)).twoPage, 'a new tab on the same PDF is one page at a time').toBe(false);
});

// -----------------------------------------------------------------------------------------------------------------
// Print

const PRINT_SCALE = 200 / 72;
const MIXED_SHEETS = MIXED_PAGES.map((p) => (p.rotate % 180 === 90 ? { w: p.height, h: p.width } : { w: p.width, h: p.height }));

test('print stays upright: a turned viewer prints the same sheets, at the same sizes, as an upright one, and asks the engine for upright pictures', async ({ context, openViewer, server }, testInfo) => {
  await useRecordingPrint(context);
  const page = await openViewer(server.url(MIXED));
  await waitForFirstPage(page);

  // The print copy of the upright viewer.
  const log1 = await printNow(page, null);
  const upright = log1.snapshots[0];
  expect(upright.sheets.length, 'one sheet for each of the 5 pages').toBe(MIXED_PAGES.length);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#sop-print-root'), 'the first print copy is disposed').toHaveCount(0, { timeout: 8_000 });

  // The viewer turned: look at what the engine is asked for while printing.
  expect(await turn(page, 'cw')).toBe(90);
  await settle(page, 1_200);
  await hooks(page).eval((h) => {
    const g = globalThis as unknown as { __renderLog?: { scale: number; viewRotation: number }[] };
    g.__renderLog = [];
    const b = h.backend as unknown as { renderTile: (doc: unknown, req: { scale: number; viewRotation: number }, signal?: AbortSignal) => Promise<unknown> };
    const original = b.renderTile.bind(b);
    b.renderTile = (doc, req, signal) => {
      g.__renderLog!.push({ scale: req.scale, viewRotation: req.viewRotation });
      return original(doc, req, signal);
    };
  });
  const log2 = await printNow(page, null);
  const turned = log2.snapshots[1];
  const shape = (s: typeof upright) => s.sheets.map((x) => ({ pictures: x.pictures, pageName: x.pageName, width: x.width, height: x.height, pixels: x.pixels }));
  expect(shape(turned), 'the turned viewer builds the same sheets (names, sizes, pixels) as the upright one').toEqual(shape(upright));
  expect(turned.pageRules, 'with the same @page rules').toEqual(upright.pageRules);
  const renders = await page.evaluate(() => (globalThis as unknown as { __renderLog?: { scale: number; viewRotation: number }[] }).__renderLog ?? []);
  const forPrint = renders.filter((r) => Math.abs(r.scale - PRINT_SCALE) < 0.02);
  note(testInfo, 'engine pictures at print resolution while printing a turned viewer', `${forPrint.length}, viewRotation ${[...new Set(forPrint.map((r) => r.viewRotation))].join(',') || 'n/a'}`);
  if (forPrint.length > 0) expect(forPrint.filter((r) => r.viewRotation !== 0), 'every picture the print copy asked the engine for was upright (viewRotation 0)').toEqual([]);

  // What the browser would print.
  const pdf = await printedPdf(page);
  const sizes = await sheetSizes(pdf);
  expect(sizes.length, 'the printout has 5 sheets').toBe(MIXED_SHEETS.length);
  sizes.forEach((s, i) => {
    expect(Math.abs(s.width - MIXED_SHEETS[i].w), `sheet ${i + 1} is ${MIXED_SHEETS[i].w} pt wide, as upright (it is ${s.width.toFixed(1)})`).toBeLessThanOrEqual(1.5);
    expect(Math.abs(s.height - MIXED_SHEETS[i].h), `sheet ${i + 1} is ${MIXED_SHEETS[i].h} pt tall, as upright (it is ${s.height.toFixed(1)})`).toBeLessThanOrEqual(1.5);
  });
  // And the first sheet reads upright: "Page 1" at the top-left.
  const out = await openPrintout(openViewer, server, pdf, 'turned-print', { width: 1280, height: 1160 });
  const sheet = await sheetOf(out, 0);
  const width = sheet.box.right - sheet.box.left;
  const height = sheet.box.bottom - sheet.box.top;
  const label = inkBox(sheet.frame.img, sheet.frame.dpr, { x: sheet.box.left, y: sheet.box.top, width, height: height * 0.3 }, 128);
  expect(label, 'the printed sheet has ink at the top').not.toBeNull();
  expect(label!.aspect, 'the label lies along the line (it is upright)').toBeGreaterThan(2);
  expect(label!.left, 'at the left').toBeLessThan(0.15);
  expect(label!.right, 'and does not reach the middle').toBeLessThan(0.5);
  await snap(out, testInfo, '18-printed-sheet-1');
});

test('printing with marks from a turned viewer gives the same sheet as printing from an upright one', async ({ context, openViewer, server }, testInfo) => {
  test.setTimeout(420_000);
  await useRecordingPrint(context);
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  const tokens = await markTokens(page);
  await highlight(page, ATTENTION, LINES.l3);
  await selectPassage(page, ATTENTION, LINES.l7);
  await page.keyboard.press('Control+u');
  await clearSelection(page);
  await settle(page, 600);

  await printNow(page, true);
  const uprightPdf = await printedPdf(page);
  expect(await turn(page, 'cw')).toBe(90);
  await settle(page, 1_200);
  await printNow(page, true);
  const turnedPdf = await printedPdf(page);
  expect((await sheetSizes(turnedPdf)).length, 'the same number of sheets').toBe((await sheetSizes(uprightPdf)).length);

  const sheetWindow = { width: 1280, height: 1160 };
  const outA = await openPrintout(openViewer, server, uprightPdf, 'upright-with-marks', sheetWindow);
  const outB = await openPrintout(openViewer, server, turnedPdf, 'turned-with-marks', sheetWindow);
  const a = await sheetOf(outA, 0);
  const b = await sheetOf(outB, 0);
  await snap(outA, testInfo, '18-printed-from-upright');
  await snap(outB, testInfo, '18-printed-from-turned');
  expect(Math.abs(a.box.right - a.box.left - (b.box.right - b.box.left)) + Math.abs(a.box.bottom - a.box.top - (b.box.bottom - b.box.top)), 'the sheets are the same size').toBeLessThanOrEqual(3);
  const yellow = shareOf(a.frame, near(a.frame, tokens.fill[YELLOW], 14), a.box);
  expect(yellow, 'the upright print holds the highlight (so the comparison is not of two plain pages)').toBeGreaterThan(0.002);
  const different = shareOf(a.frame, changed(a.frame, b.frame), a.box);
  expect(different, 'the sheet printed from the turned viewer is the sheet printed from the upright one (marks and all)').toBeLessThan(0.001);
});

// -----------------------------------------------------------------------------------------------------------------
// Speed

for (const doc of [
  { name: 'the 404-page textbook', url: REAL.book404.url },
  { name: 'the 120-page scan (the largest file)', url: '/f/scan-120.pdf' },
]) {
  test(`turning ${doc.name} finishes in under 300 ms`, async ({ openViewer, server }, testInfo) => {
    const page = await openViewer(server.url(doc.url));
    await waitForFirstPage(page, 45_000);
    const count = (await rt(page).doc())!.pageCount;
    await rt(page).scrollToPage(Math.floor(count / 2));
    await settleView(page, 1_000);
    await installTurnTimer(page);
    const times: number[] = [];
    for (const dir of ['cw', 'cw', 'ccw', 'ccw'] as const) {
      const t = await timedTurn(page, dir);
      times.push(t.ms);
      await settleView(page, 700);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = (sorted[1] + sorted[2]) / 2;
    note(testInfo, `turn times for ${doc.name}, ms (cw, cw, ccw, ccw)`, times.map((t) => t.toFixed(0)).join(', '));
    expect(median, `the median turn took ${median.toFixed(0)} ms; ${budgetNote(300)}`).toBeLessThan(budgetMs(300));
    expect(Math.max(...times), `no turn was slow: ${times.map((t) => t.toFixed(0)).join(', ')} ms; ${budgetNote(300)}`).toBeLessThan(budgetMs(300) * 2);
  });
}

// =================================================================================================================
// Two-page view
// =================================================================================================================

test('Two-page view (View menu, ticked): pages sit in pairs 1-2, 3-4, 16 px apart and centred, and Fit width fits the pair', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  expect((await view(page)).twoPage, 'one page at a time to start with').toBe(false);
  expect(await twoPageTicked(page), 'the View menu shows no check mark').toBe(false);
  await page.keyboard.press('Control+0'); // fit width
  await settled(() => rt(page).scale());
  const singleScale = await rt(page).scale();

  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage, { message: 'View → Two-page view turns it on' }).toBe(true);
  expect(await twoPageTicked(page), 'and the View menu shows the check mark').toBe(true);
  await page.keyboard.press('Control+0'); // fit width again: now it fits the pair
  await settleView(page, 700);
  const boxes = await rt(page).pageBoxes();
  const rowGap = boxes[2].top - (boxes[0].top + boxes[0].height);

  expect(boxes[1].left - (boxes[0].left + boxes[0].width), 'pages 1 and 2 are 16 px apart').toBeGreaterThanOrEqual(15);
  expect(boxes[1].left - (boxes[0].left + boxes[0].width), 'pages 1 and 2 are 16 px apart').toBeLessThanOrEqual(17);
  expect(Math.abs(boxes[1].top - boxes[0].top), 'pages 1 and 2 are side by side, top to top').toBeLessThanOrEqual(1);
  expect(Math.abs(boxes[3].top - boxes[2].top), 'pages 3 and 4 are side by side').toBeLessThanOrEqual(1);
  expect(boxes[3].left - (boxes[2].left + boxes[2].width), 'pages 3 and 4 are 16 px apart').toBeGreaterThanOrEqual(15);
  expect(boxes[3].left - (boxes[2].left + boxes[2].width), 'pages 3 and 4 are 16 px apart').toBeLessThanOrEqual(17);
  expect(rowGap, 'page 3 is in the next row, under page 1 (not beside page 2)').toBeGreaterThan(0);
  expect(Math.abs(boxes[2].left - boxes[0].left), 'page 3 is under page 1').toBeLessThanOrEqual(1);
  expect(Math.abs(boxes[3].left - boxes[1].left), 'and page 4 under page 2').toBeLessThanOrEqual(1);
  expect.soft(rowGap, 'the rows are 16 px apart too').toBeLessThanOrEqual(17.5);

  // Centred, and Fit width fits the pair: the two pages fill the width of the window less 16 px at each side and between.
  const area = await visibleArea(page);
  const r0 = await pageRect(page, 0);
  const r1 = await pageRect(page, 1);
  expect(Math.abs((r0.left + r1.right) / 2 - (area.x + area.width / 2)), 'the pair is centred in the window').toBeLessThanOrEqual(2);
  const span = r1.right - r0.left;
  expect(span, `the pair fits the window (${span.toFixed(0)} px in ${area.width.toFixed(0)})`).toBeLessThanOrEqual(area.width + 0.5);
  expect(span, 'and fills it, less the gaps').toBeGreaterThanOrEqual(area.width - 40);
  expect(await rt(page).scale(), 'fit width for a pair is a smaller zoom than for one page').toBeLessThan(singleScale);
  expect(await numbersShown(page), 'pages 1 and 2 are on the screen, one beside the other').toEqual(expect.arrayContaining([1, 2]));
  await snap(page, testInfo, '18-two-page');

  // Off again: one page at a time.
  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage, { message: 'View → Two-page view again turns it off' }).toBe(false);
  await settleView(page);
  const back = await rt(page).pageBoxes();
  expect(back[1].top, 'page 2 is under page 1 again').toBeGreaterThanOrEqual(back[0].top + back[0].height);
});

test('in two-page view the page box shows the left page of the pair in view, and Go to page lands on the pair', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage).toBe(true);
  await page.keyboard.press('Control+0');
  await settleView(page, 700);
  const pageBox = page.getByRole('textbox', { name: 'Page', exact: true });
  const boxes = await rt(page).pageBoxes();
  await expect(pageBox, 'at the top the page box says 1').toHaveValue('1');

  // Scroll by hand until the row of pages 7 and 8 is at the top: the box shows 7.
  await page.evaluate((top) => {
    document.querySelector('[role="document"]')!.scrollTop = top;
  }, boxes[6].top - 16);
  await settleView(page);
  await expect(pageBox, 'with the pair 7-8 in view the page box shows the left page, 7').toHaveValue('7');
  expect((await view(page)).currentPage, 'the viewer says page 7 (index 6)').toBe(6);
  await snap(page, testInfo, '18-two-page-scrolled-7-8');

  // Go to page 12, the right page of the pair 11-12: the pair is scrolled to the top (G4: the box shows the left page, 11).
  await page.keyboard.press('Control+g');
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => Math.abs((await rt(page).scrollTop()) - boxes[10].top), { message: 'Go to page 12 scrolls to the pair 11-12: its row is at the top of the window', timeout: 4_000 })
    .toBeLessThanOrEqual(16 + 4);
  await settleView(page);
  await expect.poll(() => numbersShown(page), { message: 'both pages of the pair, 11 and 12, are on the screen' }).toEqual(expect.arrayContaining([11, 12]));
  await expect(pageBox, 'and the page box shows the left page of the pair, 11').toHaveValue('11');
  await snap(page, testInfo, '18-two-page-go-to-12');

  // Go to page 3, a left page.
  await page.keyboard.press('Control+g');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await expect.poll(async () => Math.abs((await rt(page).scrollTop()) - boxes[2].top), { message: 'Go to page 3 scrolls to the pair 3-4', timeout: 4_000 }).toBeLessThanOrEqual(16 + 4);
  await expect(pageBox, 'the page box says 3').toHaveValue('3');
});

test('in two-page view the margin cards sit to the right of the pair, level with their words, when there is room', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: PAIR_WINDOW });
  const first = await postNoteSafe(page, ATTENTION, LINES.l3, 'On the left page');
  await clickAway(page);
  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage).toBe(true);
  await rt(page).setScale(1); // G5: 100% has room for the pair and the margin in this window
  await settleView(page, 700);
  await rt(page).scrollToPage(0);
  await settleView(page);
  await waitForTextLayer(page, 1); // page 2 is beside page 1 now, so its text is there to select
  const second = await postNoteSafe(page, ATTENTION_P2, P2_LINE, 'On the right page');
  await clickAway(page);
  await settleView(page);

  const r0 = await pageRect(page, 0);
  const r1 = await pageRect(page, 1);
  expect(r1.left, 'page 2 is beside page 1').toBeGreaterThan(r0.right);
  const cardA = cardWith(page, 'On the left page');
  const cardB = cardWith(page, 'On the right page');
  await expect(cardA, 'the note on the left page has its card in the margin').toBeVisible();
  await expect(cardB, 'the note on the right page has its card in the margin').toBeVisible();
  const a = await boxOf(cardA);
  const b = await boxOf(cardB);
  await snap(page, testInfo, '18-two-page-cards');
  expect(a.left, `the card of the LEFT page's note is right of the whole pair (card at ${a.left.toFixed(0)}, pair ends at ${r1.right.toFixed(0)})`).toBeGreaterThanOrEqual(r1.right - 4);
  expect(b.left, 'the card of the right page\'s note is right of the pair').toBeGreaterThanOrEqual(r1.right - 4);
  expect(a.right, 'the cards are inside the window').toBeLessThanOrEqual(PAIR_WINDOW.width);
  const linesA = await lineBoxes(page, first);
  const linesB = await lineBoxes(page, second);
  expect(Math.abs(a.top - linesA[0].top), 'the first card is level with its words').toBeLessThanOrEqual(60);
  expect(Math.abs(b.top - linesB[0].top), 'the second card is level with its words').toBeLessThanOrEqual(60);
  expect(overlapArea(a, b), 'the cards do not pile on each other').toBeLessThanOrEqual(1);
});

test('in two-page view with no room beside the pair the cards fold into the Notes button', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION); // 1280 px wide: room for one page and its margin, not for a pair and its margin
  await postNoteSafe(page, ATTENTION, LINES.l3, 'Folds away');
  await clickAway(page);
  const card = cardWith(page, 'Folds away');
  expect(await onScreen(card, page), 'one page at a time: the card is in the margin').toBe(true);

  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage).toBe(true);
  await rt(page).setScale(1);
  await settleView(page, 700);
  await expect.poll(() => onScreen(card, page), { message: 'with the pair filling the window the card is no longer in the margin', timeout: 6_000 }).toBe(false);
  const notes = page.getByRole('button', { name: /^Notes/ });
  await expect(notes, 'the Notes button holds the notes').toBeVisible();
  await snap(page, testInfo, '18-two-page-folded');
  await notes.click();
  await expect(cardWith(page, 'Folds away'), 'the notes panel shows the note').toBeVisible({ timeout: 5_000 });
  const c = await boxOf(cardWith(page, 'Folds away'));
  expect(c.right, 'the panel is inside the window').toBeLessThanOrEqual(1280);
  await snap(page, testInfo, '18-two-page-notes-panel');
  expect(allCards(page).first(), 'the panel has the card').toBeTruthy();
});

// =================================================================================================================
// Presentation mode
// =================================================================================================================

test('Presentation mode goes fullscreen on black with one page fit to the screen, and no header, toolbar, rail or cards', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(MIXED));
  await waitForFirstPage(page);
  await expect(page.getByRole('menubar'), 'precondition: the header\'s menus are there').toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Document' }), 'precondition: so is the toolbar').toBeVisible();
  expect(await isFullscreen(page)).toBe(false);
  await snap(page, testInfo, '18-before-presentation');

  await startPresentation(page);
  await snap(page, testInfo, '18-presentation-page-1');
  await expect(page.getByRole('menubar'), 'no menus').toBeHidden();
  await expect(page.locator('header'), 'no header').toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Document' }), 'no toolbar').toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Page', exact: true }), 'no page box').toBeHidden();
  await expect(railToggle(page, 'Thumbnails'), 'no navigation rail').toBeHidden();
  await expect(hidePill(page), 'no rail pill').toBeHidden();
  expect(await allCards(page).count(), 'no margin cards').toBe(0);

  const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  for (let i = 0; i < MIXED_PAGES.length; i++) {
    await expect.poll(async () => (await view(page)).currentPage, { message: `the ${i + 1}th page is the one shown`, timeout: 6_000 }).toBe(i);
    await settle(page, 600);
    const r = await pageRect(page, i);
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    const label = `page ${i + 1} (${MIXED_PAGES[i].name})`;
    expect(w, `${label}: not wider than the screen`).toBeLessThanOrEqual(win.w + 1);
    expect(h, `${label}: not taller than the screen`).toBeLessThanOrEqual(win.h + 1);
    expect(Math.min(win.w - w, win.h - h), `${label}: fit to the screen, touching the edges one way (it is ${w.toFixed(0)} x ${h.toFixed(0)} in ${win.w} x ${win.h})`).toBeLessThanOrEqual(4);
    expect(Math.abs((r.left + r.right) / 2 - win.w / 2), `${label}: centred side to side`).toBeLessThanOrEqual(2);
    expect(Math.abs((r.top + r.bottom) / 2 - win.h / 2), `${label}: centred top to bottom`).toBeLessThanOrEqual(2);
    const turned = MIXED_PAGES[i].rotate % 180 === 90;
    const shownW = turned ? MIXED_PAGES[i].height : MIXED_PAGES[i].width;
    const shownH = turned ? MIXED_PAGES[i].width : MIXED_PAGES[i].height;
    expect(w / h, `${label}: shown with its own proportions`).toBeCloseTo(shownW / shownH, 1);
    const black = await notBlackOutside(page, { x: r.left, y: r.top, width: w, height: h });
    expect(black.share, `${label}: everything outside the page is black${black.first ? ` (first other pixel at ${black.first.x.toFixed(0)}, ${black.first.y.toFixed(0)})` : ''}`).toBeLessThan(0.0005);
    const shown = (await pagesShown(page)).filter((p) => {
      const ox = Math.max(0, Math.min(p.rect.x + p.rect.width, win.w) - Math.max(p.rect.x, 0));
      const oy = Math.max(0, Math.min(p.rect.y + p.rect.height, win.h) - Math.max(p.rect.y, 0));
      return ox * oy > 0.01 * win.w * win.h;
    });
    expect(shown.map((p) => p.index), `${label}: it is the only page on the screen`).toEqual([i]);
    if (i === 0 || i === 2 || i === 3) await snap(page, testInfo, `18-presentation-page-${i + 1}`);
    if (i < MIXED_PAGES.length - 1) await page.keyboard.press('ArrowRight');
  }
});

test('every step key moves one page; Home goes to the first page and End to the last, and neither goes past the ends', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  await rt(page).scrollToPage(9);
  await settleView(page);
  await startPresentation(page);
  await expectShown(page, [10], 'it starts on the page that was being read, 10');
  await snap(page, testInfo, '18-presentation-start-at-10');

  let n = 10;
  for (const key of ['ArrowRight', 'ArrowDown', 'Space', 'PageDown']) {
    await page.keyboard.press(key);
    n += 1;
    await expectShown(page, [n], `${key} goes forward one page, to ${n}`);
  }
  for (const key of ['ArrowLeft', 'ArrowUp', 'Shift+Space', 'PageUp']) {
    await page.keyboard.press(key);
    n -= 1;
    await expectShown(page, [n], `${key} goes back one page, to ${n}`);
  }
  expect(n).toBe(10);
  expect((await view(page)).currentPage, 'the viewer agrees: page 10').toBe(9);

  await page.keyboard.press('Home');
  await expectShown(page, [1], 'Home goes to the first page');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('PageUp');
  await page.keyboard.press('Shift+Space');
  await page.waitForTimeout(400);
  await expectShown(page, [1], 'going back from the first page stays on it');
  await page.keyboard.press('End');
  await expectShown(page, [400], 'End goes to the last page');
  await snap(page, testInfo, '18-presentation-last-page');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  await expectShown(page, [400], 'going forward from the last page stays on it');
  expect(await isFullscreen(page), 'and the presentation is still going').toBe(true);
});

test('a click on the right half goes forward and a click on the left half goes back', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  await rt(page).scrollToPage(19);
  await settleView(page);
  await startPresentation(page);
  await expectShown(page, [20], 'starts on page 20');
  const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const r = await pageRect(page, 19);
  expect(r.left, 'precondition: there is black on both sides of the page').toBeGreaterThan(win.w * 0.12);

  const clicks = [
    { x: win.w * 0.6, what: 'on the page, right of the middle', dir: 1 },
    { x: win.w * 0.4, what: 'on the page, left of the middle', dir: -1 },
    { x: win.w * 0.95, what: 'on the black at the right edge', dir: 1 },
    { x: win.w * 0.05, what: 'on the black at the left edge', dir: -1 },
  ];
  // Each click is judged on its own: a click that does nothing is written down and the next one starts from where the page really is.
  const problems: string[] = [];
  let n = 20;
  for (const c of clicks) {
    await page.mouse.click(c.x, win.h / 2);
    const want = n + c.dir;
    const got = await pageAfter(page, want);
    if (got !== want) problems.push(`a click ${c.what} should go ${c.dir === 1 ? 'forward' : 'back'} to page ${want}, but the screen shows ${got === null ? 'no readable page' : `page ${got}`}`);
    n = got ?? n;
  }
  expect(problems, 'the halves of the screen step through the pages').toEqual([]);
  await snap(page, testInfo, '18-presentation-after-clicks');
  // The first page: a click on the left half does not go before it.
  await page.keyboard.press('Home');
  await expectShown(page, [1], 'Home');
  await page.mouse.click(win.w * 0.2, win.h / 2);
  await page.waitForTimeout(400);
  await expectShown(page, [1], 'a click on the left half of the first page stays on it');
});

test('in Presentation mode marks show and notes do not', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  // The page as the talk shows it, before there are any marks.
  await startPresentation(page);
  await expect.poll(() => view(page).then((v) => v.currentPage), { message: 'page 1 is shown' }).toBe(0);
  const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const pr0 = await pageRect(page, 0);
  const plain = (await stableFrame(page, { left: 0, top: 0, right: win.w, bottom: win.h }, 6_000)).frame;
  await page.keyboard.press('Escape');
  await waitNotFullscreen(page, 'Esc');

  // Now a highlight and a note.
  const hl = await highlight(page, ATTENTION, LINES.l3);
  const noted = await postNoteSafe(page, ATTENTION, LINES.l7, 'A note that is not for the talk');
  await clickAway(page);
  const normal = await pageRect(page, 0);
  const hlBox = (await lineBoxes(page, hl))[0];
  const noteBox = (await lineBoxes(page, noted))[0];
  const toTalk = (b: { left: number; right: number; top: number; bottom: number }) => ({
    left: pr0.left + ((b.left - normal.left) / (normal.right - normal.left)) * (pr0.right - pr0.left),
    right: pr0.left + ((b.right - normal.left) / (normal.right - normal.left)) * (pr0.right - pr0.left),
    top: pr0.top + ((b.top - normal.top) / (normal.bottom - normal.top)) * (pr0.bottom - pr0.top),
    bottom: pr0.top + ((b.bottom - normal.top) / (normal.bottom - normal.top)) * (pr0.bottom - pr0.top),
  });

  await startPresentation(page);
  await expect.poll(() => view(page).then((v) => v.currentPage), { message: 'page 1 is shown again' }).toBe(0);
  const pr1 = await pageRect(page, 0);
  expect(Math.abs(pr1.left - pr0.left) + Math.abs(pr1.top - pr0.top) + Math.abs(pr1.right - pr0.right), 'the page is shown in the same place as before (no room kept at the right for the notes\' margin)').toBeLessThanOrEqual(2);
  const talk = (await stableFrame(page, { left: 0, top: 0, right: win.w, bottom: win.h }, 6_000)).frame;
  await snap(page, testInfo, '18-presentation-with-marks');
  const hlOnTalk = toTalk(hlBox);
  const noteOnTalk = toTalk(noteBox);
  const probe = changed(plain, talk);
  expect(shareOf(talk, probe, hlOnTalk), 'the highlight shows: its line changed from the plain page').toBeGreaterThan(0.25);
  expect(shareOf(talk, probe, { left: noteOnTalk.left, right: noteOnTalk.right, top: noteOnTalk.top - 6, bottom: noteOnTalk.bottom + 10 }), 'the note shows nothing: its line, and the space under it where a dotted underline would be, is as it was').toBeLessThan(0.002);
  expect(changedOutside(talk, plain, [hlOnTalk], 8), 'nothing else on the screen changed: no note mark, pin, card or panel').toBeLessThan(0.0005);
  expect(await allCards(page).count(), 'no cards').toBe(0);
});

test('the cursor hides after 2 s still and comes back when the mouse moves', async ({ openViewer, server }) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  await startPresentation(page);
  const at = { x: 640, y: 400 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.move(at.x + 6, at.y + 4);
  expect(await cursorAt(page, at.x + 6, at.y + 4), 'right after the mouse moves the cursor shows').not.toBe('none');
  await page.waitForTimeout(1_000);
  expect.soft(await cursorAt(page, at.x + 6, at.y + 4), 'one second still: the cursor still shows').not.toBe('none');
  await page.waitForTimeout(1_700); // 2.7 s since the move
  expect(await cursorAt(page, at.x + 6, at.y + 4), 'after 2 s still the cursor is hidden').toBe('none');
  await page.mouse.move(at.x + 30, at.y + 20);
  expect(await cursorAt(page, at.x + 30, at.y + 20), 'moving the mouse brings it back').not.toBe('none');
  await page.waitForTimeout(2_600);
  expect(await cursorAt(page, at.x + 30, at.y + 20), 'and it hides again after 2 s still').toBe('none');
});

// R99: leaving presentation keeps the page the reader reached, and puts back the zoom (and the rail); when the page did not
// change, the exact scroll too. This replaces "restores the exact page".
test('Esc, or leaving fullscreen any other way, keeps the page reached and restores the zoom; on the same page, the exact scroll', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(BOOK));
  await waitForFirstPage(page);
  const pageBox = page.getByRole('textbox', { name: 'Page', exact: true });

  const leaveWith = {
    Esc: async () => {
      await page.keyboard.press('Escape');
    },
    'document.exitFullscreen() (the browser\'s own way out)': async () => {
      await page.evaluate(() => document.exitFullscreen());
    },
  };
  const setups = [
    {
      name: 'a custom zoom, 200%, scrolled down and along',
      prepare: async () => {
        await rt(page).setScale(2);
        await settled(() => rt(page).scale());
        await rt(page).scrollToPage(29);
        await page.evaluate(() => {
          const s = document.querySelector('[role="document"]')!;
          s.scrollTop += 137;
          s.scrollLeft = 120;
        });
        await settleView(page);
      },
    },
    {
      name: 'fit width, a few pages further on',
      prepare: async () => {
        await page.keyboard.press('Control+0');
        await settled(() => rt(page).scale());
        await rt(page).scrollToPage(44);
        await page.evaluate(() => {
          document.querySelector('[role="document"]')!.scrollTop += 210;
        });
        await settleView(page);
      },
    },
  ] as const;

  let round = 0;
  for (const setup of setups) {
    for (const [how, leave] of Object.entries(leaveWith)) {
      await setup.prepare();
      const before = {
        zoom: (await view(page)).zoom,
        scale: await rt(page).scale(),
        scrollTop: await rt(page).scrollTop(),
        scrollLeft: await page.evaluate(() => document.querySelector('[role="document"]')!.scrollLeft),
        currentPage: (await view(page)).currentPage,
        box: await pageBox.inputValue(),
      };
      round += 1;
      await snap(page, testInfo, `18-restore-${round}-before`);
      // First without moving: everything comes back exactly.
      await startPresentation(page);
      await leave();
      await waitNotFullscreen(page, how);
      await settleView(page, 700);
      const stayed = {
        scale: await rt(page).scale(),
        scrollTop: await rt(page).scrollTop(),
        scrollLeft: await page.evaluate(() => document.querySelector('[role="document"]')!.scrollLeft),
        box: await pageBox.inputValue(),
      };
      expect(stayed.scale, `${setup.name}, left with ${how} on the same page: the zoom is the same`).toBeCloseTo(before.scale, 4);
      expect(Math.abs(stayed.scrollTop - before.scrollTop), `${setup.name}, left with ${how} on the same page: the scroll is the same`).toBeLessThanOrEqual(1);
      expect(Math.abs(stayed.scrollLeft - before.scrollLeft), `${setup.name}, left with ${how} on the same page: and along`).toBeLessThanOrEqual(1);
      expect(stayed.box, `${setup.name}, left with ${how} on the same page: the page box says the same`).toBe(before.box);

      await startPresentation(page);
      await page.keyboard.press('End'); // go far from where we were
      await expectShown(page, [400], 'the presentation went to the last page');
      await leave();
      await waitNotFullscreen(page, how);
      await settleView(page, 700);
      const label = `${setup.name}, left with ${how}`;
      await expect(page.getByRole('menubar'), `${label}: the header is back`).toBeVisible();
      await expect(page.getByRole('toolbar', { name: 'Document' }), `${label}: and the toolbar`).toBeVisible();
      const after = {
        zoom: (await view(page)).zoom,
        scale: await rt(page).scale(),
        scrollTop: await rt(page).scrollTop(),
        scrollLeft: await page.evaluate(() => document.querySelector('[role="document"]')!.scrollLeft),
        currentPage: (await view(page)).currentPage,
        box: await pageBox.inputValue(),
      };
      expect(after.zoom, `${label}: the zoom setting is the same`).toEqual(before.zoom);
      expect(after.scale, `${label}: the zoom is the same`).toBeCloseTo(before.scale, 4);
      // R99: the page reached in the presentation stays (the last page), at the same place across.
      expect(after.currentPage, `${label}: the page reached stays`).toBe(399);
      expect(after.box, `${label}: the page box says the page reached`).toBe('400');
      expect(Math.abs(after.scrollLeft - before.scrollLeft), `${label}: and along (${before.scrollLeft.toFixed(1)} -> ${after.scrollLeft.toFixed(1)})`).toBeLessThanOrEqual(1);
      await snap(page, testInfo, `18-restore-${round}-after`);
    }
  }
});
