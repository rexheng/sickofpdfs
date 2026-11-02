// Walkthrough 1a, "Caret browsing" (ruling R93, Nov 2, owner request): a text cursor for reading and selecting by keyboard.
// The owner turns the switch on (View → Caret browsing, or its key from the shortcut sheet), clicks between two letters, moves with the
// arrow keys, Ctrl+arrow, Home, End and PageDown, selects with Shift, copies, marks and comments the selection, and finds the cursor where
// a Find hit was. Without the switch the arrow keys scroll as before, and Shift+arrow still adjusts a mouse selection.
//
// Spec, R93: "The switch. View → 'Caret browsing', with a check mark and a shortcut. It is remembered on this computer and off at first."
// "Placing it. With the switch on, a click in the text puts a thin blinking cursor between letters. With reduced motion, it doesn't blink.
// A drag still selects as before." "Moving. The cursor follows reading order, so two-column papers go down one column and then the next.
// The page scrolls to keep it in view. Left/Right move one letter, and Ctrl+Left/Right one word. Up/Down move one line, keeping roughly the
// same position across. Home/End go to the start or end of the line, and Ctrl+Home/End to the start or end of the PDF. PageUp/PageDown
// move one screen." "Selecting. Shift plus any of those keys extends the selection from the cursor. This works with or without the switch:
// after a mouse selection, Shift+arrows adjust its end. The selection is the same as a mouse selection, so copy, the mark keys, Shift+F10
// (the mark menu) and comments all work on it. Esc collapses the selection back to the cursor." "Elsewhere. It works on rotated pages and
// in two-page view. A Find hit, on Enter, puts the cursor at the hit. Scanned pages without text are skipped, with a quiet note once per
// tab. A screen reader hears the line the cursor moves to." "Without the switch, the arrow keys scroll as before."
// Also: the shortcut sheet ("it is listed in the shortcut sheet" is the rule for the sibling switch R90, and R93 says "and a shortcut");
// R71 (a mark lets go of the selection) and R72 (the mark menu keys).
//
// HOW THE WALKTHROUGH SEES THE CURSOR (the spec names no test hook and no markup): where it is = which letter Shift+Right starts the
// selection on (caretAt in support/caret.spec-blind.ts); whether one is drawn = a thin vertical band of changed pixels in a strip of the
// page; what is announced = the live regions of the page. GUESSES (the spec is silent) are listed in caret-tests-report.md and marked
// "GUESS" below.
import type { Page } from '@playwright/test';
import type { Glyph } from '../../packages/viewer/src/backend/types';
import { expect, test, type FixtureServer } from '../support/test';
import { collapse, squash } from '../support/tl-copy.spec-blind';
import {
  copySelection,
  dragGlyphs,
  findOnPage,
  fixture,
  glyphsOf,
  inclusive,
  openClipboardReader,
  openFixture,
  pageMap,
  rangeText,
  readSelection,
  th,
  trimmed,
  waitForTextLayer,
  type TlFixture,
} from '../support/tl-blind.spec-blind';
import {
  CARET_ROW,
  caretAt,
  caretBand,
  caretClip,
  caretShortcut,
  caretTicked,
  clickAt,
  clickCaretRow,
  columnsOf,
  ensureCaretMixed,
  frames,
  grabClip,
  inView,
  letters,
  liveLog,
  linesAt,
  linesOf,
  longLines,
  noteSeen,
  plainRun,
  RESERVED_KEYS,
  press,
  sampleClip,
  selected,
  setCaret,
  startLiveLog,
  watchScanNotes,
  whereIs,
  wordRun,
  xBefore,
  yieldsToTyping,
  CARET_MIXED,
  type Caret,
} from './support/caret.spec-blind';
import { FIXTURES as WALK, ensureBook } from './support/fixtures.spec-blind';
import { expectCount, field, fillQuery, openFind } from './support/find.spec-blind';
import {
  ATTENTION,
  answerSavePrompt,
  cardWith,
  lineBoxes,
  markMenu,
  markTokens,
  openPaper,
  paintOf,
  paintOfSelection,
  reloadAndWait,
  startNote,
  swatch,
  waitSaved,
  waitStored,
  SAVING_AVAILABLE,
  type Selected,
} from './support/marks.spec-blind';
import { ROWS, TURN_WINDOW, PAIR_WINDOW, chooseView, openViewMenu, rowIn, settleView, turn, view, waitGlyph } from './support/views.spec-blind';
import { rt, scrollerRect, settled, snap, waitReady } from './support/viewer.spec-blind';

test.setTimeout(180_000);

const TWO = fixture('two-column');
const ROTATED_FILE = fixture('rotated-page');
const BOOK: TlFixture = { name: 'caret-book', file: `walkthroughs/${WALK.book}`, page: 0, dir: 'ltr' };
const MIXED: TlFixture = { name: 'caret-mixed', file: `walkthroughs/${CARET_MIXED}`, page: 0, dir: 'ltr' };
const PAPER_URL = '/f/paper-50.pdf';
const SCAN_URL = '/f/scan-120.pdf';

/** "Roughly the same position across", in points: two letters of this paper's text. */
const SAME_PLACE = 9;

test.beforeAll(async () => {
  await ensureBook();
  await ensureCaretMixed();
});

type OpenViewer = (source: string, opts?: { back?: string; page?: number }) => Promise<Page>;

interface Doc {
  page: Page;
  fx: TlFixture;
  glyphs: Glyph[];
  /** Lines of the whole page, left column first when there are two. */
  lines: ReturnType<typeof linesOf>;
  cols: ReturnType<typeof columnsOf>;
}

async function open(openViewer: OpenViewer, server: FixtureServer, fx: TlFixture, o: { viewport?: { width: number; height: number } } = {}): Promise<Doc> {
  const opened = await openFixture(openViewer, server, fx, o);
  const glyphs = await glyphsOf(opened.page, fx.page);
  return { page: opened.page, fx, glyphs, lines: linesOf(glyphs), cols: columnsOf(glyphs, 612) };
}

/** The cursor, which must be somewhere. */
async function whereNow(page: Page, why: string): Promise<Caret> {
  const c = await caretAt(page);
  expect(c, `${why}: the cursor is somewhere (Shift+Right or Shift+Left selects a letter from it)`).not.toBeNull();
  return c!;
}

/** The cursor is in front of char `index` of page `pageIndex`. */
async function expectCaretAt(page: Page, pageIndex: number, index: number, why: string): Promise<void> {
  const c = await whereNow(page, why);
  expect(c, why).toEqual({ pageIndex, index });
}

/** The page is back to a steady cursor: the OS asks for reduced motion, and the viewer is opened again as the owner would after setting it. */
async function reduceMotion(page: Page, fx: TlFixture): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reloadAndWait(page, fx);
}

// =================================================================================================================
// The switch
// =================================================================================================================

test('View has a "Caret browsing" row with a check mark; it is off at first, and choosing it turns it on and off', async ({ openViewer, server }, testInfo) => {
  const { page } = await open(openViewer, server, TWO);
  const menu = await openViewMenu(page);
  const row = rowIn(menu, CARET_ROW);
  await expect(row, 'View has a row named "Caret browsing"').toBeVisible();
  await expect(row, 'it is a check row, and it is off at first (R93: "off at first")').toHaveAttribute('aria-checked', 'false');
  await snap(page, testInfo, '1a-view-menu-caret-off');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  await clickCaretRow(page);
  const again = await openViewMenu(page);
  await expect(rowIn(again, CARET_ROW), 'after choosing it, the row shows its check mark').toHaveAttribute('aria-checked', 'true');
  await snap(page, testInfo, '1a-view-menu-caret-on');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  await clickCaretRow(page);
  expect(await caretTicked(page), 'choosing it again turns it off').toBe(false);
});

test('the shortcut sheet lists Caret browsing with its key, and that key turns it on and off', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  const page = d.page;
  const sheetKey = await caretShortcut(page, testInfo);
  testInfo.annotations.push({ type: 'shortcut for Caret browsing', description: sheetKey.labels.join(' or ') });
  expect(sheetKey.clashes, `the key ${sheetKey.labels[0]} is used by no other row of the sheet (R93: "a key that clashes with nothing")`).toBe(0);
  expect(RESERVED_KEYS, `${sheetKey.labels[0]} is not a key the research notes say never to bind (F7 is the one allowed, "if Chrome lets the viewer have it")`).not.toContain(sheetKey.labels[0].toLowerCase());
  const menu = await openViewMenu(page);
  await expect.soft(rowIn(menu, CARET_ROW), 'the View menu shows the same key on the row').toContainText(sheetKey.labels[0]);
  await page.keyboard.press('Escape');

  const spot = d.cols.left[3].glyphs[10];
  await clickAt(page, 0, spot); // the keyboard focus is on the page, not on a menu
  expect(await caretTicked(page), 'it starts off').toBe(false);
  await page.keyboard.press(sheetKey.press);
  await expect.poll(() => caretTicked(page), { message: `${sheetKey.press} turns Caret browsing on`, timeout: 4_000, intervals: [100, 200, 400] }).toBe(true);
  await clickAt(page, 0, spot);
  await page.keyboard.press(sheetKey.press);
  await expect.poll(() => caretTicked(page), { message: `${sheetKey.press} turns it off again`, timeout: 4_000, intervals: [100, 200, 400] }).toBe(false);
});

test('it is remembered after a reload and for another PDF, and another open tab follows when it is changed', async ({ openViewer, server }, testInfo) => {
  const a = await open(openViewer, server, TWO);
  await setCaret(a.page, true);
  await reloadAndWait(a.page, TWO);
  expect(await caretTicked(a.page), 'after a reload the switch is still on').toBe(true);
  // and it works: a click puts the cursor in front of a letter
  const k = plainRun(a.glyphs, a.cols.left[3].first + 8, a.cols.left[3].last, 4) + 1;
  await clickAt(a.page, 0, a.glyphs[k]);
  await expectCaretAt(a.page, 0, k, 'after the reload a click puts the cursor between the letters');
  await snap(a.page, testInfo, '1a-remembered-after-reload');

  // another PDF, in another tab
  const other = await openViewer(server.url(PAPER_URL));
  await waitReady(other);
  await other.bringToFront();
  expect(await caretTicked(other), 'another PDF opens with the switch on').toBe(true);

  // changing it in one tab changes the other without a reload
  await a.page.bringToFront();
  await setCaret(a.page, false);
  await other.bringToFront();
  await expect.poll(() => caretTicked(other), { message: 'the other tab follows when it is turned off', timeout: 10_000, intervals: [300, 500, 1000] }).toBe(false);
  await a.page.bringToFront();
  await setCaret(a.page, true);
  await other.bringToFront();
  await expect.poll(() => caretTicked(other), { message: 'and when it is turned on again', timeout: 10_000, intervals: [300, 500, 1000] }).toBe(true);
  await snap(other, testInfo, '1a-other-tab-follows');
});

// =================================================================================================================
// Placing it
// =================================================================================================================

test('a click puts a thin cursor between two letters, in the gap nearest the click', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  await reduceMotion(d.page, TWO); // a steady cursor, so one picture of it is enough
  const line = d.cols.left[3];
  const k = plainRun(d.glyphs, line.first + 8, line.last, 6) + 2;
  await clickAt(d.page, 0, d.glyphs[k], 'before');
  await d.page.mouse.move(8, 600);
  await frames(d.page, 3);
  const map = await pageMap(d.page, 0);
  const clip = caretClip(map, d.glyphs[k]);
  const withCaret = await grabClip(d.page, clip);
  await snap(d.page, testInfo, '1a-caret-placed');
  expect(await selected(d.page), 'a click selects nothing').toEqual([]);

  // the same strip with the cursor somewhere else
  await clickAt(d.page, 0, d.glyphs[d.cols.left[12].first + 10], 'before');
  await d.page.mouse.move(8, 600);
  await frames(d.page, 3);
  const without = await grabClip(d.page, clip);
  const band = caretBand(withCaret, without, clip);
  expect(band.present, `a thin vertical cursor is drawn at the click (R93: "a thin blinking cursor between letters"); the strip differs as: ${JSON.stringify(band)}`).toBe(true);
  expect(Math.abs(band.centre! - 10), `it stands on the gap between the two letters (centre ${band.centre} of a strip whose gap is at 10 px)`).toBeLessThanOrEqual(4);
  expect(band.width!, 'and it is thin').toBeLessThanOrEqual(4);

  // where the cursor is: in front of the letter clicked on its left half, behind it when clicked on its right half
  await clickAt(d.page, 0, d.glyphs[k], 'before');
  await expectCaretAt(d.page, 0, k, 'a click on the left half of a letter puts the cursor in front of it');
  await clickAt(d.page, 0, d.glyphs[k], 'after');
  await expectCaretAt(d.page, 0, k + 1, 'a click on the right half of the same letter puts it behind it');
});

test('the cursor blinks', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const line = d.cols.left[3];
  const k = plainRun(d.glyphs, line.first + 8, line.last, 6) + 2;
  const map = await pageMap(d.page, 0);
  const clip = caretClip(map, d.glyphs[k]);
  await clickAt(d.page, 0, d.glyphs[d.cols.left[12].first + 10], 'before'); // the cursor is not on the strip
  await d.page.mouse.move(8, 600);
  const without = await grabClip(d.page, clip);
  await clickAt(d.page, 0, d.glyphs[k]);
  await d.page.mouse.move(8, 600);
  const pictures = await sampleClip(d.page, clip, 30, 110);
  const on = pictures.map((p) => caretBand(p, without, clip).present);
  testInfo.annotations.push({ type: 'cursor shown in', description: `${on.filter(Boolean).length} of ${on.length} pictures taken 110 ms apart` });
  expect(on.some(Boolean), 'the cursor is drawn on the spot that was clicked').toBe(true);
  expect(on.some((v) => !v), 'and it blinks: some pictures show no cursor (R93: "a thin blinking cursor")').toBe(true);
  await snap(d.page, testInfo, '1a-caret-blinking');
});

test('with reduced motion the cursor does not blink', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  await reduceMotion(d.page, TWO);
  const line = d.cols.left[3];
  const k = plainRun(d.glyphs, line.first + 8, line.last, 6) + 2;
  const map = await pageMap(d.page, 0);
  const clip = caretClip(map, d.glyphs[k]);
  await clickAt(d.page, 0, d.glyphs[d.cols.left[12].first + 10], 'before');
  await d.page.mouse.move(8, 600);
  const without = await grabClip(d.page, clip);
  await clickAt(d.page, 0, d.glyphs[k]);
  await d.page.mouse.move(8, 600);
  const pictures = await sampleClip(d.page, clip, 30, 110);
  const on = pictures.map((p) => caretBand(p, without, clip).present);
  testInfo.annotations.push({ type: 'cursor shown in', description: `${on.filter(Boolean).length} of ${on.length} pictures taken 110 ms apart, reduced motion` });
  expect(on.every(Boolean), `with reduced motion the cursor is in every picture (${on.filter(Boolean).length} of ${on.length}): it never blinks off (R93)`).toBe(true);
  await snap(d.page, testInfo, '1a-caret-steady-reduced-motion');
});

test('a drag still selects as before, and a click afterwards lets go and puts the cursor there', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const line = d.cols.left[5];
  const a = line.glyphs[3].index;
  const b = line.glyphs[24].index;
  const drag = await dragGlyphs(d.page, 0, a, b);
  await snap(d.page, testInfo, '1a-drag-selects');
  expect(drag.ranges, 'with the switch on, a drag from one letter to another selects from the first to the last, both included').toEqual([inclusive(0, a, b)]);
  expect(squash(drag.domText), 'and the browser holds the same words').toBe(squash(await rangeText(d.page, 0, a, b + 1)));

  const k = plainRun(d.glyphs, d.cols.left[10].first + 5, d.cols.left[10].last, 3) + 1;
  await clickAt(d.page, 0, d.glyphs[k]);
  expect(await selected(d.page), 'a click lets go of the selection').toEqual([]);
  await expectCaretAt(d.page, 0, k, 'and puts the cursor where it landed');
});

// =================================================================================================================
// Moving
// =================================================================================================================

test('Left and Right move one letter; Ctrl+Left and Ctrl+Right move one word', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const { words } = wordRun(d.glyphs, d.cols.left, 2, 6);
  const start = words[0].start;
  await clickAt(d.page, 0, d.glyphs[start]);
  await expectCaretAt(d.page, 0, start, 'the cursor is in front of the first word');

  // one letter at a time
  for (let n = 1; n <= 3; n++) {
    await press(d.page, 'ArrowRight');
    await expectCaretAt(d.page, 0, start + n, `Right #${n} moves one letter`);
  }
  await snap(d.page, testInfo, '1a-three-letters-right');
  await press(d.page, 'ArrowLeft');
  await expectCaretAt(d.page, 0, start + 2, 'Left moves one letter back');
  await press(d.page, 'ArrowLeft', 2);
  await expectCaretAt(d.page, 0, start, 'two more Lefts are back where it began');

  // one word at a time. GUESS: the end of the word or the start of the next one (Chrome does the first on Linux and the second on Windows).
  for (let n = 1; n <= 4; n++) {
    await press(d.page, 'Control+ArrowRight');
    const c = await whereNow(d.page, `Ctrl+Right #${n}`);
    expect([words[n - 1].end, words[n].start], `Ctrl+Right #${n} moves one word: the end of word ${n} or the start of word ${n + 1} (got ${c.index})`).toContain(c.index);
  }
  for (let n = 3; n >= 1; n--) {
    await press(d.page, 'Control+ArrowLeft');
    await expectCaretAt(d.page, 0, words[n].start, `Ctrl+Left goes to the start of word ${n + 1}`);
  }
});

test('Up and Down move one line and keep the cursor at about the same place across', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const first = longLines(d.cols.left, 2, d.cols.left.length, 5);
  const base = d.cols.left[first];
  const k = plainRun(d.glyphs, base.first + 20, base.last - 5, 3) + 1;
  const x0 = xBefore(d.glyphs, k);
  await clickAt(d.page, 0, d.glyphs[k]);
  await expectCaretAt(d.page, 0, k, 'the cursor starts mid-line');
  for (let n = 1; n <= 4; n++) {
    await press(d.page, 'ArrowDown');
    const c = await whereNow(d.page, `Down #${n}`);
    expect(linesAt(d.cols.left, c.index), `Down #${n} is on the next line (line ${first + n} of the column); the cursor is in front of char ${c.index}`).toContain(first + n);
    expect(Math.abs(xBefore(d.glyphs, c.index) - x0), `Down #${n} keeps about the same place across: ${xBefore(d.glyphs, c.index).toFixed(1)} pt against ${x0.toFixed(1)} pt`).toBeLessThanOrEqual(SAME_PLACE);
  }
  await snap(d.page, testInfo, '1a-four-lines-down');
  for (let n = 3; n >= 0; n--) {
    await press(d.page, 'ArrowUp');
    const c = await whereNow(d.page, `Up to line ${first + n}`);
    expect(linesAt(d.cols.left, c.index), `Up is on the line above (line ${first + n})`).toContain(first + n);
    expect(Math.abs(xBefore(d.glyphs, c.index) - x0), `Up keeps about the same place across: ${xBefore(d.glyphs, c.index).toFixed(1)} pt against ${x0.toFixed(1)} pt`).toBeLessThanOrEqual(SAME_PLACE);
  }
});

test('Home and End go to the start and the end of the line', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const n = longLines(d.cols.left, 3, d.cols.left.length, 1);
  const line = d.cols.left[n];
  const k = plainRun(d.glyphs, line.first + 15, line.last - 8, 3) + 1;
  await clickAt(d.page, 0, d.glyphs[k]);
  await expectCaretAt(d.page, 0, k, 'the cursor starts mid-line');

  await press(d.page, 'Home');
  const home = await whereNow(d.page, 'Home');
  expect(linesAt(d.cols.left, home.index), `Home puts the cursor at the start of line ${n} (it stands in front of char ${home.index}, the line starts at ${line.first})`).toContain(n);
  expect(home.index, 'in front of the first letter of the line, or just before it (the line break)').toBeGreaterThanOrEqual(line.first - 3);
  expect(home.index).toBeLessThanOrEqual(line.first);
  // and the whole line is what Shift+End picks up from there
  await press(d.page, 'Shift+End');
  const toEnd = await selected(d.page);
  expect(toEnd, 'Shift+End from the start of the line selects one piece of text').toHaveLength(1);
  expect(trimmed(d.glyphs, toEnd[0]), 'and it is exactly the line, first letter to last').toEqual([line.first, line.last + 1]);
  await snap(d.page, testInfo, '1a-home-then-shift-end');
  await press(d.page, 'Escape');

  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'End');
  await press(d.page, 'Shift+Home');
  const toStart = await selected(d.page);
  expect(toStart, 'End and then Shift+Home select one piece of text').toHaveLength(1);
  expect(trimmed(d.glyphs, toStart[0]), 'which is exactly the same line: End went to its end').toEqual([line.first, line.last + 1]);
});

test('Ctrl+End goes to the end of the PDF and Ctrl+Home to the start, and the page scrolls to show the cursor', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, fixture('attention-p1'));
  await setCaret(d.page, true);
  const last = (await rt(d.page).doc())!.pageCount - 1;
  expect(last, 'the paper has several pages').toBeGreaterThan(3);
  const abstract = d.lines[33];
  await clickAt(d.page, 0, d.glyphs[plainRun(d.glyphs, abstract.first + 10, abstract.last, 3) + 1]);

  await press(d.page, 'Control+End');
  await waitForTextLayer(d.page, last);
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  const endGlyphs = await glyphsOf(d.page, last);
  const lastLetter = endGlyphs.reduce((m, g) => (g.box.width > 0 && !g.generated && /\S/u.test(g.text) ? g.index : m), -1);
  const atEnd = await whereNow(d.page, 'Ctrl+End');
  await snap(d.page, testInfo, '1a-ctrl-end');
  expect(atEnd.pageIndex, 'Ctrl+End puts the cursor on the last page').toBe(last);
  expect(atEnd.index, `after the last letter of the PDF (char ${lastLetter})`).toBeGreaterThan(lastLetter);
  expect(await inView(d.page, last, endGlyphs, atEnd.index), 'and the page has scrolled to show it').toBe(true);

  await press(d.page, 'Control+Home');
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  const atStart = await whereNow(d.page, 'Ctrl+Home');
  await snap(d.page, testInfo, '1a-ctrl-home');
  expect(atStart.pageIndex, 'Ctrl+Home puts the cursor on the first page').toBe(0);
  expect(atStart.index, 'in front of the first letter').toBeLessThanOrEqual(d.lines[0].first);
  expect(await rt(d.page).scrollTop(), 'and the first page is on screen again').toBeLessThanOrEqual(60);
});

test('PageDown and PageUp move the cursor about one screen', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, BOOK);
  await setCaret(d.page, true);
  const line = d.lines[4];
  await clickAt(d.page, 0, line.glyphs[14]);
  const before = await whereNow(d.page, 'start');
  const docY = async (c: Caret): Promise<number> => {
    const g = await glyphsOf(d.page, c.pageIndex);
    const at = await whereIs(d.page, c.pageIndex, g, c.index);
    expect(at, `char ${c.index} of page ${c.pageIndex + 1} has a place on the screen`).not.toBeNull();
    return at!.y + (await rt(d.page).scrollTop());
  };
  const y0 = await docY(before);
  const vh = await rt(d.page).viewportHeight();

  await press(d.page, 'PageDown');
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  const down = await whereNow(d.page, 'PageDown');
  const y1 = await docY(down);
  await snap(d.page, testInfo, '1a-page-down');
  expect(y1 - y0, `PageDown moves the cursor about one screen down (${vh} px): it moved ${Math.round(y1 - y0)} px`).toBeGreaterThan(vh * 0.6);
  expect(y1 - y0, `and not much more than a screen: it moved ${Math.round(y1 - y0)} px`).toBeLessThan(vh * 1.25);
  const glyphsDown = await glyphsOf(d.page, down.pageIndex);
  expect(await inView(d.page, down.pageIndex, glyphsDown, down.index), 'the cursor is on screen after PageDown').toBe(true);

  await press(d.page, 'PageUp');
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  const up = await whereNow(d.page, 'PageUp');
  const y2 = await docY(up);
  expect(Math.abs(y2 - y0), `PageUp comes back to about where it began (${Math.round(y2 - y0)} px off)`).toBeLessThan(vh * 0.2);

  // and Shift+PageDown selects about a screen of text from the cursor
  await press(d.page, 'Shift+PageDown');
  const ranges = await selected(d.page);
  const chars = ranges.reduce((n, r) => n + (r.end - r.start), 0);
  expect(ranges[0]?.start, 'Shift+PageDown extends the selection from the cursor').toBe(up.index);
  expect(chars, `and covers about a screen of text (${chars} chars)`).toBeGreaterThan(900);
});

test('on a two-column paper Down from the last line of column 1 goes to the first line of column 2, and Up comes back', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const lastLeft = d.cols.left[d.cols.left.length - 1];
  const firstRight = d.cols.right[0];
  const lastIndex = d.cols.left.length - 1; // in d.cols.all the left column comes first
  const k = lastLeft.glyphs[Math.min(6, lastLeft.glyphs.length - 2)].index;
  await clickAt(d.page, 0, d.glyphs[k]);
  await expectCaretAt(d.page, 0, k, 'the cursor is on the last line of the left column');
  await press(d.page, 'ArrowDown');
  const down = await whereNow(d.page, 'Down from the last line of column 1');
  await snap(d.page, testInfo, '1a-two-column-down');
  expect(linesAt(d.cols.all, down.index), `Down goes to the first line of column 2 (line ${lastIndex + 1}), not to the line under it in the page (the cursor stands in front of char ${down.index})`).toContain(lastIndex + 1);
  expect(xBefore(d.glyphs, down.index), 'the cursor is in the right column').toBeGreaterThan(300);
  expect(down.index, 'on its first line').toBeLessThanOrEqual(firstRight.last);

  await press(d.page, 'ArrowUp');
  const up = await whereNow(d.page, 'Up from the first line of column 2');
  expect(linesAt(d.cols.all, up.index), 'Up from the first line of column 2 goes back to the last line of column 1').toContain(lastIndex);
  expect(xBefore(d.glyphs, up.index), 'in the left column').toBeLessThan(300);

  // Right at the end of column 1 goes on into column 2
  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'End');
  await press(d.page, 'ArrowRight', 2);
  const over = await whereNow(d.page, 'End, then Right twice');
  expect(linesAt(d.cols.all, over.index), 'Right past the end of column 1 goes to the start of column 2').toContain(lastIndex + 1);
  expect(xBefore(d.glyphs, over.index), 'in the right column').toBeGreaterThan(300);
  expect(over.index - firstRight.first, 'by the first letters').toBeLessThanOrEqual(3);
});

test('moving off the end of a page goes to the next page, and the page scrolls to keep the cursor in view', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, BOOK);
  await setCaret(d.page, true);
  // The book's pages: a heading and 27 lines of text ("Page 1, line 30" is the last one).
  const L = d.lines.length - 1;
  const lastLine = d.lines[L];
  expect(lastLine.glyphs.length, 'the last line is a full line').toBeGreaterThan(60);

  // Down from the line above reaches the last line, and then the first line of the next page; the view follows
  await clickAt(d.page, 0, d.glyphs[plainRun(d.glyphs, d.lines[L - 1].first + 20, d.lines[L - 1].last, 3)]);
  await press(d.page, 'ArrowDown');
  expect(linesAt(d.lines, (await whereNow(d.page, 'Down to the last line')).index), 'Down from the line above is on the last line of the page').toContain(L);
  await press(d.page, 'ArrowDown');
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  const next = await whereNow(d.page, 'Down from the last line of page 1');
  const nextGlyphs = await glyphsOf(d.page, 1);
  await snap(d.page, testInfo, '1a-down-onto-next-page');
  expect(next.pageIndex, 'Down from the last line of a page goes to the next page').toBe(1);
  expect(next.index, 'to its first line (the heading)').toBeLessThanOrEqual(nextGlyphs[nextGlyphs.findIndex((g) => g.generated)]?.index ?? 6);
  expect(await inView(d.page, 1, nextGlyphs, next.index), 'and the page scrolled to show the cursor').toBe(true);

  // Right and Left across the same edge. GUESS: the end of one page and the start of the next may be one step or two apart.
  await clickAt(d.page, 0, lastLine.glyphs[30]);
  await press(d.page, 'End');
  await press(d.page, 'ArrowRight', 2);
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  const over = await whereNow(d.page, 'End, then Right twice');
  expect(over.pageIndex, 'Right at the end of the last line goes on to the next page').toBe(1);
  expect(over.index, 'to its first letters').toBeLessThanOrEqual(3);
  expect(over.index).toBeGreaterThanOrEqual(1);
  await press(d.page, 'ArrowLeft', 3);
  const back = await whereNow(d.page, 'Left three times');
  expect(back.pageIndex, 'Left three times is back on the first page').toBe(0);
  expect(back.index, 'in its last line').toBeGreaterThanOrEqual(lastLine.last - 3);
  expect(back.index).toBeLessThanOrEqual(lastLine.last + 1);

  // The view follows the cursor all the way down a page
  await press(d.page, 'Control+Home');
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  await clickAt(d.page, 0, d.lines[2].glyphs[12]);
  const tops: number[] = [];
  for (let n = 1; n <= 36; n++) {
    await press(d.page, 'ArrowDown');
    if (n % 6 !== 0) continue;
    await settled(() => rt(d.page).scrollTop(), 0.5, 2_000);
    const c = await whereNow(d.page, `Down #${n}`);
    const g = await glyphsOf(d.page, c.pageIndex);
    expect(await inView(d.page, c.pageIndex, g, c.index), `after ${n} Downs the cursor (page ${c.pageIndex + 1}, char ${c.index}) is on screen`).toBe(true);
    tops.push(await rt(d.page).scrollTop());
  }
  expect(tops[tops.length - 1], 'the page really scrolled').toBeGreaterThan(tops[0] + 300);
  const end = await whereNow(d.page, 'after 36 Downs');
  expect(end.pageIndex, '36 lines down from the third line of page 1 is on the second page (each page has 28 lines)').toBe(1);
});

// =================================================================================================================
// Selecting
// =================================================================================================================

test('Shift+Right five times selects five letters, and Ctrl+C copies exactly those five', async ({ openViewer, server, context }, testInfo) => {
  const reader = await openClipboardReader(context, server);
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const line = d.cols.left[6];
  // Triage (caret): this line of the fixture has no 9-letter run after its 10th char; the search goes on down the column.
  const i = plainRun(d.glyphs, line.first + 10, d.cols.left[d.cols.left.length - 1].last, 9);
  const k = i + 1;
  await clickAt(d.page, 0, d.glyphs[k]);
  await expectCaretAt(d.page, 0, k, 'the cursor is inside a word');

  await press(d.page, 'Shift+ArrowRight', 5);
  const sel = await readSelection(d.page);
  await snap(d.page, testInfo, '1a-five-letters-selected');
  expect(sel.ranges, 'five Shift+Rights select the five letters after the cursor').toEqual([{ pageIndex: 0, start: k, end: k + 5 }]);
  const five = await rangeText(d.page, 0, k, k + 5);
  expect(five, 'they are five plain letters').toMatch(/^\p{L}{5}$/u);
  expect(squash(sel.domText), 'the browser holds the same five letters (find and screen readers use it)').toBe(five);

  const copied = await copySelection(d.page, reader);
  expect(collapse(copied), `Ctrl+C copies exactly those five letters, "${five}"`).toBe(five);
  expect(copied.replace(/\s/gu, '').length, 'and nothing else').toBe(5);

  await press(d.page, 'Shift+ArrowLeft', 2);
  expect(await selected(d.page), 'Shift+Left takes letters back, from the same end').toEqual([{ pageIndex: 0, start: k, end: k + 3 }]);
  expect(collapse(await copySelection(d.page, reader)), 'and Ctrl+C copies the three that are left').toBe(await rangeText(d.page, 0, k, k + 3));
  await reader.close();
});

test('Ctrl+Shift+Right selects words, Shift+Down selects to the next line, Shift+Home and Shift+End to the ends of the line', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);

  // words
  const { words } = wordRun(d.glyphs, d.cols.left, 2, 5);
  await clickAt(d.page, 0, d.glyphs[words[0].start]);
  await press(d.page, 'Control+Shift+ArrowRight', 2);
  const two = await selected(d.page);
  expect(two, 'Ctrl+Shift+Right twice selects one piece of text').toHaveLength(1);
  expect(two[0].start, 'from the cursor').toBe(words[0].start);
  expect(trimmed(d.glyphs, two[0]), 'to the end of the second word (a trailing space may come with it)').toEqual([words[0].start, words[1].end]);
  await snap(d.page, testInfo, '1a-two-words-selected');
  await press(d.page, 'Control+Shift+ArrowLeft');
  const one = await selected(d.page);
  expect(trimmed(d.glyphs, one[0]), 'Ctrl+Shift+Left takes the second word back').toEqual([words[0].start, words[0].end]);
  await press(d.page, 'Escape');

  // lines
  const first = longLines(d.cols.left, 2, d.cols.left.length, 3);
  const base = d.cols.left[first];
  const k = plainRun(d.glyphs, base.first + 20, base.last - 5, 3) + 1;
  const x0 = xBefore(d.glyphs, k);
  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'Shift+ArrowDown');
  const down = await selected(d.page);
  expect(down, 'Shift+Down selects one piece of text').toHaveLength(1);
  expect(down[0].start, 'from the cursor').toBe(k);
  expect(linesAt(d.cols.left, down[0].end), 'to about the same place on the next line').toContain(first + 1);
  expect(Math.abs(xBefore(d.glyphs, down[0].end) - x0), 'across').toBeLessThanOrEqual(SAME_PLACE);
  await snap(d.page, testInfo, '1a-shift-down');
  await press(d.page, 'Shift+ArrowDown');
  expect(linesAt(d.cols.left, (await selected(d.page))[0].end), 'Shift+Down again goes to the line after').toContain(first + 2);
  await press(d.page, 'Shift+ArrowUp');
  expect(linesAt(d.cols.left, (await selected(d.page))[0].end), 'Shift+Up takes a line back').toContain(first + 1);
  await press(d.page, 'Escape');

  // ends of the line
  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'Shift+End');
  const toEnd = await selected(d.page);
  expect(trimmed(d.glyphs, toEnd[0]), 'Shift+End selects to the end of the line').toEqual([k, base.last + 1]);
  await press(d.page, 'Escape');
  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'Shift+Home');
  const toStart = await selected(d.page);
  expect(trimmed(d.glyphs, toStart[0]), 'Shift+Home selects back to the start of the line').toEqual([base.first, k]);
  await press(d.page, 'Escape');

  // ends of the PDF (one page here)
  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'Control+Shift+End');
  const toLast = await selected(d.page);
  expect(toLast[0].start, 'Ctrl+Shift+End selects from the cursor').toBe(k);
  expect(toLast[toLast.length - 1].end, 'to the end of the PDF').toBeGreaterThan(d.cols.right[d.cols.right.length - 1].last);
  await press(d.page, 'Escape');
  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'Control+Shift+Home');
  const toFirst = await selected(d.page);
  expect(toFirst[0].start, 'Ctrl+Shift+Home selects back to the start of the PDF').toBeLessThanOrEqual(d.lines[0].first);
  expect(toFirst[toFirst.length - 1].end, 'from the cursor').toBe(k);
});

test('a keyboard selection takes the mark key, the mark menu (Shift+F10) and a comment, on exactly those letters', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await setCaret(page, true);
  const glyphs = await glyphsOf(page, 0);
  const tokens = await markTokens(page);
  // "performing models also connect the encoder and decoder ..." is line 3 of the abstract; three words of it
  const base = (await findOnPage(page, 0, 'models also connect the encoder')).start;
  const WORDS = [
    { word: 'models', at: base },
    { word: 'connect', at: base + 12 },
    { word: 'encoder', at: base + 24 },
  ] as const;
  for (const w of WORDS) expect(await rangeText(page, 0, w.at, w.at + w.word.length), `precondition: chars ${w.at}.. are "${w.word}"`).toBe(w.word);
  const as = (w: (typeof WORDS)[number]): Selected => ({ fx: ATTENTION, a: w.at, b: w.at + w.word.length - 1, text: w.word, ranges: [] });
  // Triage (caret): the text cursor stays drawn just after the marked word, inside its box, so the colour share is read on
  // all its letters but the last (the threshold is unchanged).
  const colourOf = (w: (typeof WORDS)[number]): Selected => ({ ...as(w), b: w.at + w.word.length - 2, text: w.word.slice(0, -1) });

  /** Puts the cursor in front of the word and selects it with Shift+Right. */
  const selectByKeys = async (w: (typeof WORDS)[number]): Promise<void> => {
    await clickAt(page, 0, glyphs[w.at]);
    await press(page, 'Shift+ArrowRight', w.word.length);
    expect(await selected(page), `${w.word.length} Shift+Rights select "${w.word}"`).toEqual([{ pageIndex: 0, start: w.at, end: w.at + w.word.length }]);
  };
  /** The words next to it, two to four letters away on either side, are untouched. */
  const neighboursPlain = async (w: (typeof WORDS)[number], shot: Awaited<ReturnType<typeof paintOfSelection>>['shot']): Promise<void> => {
    for (const [from, to] of [[w.at - 4, w.at - 2], [w.at + w.word.length + 2, w.at + w.word.length + 4]]) {
      const p = paintOf(shot, await lineBoxes(page, { fx: ATTENTION, a: from, b: to }));
      expect(p.neutral, `chars ${from} to ${to}, just beside "${w.word}", are not marked`).toBeGreaterThanOrEqual(0.97);
    }
  };

  // 1. the mark key
  await selectByKeys(WORDS[0]);
  await snap(page, testInfo, '1a-keyboard-selection');
  await page.keyboard.press('h');
  await answerSavePrompt(page, 'Yes', 600);
  const hl = await paintOfSelection(page, colourOf(WORDS[0]), { name: '1a-highlight-by-keys', testInfo });
  expect(hl.paint.share(tokens.fill[0]), 'H highlights "models" in yellow, the default colour').toBeGreaterThanOrEqual(0.6);
  expect(await selected(page), 'a mark lets go of the selection, so it shows in its true colour (R71)').toEqual([]);
  await neighboursPlain(WORDS[0], hl.shot);
  // GUESS (soft): the cursor is still there afterwards, at one end of the marked word, so reading can go on from it
  const after = await caretAt(page);
  expect.soft(after, 'after a mark the cursor is still somewhere').not.toBeNull();
  if (after) {
    testInfo.annotations.push({ type: 'cursor after a mark', description: `in front of char ${after.index}; the word was chars ${WORDS[0].at} to ${WORDS[0].at + 6}` });
    expect.soft(after.index >= WORDS[0].at - 1 && after.index <= WORDS[0].at + 7, `and it is at the marked word, not far from it (char ${after.index})`).toBe(true);
  }

  // 2. the mark menu from the keyboard
  await selectByKeys(WORDS[1]);
  await page.keyboard.press('Shift+F10');
  await expect(markMenu(page), 'Shift+F10 opens the mark-up menu on a keyboard selection').toBeVisible({ timeout: 3_000 });
  await snap(page, testInfo, '1a-mark-menu-on-keyboard-selection');
  await swatch(page, 'green').click();
  await expect(markMenu(page), 'choosing a colour closes the menu').toBeHidden();
  const green = await paintOfSelection(page, colourOf(WORDS[1]), { name: '1a-green-by-menu', testInfo });
  expect(green.paint.share(tokens.fill[1]), 'the menu marks "connect" green').toBeGreaterThanOrEqual(0.6);
  await neighboursPlain(WORDS[1], green.shot);

  // 3. a comment
  await selectByKeys(WORDS[2]);
  await startNote(page);
  await page.keyboard.type('Why this encoder?', { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, 'Why this encoder?'), 'Ctrl+Alt+M opens a note on a keyboard selection, and Enter posts it').toBeVisible({ timeout: 5_000 });
  await snap(page, testInfo, '1a-comment-on-keyboard-selection');

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    const stored = await waitStored(page, (a) => a.marks.filter((m) => m.deletedAt === null).length === 2 && a.threads.some((t) => t.deletedAt === null && t.anchor.kind === 'text'), 'the two marks and the note are stored');
    const marks = stored.marks.filter((m) => m.deletedAt === null && m.style === 'highlight');
    expect(marks.map((m) => [m.anchor.quote?.quote, m.color]).sort(), 'the marks are on exactly "models" (yellow, colour 1) and "connect" (green, colour 2)').toEqual([['connect', 2], ['models', 1]]);
    const thread = stored.threads.find((t) => t.deletedAt === null && t.anchor.kind === 'text')!;
    expect(thread.anchor.quote?.quote, 'the note is on exactly "encoder"').toBe('encoder');
  }
});

test('Esc lets go of the selection and leaves the cursor at one end of it', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const line = d.cols.left[7];
  // Triage (caret): this line of the fixture has no 9-letter run after its 10th char; the search goes on down the column.
  const k = plainRun(d.glyphs, line.first + 10, d.cols.left[d.cols.left.length - 1].last, 9) + 1;
  await clickAt(d.page, 0, d.glyphs[k]);
  await press(d.page, 'Shift+ArrowRight', 5);
  expect(await selected(d.page)).toEqual([{ pageIndex: 0, start: k, end: k + 5 }]);
  await press(d.page, 'Escape');
  expect(await selected(d.page), 'Esc collapses the selection').toEqual([]);
  expect((await readSelection(d.page)).domText, 'in the browser too').toBe('');
  await snap(d.page, testInfo, '1a-after-escape');
  // GUESS: "back to the cursor" is the end the selection grew from (k), or the end it grew to (k + 5).
  const c = await whereNow(d.page, 'after Esc');
  testInfo.annotations.push({ type: 'cursor after Esc', description: c.index === k ? 'back where the selection began' : c.index === k + 5 ? 'at the end it had grown to' : `somewhere else (${c.index})` });
  expect([k, k + 5], `the cursor is at one end of what was selected (it is in front of char ${c.index}; the selection was ${k} to ${k + 5})`).toContain(c.index);
  await press(d.page, 'ArrowRight');
  const next = await whereNow(d.page, 'Right after Esc');
  expect(next.index, 'and the arrow keys carry on from there, one letter further').toBe(c.index + 1);
});

// =================================================================================================================
// Without the switch
// =================================================================================================================

test('without the switch, Shift+Right adjusts the end of a mouse selection by one letter, and Esc lets go', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO); // a new profile: the switch is off (the first test checks that on the View menu)
  const line = d.cols.left[6];
  const a = line.glyphs[3].index;
  // a visible glyph a dozen letters on, with a plain letter right after it, so one more Shift+Right takes in a letter
  const b = line.glyphs.slice(12).find((g) => /^\p{L}$/u.test(d.glyphs[g.index + 1]?.text ?? ''))!.index;
  const drag = await dragGlyphs(d.page, 0, a, b);
  expect(drag.ranges, 'the mouse selected from a to b').toEqual([inclusive(0, a, b)]);

  await press(d.page, 'Shift+ArrowRight');
  expect(await selected(d.page), 'Shift+Right extends it by one letter at its end (R93: "This works with or without the switch")').toEqual([{ pageIndex: 0, start: a, end: b + 2 }]);
  await snap(d.page, testInfo, '1a-no-switch-shift-right');
  await press(d.page, 'Shift+ArrowLeft', 2);
  expect(await selected(d.page), 'Shift+Left twice takes two letters off the same end').toEqual([{ pageIndex: 0, start: a, end: b }]);
  await press(d.page, 'Shift+ArrowDown');
  const down = await selected(d.page);
  expect(down[0].start, 'Shift+Down keeps the start').toBe(a);
  expect(linesAt(d.cols.left, down[0].end), 'and moves the end to the next line').toContain(7);
  await press(d.page, 'Escape');
  expect(await selected(d.page), 'Esc lets go of the selection').toEqual([]);

  // a selection made right to left grows at the left, the end the mouse stopped at (GUESS: the end the pointer finished on is "its end")
  await dragGlyphs(d.page, 0, b, a);
  await press(d.page, 'Shift+ArrowLeft');
  expect(await selected(d.page), 'a selection dragged right to left grows at its left end').toEqual([{ pageIndex: 0, start: a - 1, end: b + 1 }]);
});

test('without the switch the Down arrow scrolls the page as before; with it, Down moves the cursor instead', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, BOOK); // a new profile: the switch is off
  const line = d.lines[3];
  await clickAt(d.page, 0, line.glyphs[12]);
  const s0 = await rt(d.page).scrollTop();
  await press(d.page, 'ArrowDown', 3);
  const s1 = await settled(() => rt(d.page).scrollTop(), 0.5, 2_000);
  await snap(d.page, testInfo, '1a-no-switch-down-scrolls');
  expect(s1 - s0, 'Down scrolls the page 40 px a press, as it always did').toBeGreaterThanOrEqual(115);
  expect(s1 - s0).toBeLessThanOrEqual(125);
  expect(await selected(d.page), 'and selects nothing').toEqual([]);

  await press(d.page, 'Home'); // scrolls to the top, still without the switch
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  expect(await rt(d.page).scrollTop()).toBeLessThanOrEqual(2);
  await setCaret(d.page, true);
  await clickAt(d.page, 0, line.glyphs[12]);
  const t0 = await rt(d.page).scrollTop();
  await press(d.page, 'ArrowDown', 3);
  const t1 = await settled(() => rt(d.page).scrollTop(), 0.5, 2_000);
  expect(Math.abs(t1 - t0), `with the switch on, Down moves the cursor and the cursor is already in view, so the page stays (it moved ${t1 - t0} px)`).toBeLessThan(60);
  const c = await whereNow(d.page, 'three Downs');
  expect(linesAt(d.lines, c.index), 'the cursor went down three lines').toContain(6);
  await snap(d.page, testInfo, '1a-switch-on-down-moves-cursor');
});

// =================================================================================================================
// Rotated pages and two-page view
// =================================================================================================================

for (const way of [
  { name: 'the pages turned clockwise (Ctrl+])', fx: TWO, turns: ['cw'] as const, degrees: 90 },
  { name: 'the pages turned counter-clockwise (Ctrl+[)', fx: TWO, turns: ['ccw'] as const, degrees: 270 },
  { name: 'a file whose page says /Rotate 90', fx: ROTATED_FILE, turns: [] as const, degrees: 0 },
]) {
  test(`on rotated pages the cursor still follows reading order: ${way.name}`, async ({ openViewer, server }, testInfo) => {
    const d = await open(openViewer, server, way.fx, { viewport: TURN_WINDOW });
    await setCaret(d.page, true);
    for (const dir of way.turns) await turn(d.page, dir);
    if (way.degrees !== 0) expect((await view(d.page)).viewRotation, `the view is turned ${way.degrees} degrees`).toBe(way.degrees);
    const line = d.cols.left[5];
    const k = plainRun(d.glyphs, line.first + 12, line.last - 6, 3) + 1;
    const x0 = xBefore(d.glyphs, k);
    await waitGlyph(d.page, 0, k);
    await clickAt(d.page, 0, d.glyphs[k]);
    await expectCaretAt(d.page, 0, k, 'a click on the turned page puts the cursor between the letters it hit');
    await snap(d.page, testInfo, `1a-rotated-${way.degrees}-caret`);

    await press(d.page, 'ArrowRight', 3);
    await expectCaretAt(d.page, 0, k + 3, 'Right moves one letter further along the line, in reading order');
    await press(d.page, 'ArrowLeft', 3);
    await expectCaretAt(d.page, 0, k, 'and Left moves back');

    await press(d.page, 'ArrowDown');
    const down = await whereNow(d.page, 'Down');
    expect(linesAt(d.cols.left, down.index), 'Down moves to the next line of the text').toContain(6);
    expect(Math.abs(xBefore(d.glyphs, down.index) - x0), 'at about the same place along it').toBeLessThanOrEqual(SAME_PLACE);
    await press(d.page, 'ArrowUp');
    await expectCaretAt(d.page, 0, k, 'Up comes back to the same place');

    await press(d.page, 'Home');
    await press(d.page, 'Shift+End');
    expect(trimmed(d.glyphs, (await selected(d.page))[0]), 'Home and Shift+End select the line').toEqual([line.first, line.last + 1]);
    await snap(d.page, testInfo, `1a-rotated-${way.degrees}-line-selected`);
    await press(d.page, 'Escape');

    // the column break
    const lastIndex = d.cols.left.length - 1;
    const lastLeft = d.cols.left[lastIndex];
    await clickAt(d.page, 0, d.glyphs[lastLeft.glyphs[4].index]);
    await press(d.page, 'ArrowDown');
    const hop = await whereNow(d.page, 'Down from the last line of column 1');
    expect(linesAt(d.cols.all, hop.index), 'Down from the last line of the first column goes to the first line of the second').toContain(lastIndex + 1);
    expect(xBefore(d.glyphs, hop.index), 'in the second column').toBeGreaterThan(300);
  });
}

test('in two-page view Down from the last line of one page goes to the first line of the next', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, BOOK, { viewport: PAIR_WINDOW });
  await chooseView(d.page, ROWS.two);
  await settleView(d.page);
  expect((await view(d.page)).twoPage, 'two-page view is on').toBe(true);
  await setCaret(d.page, true);
  await waitForTextLayer(d.page, 1);
  const L = d.lines.length - 1;
  const last = d.lines[L];
  await clickAt(d.page, 0, d.glyphs[plainRun(d.glyphs, d.lines[L - 1].first + 20, d.lines[L - 1].last, 3)]);
  await press(d.page, 'ArrowDown');
  expect(linesAt(d.lines, (await whereNow(d.page, 'Down to the last line')).index), 'Down goes to the last line of the page').toContain(L);
  await press(d.page, 'ArrowDown');
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  const second = await glyphsOf(d.page, 1);
  const c = await whereNow(d.page, 'Down from the last line of page 1');
  await snap(d.page, testInfo, '1a-two-page-down');
  expect(c.pageIndex, 'Down from the last line of page 1 goes to page 2, whichever way the two pages sit on the screen').toBe(1);
  expect(c.index, 'to its first line').toBeLessThanOrEqual(second.findIndex((g) => g.generated));
  expect(await inView(d.page, 1, second, c.index), 'and it is on screen').toBe(true);

  await press(d.page, 'ArrowUp');
  const back = await whereNow(d.page, 'Up from the first line of page 2');
  expect(back.pageIndex, 'Up from the first line of page 2 goes back to page 1').toBe(0);
  expect(linesAt(d.lines, back.index), 'to its last line').toContain(L);

  await clickAt(d.page, 0, last.glyphs[10]);
  await press(d.page, 'End');
  await press(d.page, 'ArrowRight', 2);
  const over = await whereNow(d.page, 'End, then Right twice');
  expect(over.pageIndex, 'Right past the end of page 1 goes on to page 2').toBe(1);
});

// =================================================================================================================
// Find
// =================================================================================================================

for (const hit of [
  { steps: 1, count: 2, pageIndex: 3, which: 1, what: 'the second hit, on the same page' },
  { steps: 2, count: 3, pageIndex: 36, which: 0, what: 'the third hit, on page 37' },
]) {
  test(`Find: Enter on ${hit.what} puts the cursor at the hit`, async ({ openViewer, server }, testInfo) => {
    const page = await openViewer(server.url(PAPER_URL));
    await waitReady(page);
    await setCaret(page, true);
    await openFind(page);
    await fillQuery(page, 'disincentive');
    await expectCount(page, 1, 7, 'typed');
    for (let n = 1; n <= hit.steps; n++) await page.keyboard.press('Enter');
    await expectCount(page, hit.count, 7, `Enter x${hit.steps}`);
    await settled(() => rt(page).scrollTop(), 1, 4_000);
    await snap(page, testInfo, `1a-find-hit-${hit.count}`);
    await page.keyboard.press('Escape');
    await expect(field(page), 'Esc closes the find bar').toBeHidden();
    await waitForTextLayer(page, hit.pageIndex);
    const hits = await th(page).eval((h, a) => h.backend.searchPage(h.doc()!.open.doc, a.i, 'disincentive', { matchCase: false, wholeWord: false }), { i: hit.pageIndex });
    const want = hits[hit.which];
    const c = await whereNow(page, `after Enter on hit ${hit.count}`);
    expect(c.pageIndex, `the cursor is on page ${hit.pageIndex + 1}, where the hit is`).toBe(hit.pageIndex);
    // GUESS: "at the hit" is the start of the word, or the end of it.
    expect(c.index, `the cursor is at the hit (chars ${want.start} to ${want.start + want.count}); it is in front of char ${c.index}`).toBeGreaterThanOrEqual(want.start);
    expect(c.index).toBeLessThanOrEqual(want.start + want.count);
    await snap(page, testInfo, `1a-find-hit-${hit.count}-cursor`);
  });
}

// =================================================================================================================
// Scanned pages
// =================================================================================================================

test('on a scanned PDF there is no cursor, and a quiet note says why, once for the tab', async ({ openViewer, server, context }, testInfo) => {
  await watchScanNotes(context);
  const page = await openViewer(server.url(SCAN_URL));
  await waitReady(page);
  expect((await noteSeen(page)).now, 'precondition: nothing about a scan is on the page before the switch is on').toBe(false);
  await setCaret(page, true);

  const area = await scrollerRect(page);
  const spot = { x: area.x + area.width / 2, y: area.y + 300 };
  const clip = { x: Math.round(spot.x) - 20, y: Math.round(spot.y) - 20, width: 40, height: 40 };
  const before = await grabClip(page, clip);
  await page.mouse.click(spot.x, spot.y);
  await page.mouse.move(8, 600);
  const pictures = await sampleClip(page, clip, 10, 120);
  expect(pictures.some((p) => caretBand(p, before, clip).present), 'a click in a scanned picture draws no cursor').toBe(false);
  await press(page, 'ArrowRight');
  expect(await caretAt(page), 'there is no text, so no key selects anything: no cursor').toBeNull();

  await expect.poll(async () => (await noteSeen(page)).shown, { message: 'a quiet note says the page is a scan', timeout: 8_000, intervals: [100, 200, 400] }).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole('dialog'), 'the note is quiet: it is not a dialog').toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await snap(page, testInfo, '1a-scan-note');
  expect((await noteSeen(page)).shown, 'the note came once').toBe(1);

  // more of the same on this tab: another page, another click, off and on again
  await rt(page).scrollToPage(1);
  await page.mouse.click(spot.x, spot.y);
  await press(page, 'ArrowRight');
  await press(page, 'ArrowDown');
  await setCaret(page, false);
  await setCaret(page, true);
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(2_500);
  expect((await noteSeen(page)).shown, 'once per tab: nothing more is said on this tab').toBe(1);

  // another tab says it for itself
  const other = await openViewer(server.url(SCAN_URL));
  await waitReady(other);
  await other.bringToFront();
  const area2 = await scrollerRect(other);
  await other.mouse.click(area2.x + area2.width / 2, area2.y + 300);
  await press(other, 'ArrowRight');
  await expect.poll(async () => (await noteSeen(other)).shown, { message: 'a second tab gets its own note', timeout: 8_000, intervals: [100, 200, 400] }).toBe(1);
  await other.waitForTimeout(1_500);
  expect((await noteSeen(other)).shown, 'and only one').toBe(1);
  await snap(other, testInfo, '1a-scan-note-second-tab');
});

test('a scanned page between two text pages is skipped: Down and Up go straight across it', async ({ openViewer, server, context }, testInfo) => {
  await watchScanNotes(context);
  const d = await open(openViewer, server, MIXED);
  await setCaret(d.page, true);
  const third = await glyphsOf(d.page, 2);
  expect(third.length, 'the fixture: page 3 has text').toBeGreaterThan(100);
  const lines3 = linesOf(third);
  expect(d.lines, 'the fixture: page 1 has ten lines').toHaveLength(10);
  expect((await glyphsOf(d.page, 1)).filter((g) => !g.generated).length, 'the fixture: page 2 is a picture with no text').toBe(0);

  await clickAt(d.page, 0, d.lines[9].glyphs[14]);
  await press(d.page, 'ArrowDown');
  await settled(() => rt(d.page).scrollTop(), 0.5, 3_000);
  await waitForTextLayer(d.page, 2);
  const down = await whereNow(d.page, 'Down from the last line of page 1');
  await snap(d.page, testInfo, '1a-skip-scanned-page');
  expect(down.pageIndex, 'Down from the last line of page 1 lands on page 3: the scanned page 2 has no text to stand in').toBe(2);
  expect(linesAt(lines3, down.index), 'on its first line').toContain(0);
  expect(await inView(d.page, 2, third, down.index), 'and the view followed it').toBe(true);
  await expect.poll(async () => (await noteSeen(d.page)).shown, { message: 'a quiet note says a page was skipped', timeout: 8_000, intervals: [100, 200, 400] }).toBe(1);

  await press(d.page, 'ArrowUp');
  const up = await whereNow(d.page, 'Up from the first line of page 3');
  expect(up.pageIndex, 'Up from the first line of page 3 lands on page 1').toBe(0);
  expect(linesAt(d.lines, up.index), 'on its last line').toContain(9);
  await d.page.waitForTimeout(2_000);
  expect((await noteSeen(d.page)).shown, 'the note is not said again on this tab').toBe(1);

  // Right at the end of page 1 goes the same way
  await press(d.page, 'End');
  await press(d.page, 'ArrowRight', 2);
  await waitForTextLayer(d.page, 2);
  const over = await whereNow(d.page, 'End, then Right twice');
  expect(over.pageIndex, 'Right at the end of page 1 goes to page 3').toBe(2);
});

// =================================================================================================================
// Screen reader
// =================================================================================================================

test('a screen reader hears the line the cursor moves to, through a polite live region', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  await setCaret(d.page, true);
  const first = longLines(d.cols.left, 2, d.cols.left.length, 3);
  const k = plainRun(d.glyphs, d.cols.left[first].first + 15, d.cols.left[first].last - 5, 3) + 1;
  await clickAt(d.page, 0, d.glyphs[k]);
  await startLiveLog(d.page);

  const lineText = async (n: number): Promise<string> => letters(await rangeText(d.page, 0, d.cols.left[n].first, d.cols.left[n].last + 1));
  const heard = async (n: number): Promise<{ polite: boolean; assertive: boolean }> => {
    const want = await lineText(n);
    const log = await liveLog(d.page);
    const hits = log.filter((a) => letters(a.text).includes(want.slice(0, 24)) && letters(a.text).includes(want.slice(-12)));
    return { polite: hits.some((a) => a.politeness === 'polite'), assertive: hits.some((a) => a.politeness === 'assertive') };
  };

  await press(d.page, 'ArrowDown');
  await expect.poll(async () => (await heard(first + 1)).polite, { message: 'after Down, a polite live region holds the text of the line the cursor moved to', timeout: 4_000, intervals: [100, 200, 400] }).toBe(true);
  expect((await heard(first + 1)).assertive, 'it is polite, not assertive').toBe(false);
  await snap(d.page, testInfo, '1a-live-region-down');
  await press(d.page, 'ArrowDown');
  await expect.poll(async () => (await heard(first + 2)).polite, { message: 'and again for the next line down', timeout: 4_000, intervals: [100, 200, 400] }).toBe(true);
  await press(d.page, 'ArrowUp');
  await expect.poll(async () => (await heard(first + 1)).polite, { message: 'and for the line above after Up', timeout: 4_000, intervals: [100, 200, 400] }).toBe(true);
  const log = await liveLog(d.page);
  testInfo.annotations.push({ type: 'live region text', description: JSON.stringify(log.slice(-3)) });
});

// =================================================================================================================
// Typing is safe
// =================================================================================================================

test('typing in the Find box is safe: its arrow keys move the text cursor in the box and leave the cursor in the page where it was', async ({ openViewer, server }, testInfo) => {
  const d = await open(openViewer, server, TWO);
  const key = await caretShortcut(d.page);
  await setCaret(d.page, true);
  const line = d.cols.left[4];
  const k = plainRun(d.glyphs, line.first + 10, line.last, 5) + 1;
  await clickAt(d.page, 0, d.glyphs[k]);
  await openFind(d.page);
  await d.page.keyboard.type('zzzz'); // a word that is not in the paper, so Find moves nothing
  const where = () => field(d.page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
  expect(await where(), 'the box holds a text cursor after what was typed').toEqual([4, 4]);
  await d.page.keyboard.press('ArrowLeft');
  expect(await where(), 'Left moves the text cursor in the box').toEqual([3, 3]);
  await d.page.keyboard.press('Home');
  expect(await where(), 'Home goes to the start of the box').toEqual([0, 0]);
  await d.page.keyboard.press('Shift+End');
  expect(await where(), 'Shift+End selects to the end of the box').toEqual([0, 4]);
  await d.page.keyboard.press('Control+ArrowLeft');
  if (yieldsToTyping(key.labels[0])) {
    // "Single-key and Ctrl+Alt shortcuts never fire while you are typing": the switch's own key is one of them (unless it uses Ctrl alone)
    await d.page.keyboard.press(key.press);
    await frames(d.page, 3);
  } else testInfo.annotations.push({ type: 'switch key', description: `${key.labels[0]} is a Ctrl shortcut: Ctrl shortcuts may run while typing, so it was not pressed in the Find box` });
  await snap(d.page, testInfo, '1a-typing-in-find');
  await d.page.keyboard.press('Escape');
  await expect(field(d.page)).toBeHidden();
  if (yieldsToTyping(key.labels[0])) expect(await caretTicked(d.page), `${key.labels[0]} did nothing in the Find box: the switch is still on`).toBe(true);
  await clickAt(d.page, 0, d.glyphs[k]);
  expect(await selected(d.page), 'nothing was selected in the page').toEqual([]);
  await expectCaretAt(d.page, 0, k, 'and the cursor in the page did not move');
});
