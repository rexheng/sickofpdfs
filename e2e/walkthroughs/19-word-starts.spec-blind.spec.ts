// Walkthrough 19, "Bold word starts" (ruling R90, owner request of Nov 2). Gate 1, written from the spec only (R90, the shortcut table and its "while you are
// typing" rule, ruling R78 on print, the speed budgets) and from the harness the other walkthroughs use. Nothing here was written against the code.
//
// R90, as the checks below read it:
//   "In every word, the first letters are drawn bold, and the rest stay as printed. Words of 1 to 3 letters get their first letter bold. Longer words get their
//    first half bold, rounded up. Only letters count. Pure numbers, maths symbols and punctuation are left alone. Each part of a hyphenated word counts as its own
//    word. A word broken across lines counts per line."
//   "It is drawn over the page's render and never changes the file. Selecting, copying, Find, links, marks and comments work exactly as without it. The owner's own
//    bold marks still show whole words bold. It turns with the page (rotation) and works in two-page view and presentation mode. It never prints."
//   "Pages without real text outlines (scans, and OCR text) are left as they are. The first time such a page is shown with the switch on, a quiet note says:
//    'Bold word starts works on text pages. This page is a scanned image.'"
//   "It sits in the View menu as 'Bold word starts', with a check mark, and has a keyboard shortcut that clashes with nothing in Chrome or the viewer. It is listed in
//    the shortcut sheet. It is remembered on this computer for every PDF, and is off until the owner turns it on."
//   "Turning it on shows bold on the visible pages within 300 ms on the reference laptop." / "never delays the first paint or scrolling".
//
// HOW BOLD IS DETECTED FROM THE OUTSIDE (support/word-starts.spec-blind.ts has the long account). The feature draws a heavier stroke along each glyph's outline, so a
// bold letter holds more ink than the same letter plain. For every letter of a passage the test takes the ink in a box round the letter's ink box (the text layer's
// own geometry from the engine) in three pictures of the same window: OFF (switch off), FULL (switch off, the owner's own bold mark over the whole passage: the
// yardstick, because it already carries each letter's shape and its neighbours) and ON (switch on). A letter is "drawn bold" when its ON gain is at least half its FULL
// gain. The words come from the engine's text by R90's rule, never from the product. The measuring was checked against a stand-in overlay drawn in the page at 0.03,
// 0.04 and 0.06 em of stroke at 100%, 150% and 200%: every one of 939 letters was classed right, the lightest bold letter at 80% of the yardstick and the heaviest plain letter at 21%.
//
// GUESSES (the spec leaves these open; each is also in the report):
//  G1  The row is a `menuitemcheckbox` named "Bold word starts" in the View menu (as "Two-page view" is), with `aria-checked`.
//  G2  The shortcut is whatever the shortcut sheet prints next to "Bold word starts" in a <kbd> (the spec names none). It is read from the sheet and pressed as printed.
//      "Clashes with nothing" is judged against the other rows of the sheet and a list of Chrome's own keys (support/word-starts.spec-blind.ts, CHROME_KEYS).
//  G3  The rule is applied as R90 WRITES it (1 to 3 letters: 1; longer: the first half rounded up). R90's three examples ("Rea·ding", "meth·od") do not all follow it:
//      "Reading" has 7 letters, so the rule bolds 4 ("Read·ing"); "method" has 6, so 3 ("met·hod"). The test follows the rule, not the examples.
//  G4  A word with a ligature ("significantly": the engine has one glyph for "fi"), letters mixed with digits, and accented letters are not judged: R90 does not say.
//  G5  "A quiet note" is a piece of text anywhere in the viewer, with exactly the spec's words; quiet means it is in no dialog or alert dialog and does not take the
//      keyboard focus. Whether it goes away by itself is not tested. "Once per tab" is counted by a watcher in the page that sees the words come on to the page.
//  G6  A scan with recognised text (render mode 3) counts as "OCR text": nothing bold. Whether it shows the note (when it is the first such page) is not asserted.
//  G7  "Within 300 ms" is read from the frames the browser puts on the screen (the screencast), from the click on the View-menu row to the first frame with the bold on
//      it. A frame lags the page by about 80 to 150 ms here (measured against the owner's bold mark: 117 ms in the page, 197 to 274 ms in the frame), so the frame bound is
//      the budget plus 120 ms. If the bold is made of drawing (SVG) the page's own DOM clock is held to the budget as it stands.
//  G8  "Print" is judged three ways: the pictures in the print copy at the moment the viewer asks the browser to print, and the sheets of the PDF the browser would print
//      (with marks and without), each compared with the same print made with the switch off.
//  G9  "The existing perf budgets" are the spec's: no blank page over 150 ms while scrolling a 400-page book, and the first page of a 50-page paper in under 1 s.
//      Both are the spec's number with SOP_PERF_STRICT=1 and three times that without.
import type { Page } from '@playwright/test';
import { budgetMs, budgetNote } from '../support/perf-budget';
import { changed, shareOf } from '../support/rings.spec-blind';
import { expect, test } from '../support/test';
import { copyProblems } from '../support/tl-copy.spec-blind';
import {
  VIEW_100,
  copySelection,
  dragGlyphs,
  findOnPage,
  fixture,
  glyphsOf,
  inclusive,
  judgePainting,
  openClipboardReader,
  openFixture,
  rangeText,
  waitForTextLayer,
  clearSelection as clearTextSelection,
  VIEW_200,
} from '../support/tl-blind.spec-blind';
import { overWhite } from '../support/tl-paint.spec-blind';
import { BOOK_PAGES, FIXTURES, REAL, ensureBook, served as bookServed } from './support/fixtures.spec-blind';
import { expectTotal, field, fillQuery, findTokens, openFind, paint, readBar } from './support/find.spec-blind';
import {
  ATTENTION,
  LINES,
  annotations,
  answerSavePrompt,
  cardWith,
  clearSelection,
  highlightFromMenu,
  lineBoxes,
  markTokens,
  note,
  openPaper,
  paintOf,
  paintOfSelection,
  postNote,
  reloadAndWait,
  selectPassage,
  settle,
  waitSaved,
  waitStored,
  RESNET,
  PLOS,
  type Passage,
  type TlFixture,
} from './support/marks.spec-blind';
import { printLog, useRecordingPrint } from './support/nav.spec-blind';
import {
  PAIR_WINDOW,
  ROWS,
  TURN_WINDOW,
  chooseView,
  openPrintout,
  printNow,
  printedPdf,
  settleView,
  sheetOf,
  sheetSizes,
  startPresentation,
  turn,
  view,
  waitGlyph,
  waitNotFullscreen,
} from './support/views.spec-blind';
import { expect as expectViewer, probe, rt, snap, test as probed, waitForFirstPage, waitForPageOnScreen, waitReady, type BlankReport } from './support/viewer.spec-blind';
import {
  CHROME_KEYS,
  MIXED_FILE,
  SCAN_NOTE,
  SOMETHING_DRAWN,
  changedShare,
  charRange,
  coverageGaps,
  describeModel,
  describeVerdict,
  drawnShare,
  ensureMixedScan,
  expectRule,
  installDomTimer,
  isOn,
  judge,
  look,
  noteWatch,
  openSheet,
  pageBox,
  paintLatency,
  pressable,
  readDomTimer,
  rowCentre,
  runRule,
  setSwitch,
  sheetHashes,
  sheetKeys,
  stableShot,
  switchState,
  toggleFromMenu,
  useNoteWatch,
  useSheetHasher,
  type Verdict,
} from './support/word-starts.spec-blind';
import type { Box } from '../support/tl-paint.spec-blind';

test.setTimeout(240_000);
probed.setTimeout(240_000);

// ---------------------------------------------------------------------------------------------------------------
// What is read

/** Page 2 of "Attention Is All You Need": "... sequence modeling and transduc-" at the end of a line, "tion models ..." at the start of the next. */
const ATTENTION_P2: TlFixture = { ...ATTENTION, name: 'attention-p2', page: 1 };
/** The whole 15-line abstract (page 1): words of 1 to 14 letters, five numbers, hyphens, "English-" at a line end. */
const ABSTRACT: Passage = { from: 'The dominant sequence transduction models', to: 'limited training data.' };
/** Lines 7 to 11 of the abstract: numbers (28.4, 2014, 2, 41.8), "English-", "to-German", "single-model state-of-the-art". */
const MID: Passage = { from: LINES.l7.from, to: LINES.l11.to };
/** Two lines of page 2 with a word broken across them. */
const BROKEN: Passage = { from: 'Attention mechanisms have become', to: 'regard to their distance' };
/** Four pages: 1 and 4 are text (pages 1 and 2 of the paper), 2 is a scan, 3 is a scan with invisible recognised text. */
const MIXED: TlFixture = { name: 'mixed-scan', file: `walkthroughs/${MIXED_FILE}`, page: 0, dir: 'ltr' };
const SCAN_120 = '/f/scan-120.pdf';

const unionOf = (boxes: Box[]): Box => ({ left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)), top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) });
const grown = (b: Box, by: number): Box => ({ left: b.left - by, right: b.right + by, top: b.top - by, bottom: b.bottom + by });

/** Passes the verdict on to the report as a note. */
const record = (testInfo: Parameters<typeof note>[0], label: string, v: Verdict): void => note(testInfo, `19 ${label}`, describeVerdict(v));

test.beforeAll(async () => {
  await ensureMixedScan();
  await ensureBook();
});

// =================================================================================================================
// Turning it on and off
// =================================================================================================================

test('View has "Bold word starts" as a row with a check mark, off at first; turning it on draws bold starts on the page, turning it off puts the page back exactly as it was', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const state = await switchState(page);
  expect(state.present, 'View has a row named "Bold word starts"').toBe(true);
  expect(state.role, 'a row with a check mark is a check-box menu item (as "Two-page view" is)').toBe('menuitemcheckbox');
  expect(state.checked, 'it is off until the owner turns it on: the row says it is not ticked').toBe('false');
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await snap(page, testInfo, '19-view-menu-off');
  await page.keyboard.press('Escape');

  const before = await look(page, 0, '19-page-before', testInfo);
  await toggleFromMenu(page);
  await expect.poll(() => isOn(page), { message: 'View shows the check mark after the row is chosen', timeout: 6_000 }).toBe(true);
  const on = await look(page, 0, '19-page-with-bold-starts', testInfo);
  expect(changedShare(before.shot, on.shot, before.page), 'the page shows bold starts: a visible share of its pixels changed').toBeGreaterThan(SOMETHING_DRAWN);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await snap(page, testInfo, '19-view-menu-on');
  await page.keyboard.press('Escape');

  await toggleFromMenu(page);
  await expect.poll(() => isOn(page), { message: 'the check mark goes when the row is chosen again', timeout: 6_000 }).toBe(false);
  const after = await look(page, 0, '19-page-after', testInfo);
  expect(changedShare(before.shot, after.shot, before.page), 'with it off again the page is exactly as before (no leftover bold, no leftover layer)').toBeLessThan(0.00005);
});

test('turning it on shows bold on the visible page within 300 ms', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const { a, b } = await charRange(page, ATTENTION, ABSTRACT);
  const region = unionOf(await lineBoxes(page, { fx: ATTENTION, a, b }));
  await installDomTimer(page);
  const FRAME_LAG_MS = 120; // G7: what a frame of the screencast lags the page's own drawing
  const tries: { frame: number | null; dom: number | null }[] = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      await setSwitch(page, false);
      await settle(page, 700);
    }
    const c = await rowCentre(page); // View is open and the row is under the pointer's way
    const menu = await page.getByRole('menu').boundingBox();
    const r = await paintLatency(page, region, () => page.mouse.click(c.x, c.y), menu === null ? {} : { exclude: { left: menu.x, top: menu.y, right: menu.x + menu.width, bottom: menu.y + menu.height } });
    tries.push({ frame: r.ms, dom: await readDomTimer(page) });
    await settle(page, 500);
  }
  note(testInfo, '19 bold on the screen, ms after the click (3 tries; the first is cold)', tries.map((t) => (t.frame === null ? 'never' : t.frame.toFixed(0))).join(', '));
  note(testInfo, '19 drawing added to the page, ms after the click (3 tries)', tries.map((t) => (t.dom === null ? 'no drawing seen' : t.dom.toFixed(0))).join(', '));
  await snap(page, testInfo, '19-after-latency-tries');
  for (const [i, t] of tries.entries()) expect(t.frame, `try ${i + 1}: a frame with bold starts reached the screen`).not.toBeNull();
  const bound = budgetMs(300) + FRAME_LAG_MS;
  expect(tries[0].frame!, `the first (cold) turn-on reached the screen in ${tries[0].frame!.toFixed(0)} ms; the bound is ${bound} ms (${budgetNote(300)}, plus the frame's lag)`).toBeLessThanOrEqual(bound);
  const frames = tries.map((t) => t.frame!).sort((p, q) => p - q);
  expect(frames[1], `the median turn-on reached the screen within ${bound} ms`).toBeLessThanOrEqual(bound);
  for (const [i, t] of tries.entries()) if (t.dom !== null) expect.soft(t.dom, `try ${i + 1}: the drawing was in the page within ${budgetMs(300)} ms of the click (${budgetNote(300)})`).toBeLessThanOrEqual(budgetMs(300));
});

// =================================================================================================================
// The rule
// =================================================================================================================

test('the rule on the whole abstract of Attention (15 lines, 200%): 1 to 3 letters bold the first, longer words the first half rounded up, numbers and hyphens left alone', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: VIEW_200, scale: 2 });
  const run = await runRule(page, ATTENTION, ABSTRACT, { label: 'abstract', testInfo });
  const v = run.verdict;
  record(testInfo, 'abstract', v);
  note(testInfo, '19 the abstract holds', describeModel(v.model));
  expect(coverageGaps(v.model), `the abstract is a fair test of the rule (${describeModel(v.model)})`).toEqual([]);
  expectRule(v, 'the abstract at 200%', 700);
});

test('a word broken across two lines counts per line: "transduc-" and "tion" are two words, each with its own bold start', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION_P2, { viewport: VIEW_200, scale: 2 });
  const run = await runRule(page, ATTENTION_P2, BROKEN, { label: 'broken-word', testInfo });
  const v = run.verdict;
  record(testInfo, 'broken word', v);
  expect(v.model.list, 'the two lines hold the broken word: "transduc" ends the first and "tion" starts the second').toEqual(expect.arrayContaining(['transduc', 'tion']));
  // 8 letters: "tran" bold; 4 letters: "ti" bold. Both judged on their own.
  const mine = v.model.wants.filter((w) => w.word === 'transduc' || w.word === 'tion');
  expect(mine.filter((w) => w.want === 'bold').map((w) => w.ch).join(''), 'by the rule: "tran" and "ti"').toBe('tranti');
  expectRule(v, 'the lines with a broken word', 100);
});

test('at 100%, where the owner reads, the bold starts already read as clearly bold, and at least as heavy as the owner\'s own bold mark', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const run = await runRule(page, ATTENTION, MID, { label: 'mid-100', testInfo });
  const v = run.verdict;
  record(testInfo, 'mid lines at 100%', v);
  expectRule(v, 'lines 7 to 11 at 100%', 200);
  expect.soft(v.strokeRatio, `R90 says the stroke is heavier than the bold mark's, so a bold start holds at least as much extra ink (${describeVerdict(v)})`).toBeGreaterThanOrEqual(0.9);
  expect.soft(v.worstBold, 'and the lightest bold letter is still plainly bold').toBeGreaterThanOrEqual(0.5);
});

// =================================================================================================================
// Remembered
// =================================================================================================================

test('the switch is remembered: a second PDF opens with bold starts already on, and so does a reload; off is remembered too', async ({ openViewer, server }, testInfo) => {
  const a = await openPaper(openViewer, server, ATTENTION);
  expect(await isOn(a), 'a fresh browser has it off').toBe(false);
  await setSwitch(a, true);

  const b = await openPaper(openViewer, server, RESNET);
  await expect.poll(() => isOn(b), { message: 'a second PDF opens with the switch on (remembered for every PDF)', timeout: 8_000 }).toBe(true);
  expect(await drawnShare(b, RESNET.page, { name: '19-second-pdf', testInfo }), 'and its page shows bold starts').toBeGreaterThan(SOMETHING_DRAWN);

  await reloadAndWait(b, RESNET);
  await expect.poll(() => isOn(b), { message: 'after a reload the switch is still on', timeout: 8_000 }).toBe(true);
  expect(await drawnShare(b, RESNET.page, { name: '19-after-reload', testInfo }), 'and the reloaded page shows bold starts').toBeGreaterThan(SOMETHING_DRAWN);

  await setSwitch(b, false);
  const c = await openPaper(openViewer, server, PLOS);
  await expect.poll(() => isOn(c), { message: 'turned off, a third PDF opens with it off', timeout: 8_000 }).toBe(false);
  await snap(c, testInfo, '19-third-pdf-off');
});

test('turning it on in one tab updates the other open viewer tab; turning it off there updates the first', async ({ openViewer, server }, testInfo) => {
  const a = await openPaper(openViewer, server, ATTENTION);
  const baseA = await look(a, 0);
  const b = await openPaper(openViewer, server, ATTENTION);
  await b.bringToFront();
  const baseB = await look(b, 0);
  expect(await isOn(b), 'both tabs start with it off').toBe(false);

  await a.bringToFront();
  await setSwitch(a, true);
  await b.bringToFront(); // a tab behind the front one does not repaint; the check is of what tab B shows now, with no reload
  await expect.poll(() => isOn(b), { message: 'tab B was not reloaded, yet its View menu now shows the check mark', timeout: 10_000 }).toBe(true);
  await expect
    .poll(async () => changedShare(baseB.shot, (await stableShot(b)), baseB.page), { message: 'and its page shows bold starts', timeout: 10_000, intervals: [250, 500, 1000] })
    .toBeGreaterThan(SOMETHING_DRAWN);
  await snap(b, testInfo, '19-tab-b-follows');

  await setSwitch(b, false);
  await a.bringToFront();
  await expect.poll(() => isOn(a), { message: 'turned off in tab B, tab A follows', timeout: 10_000 }).toBe(false);
  await expect
    .poll(async () => changedShare(baseA.shot, await stableShot(a), baseA.page), { message: 'and its page is exactly as it was before', timeout: 10_000, intervals: [250, 500, 1000] })
    .toBeLessThan(0.00005);
});

// =================================================================================================================
// Nothing else changes
// =================================================================================================================

test('selecting and copying work exactly as without it: the same chars, the same copied text, the same selection painting', async ({ context, openViewer, server }, testInfo) => {
  const reader = await openClipboardReader(context, server);
  const o = await openFixture(openViewer, server, fixture('attention-p1'), { viewport: VIEW_100 });
  const { page, pageIndex } = o;
  const glyphs = await glyphsOf(page, pageIndex);
  const first = await findOnPage(page, pageIndex, ABSTRACT.from);
  const last = await findOnPage(page, pageIndex, ABSTRACT.to);
  const a = first.start;
  const b = last.start + last.count - 1;

  const pass = async (name: string) => {
    const { ranges } = await dragGlyphs(page, pageIndex, a, b);
    const painting = await judgePainting(page, testInfo, pageIndex, `19-select-${name}.png`);
    const copied = await copySelection(page, reader);
    await clearTextSelection(page);
    return { ranges, painting, copied };
  };
  await setSwitch(page, false);
  const off = await pass('off');
  await setSwitch(page, true);
  const on = await pass('on');

  expect(on.ranges, 'with it on, a drag from the first glyph to the last selects exactly the same chars (both ends included)').toEqual([inclusive(pageIndex, a, b)]);
  expect(on.ranges).toEqual(off.ranges);
  expect(on.copied, 'Ctrl+C put text on the clipboard').not.toBe('');
  expect(on.copied, 'the copied text is the same with it on as with it off (no letter doubled, none missing)').toBe(off.copied);
  expect(copyProblems(glyphs, a, b + 1, on.copied), `the copied text is the engine's text for the range:\n${on.copied}`).toEqual([]);
  expect(on.copied.replace(/\s+/g, ' ')).toContain((await rangeText(page, pageIndex, a, a + 20)).replace(/\s+/g, ' ').trim().slice(0, 15));
  expect(on.painting.problems, 'the selection is painted as R44 asks, with it on').toEqual([]);
  expect(on.painting.lines.length, 'the same number of selected lines').toBe(off.painting.lines.length);
  on.painting.lines.forEach((l, i) => expect.soft(Math.abs(l.thickness - off.painting.lines[i].thickness), `line ${i + 1} of the selection is as thick as without it`).toBeLessThanOrEqual(0.75));
  expect.soft(on.painting.doubleBlendPixels, 'no pixels of the selection painted twice, as without it').toBeLessThanOrEqual(off.painting.doubleBlendPixels + 4);
  expect.soft(on.painting.dominant, 'the selection has the same colour').toEqual(off.painting.dominant);
});

test('Find still counts and highlights its hits, in the same places, with it on', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const find = async () => {
    await openFind(page);
    await fillQuery(page, 'attention');
    await expect.poll(async () => (await paint(page)).current.length, { message: 'the current hit is painted', timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await readBar(page)).count?.total ?? null, { message: 'the bar counts the hits', timeout: 10_000 }).not.toBeNull();
    await settle(page, 600);
    const total = (await readBar(page)).count?.total ?? null;
    const hits = await paint(page);
    return { total, hits };
  };
  await setSwitch(page, false);
  const off = await find();
  await page.keyboard.press('Escape');
  await setSwitch(page, true);
  const on = await find();
  await snap(page, testInfo, '19-find-with-bold-starts');

  expect(off.total, 'the bar counts the hits with it off').toBeGreaterThan(2);
  expect(on.total, 'with it on the bar counts the same number of hits').toBe(off.total);
  await expectTotal(page, off.total!, 'with it on');
  const place = (r: { x: number; y: number; width: number; height: number }) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`;
  const rects = (h: typeof on.hits) => [...h.current, ...h.others].map(place).sort();
  expect(rects(on.hits), 'every hit is painted in the same place (the same rectangles)').toEqual(rects(off.hits));

  // The paint can be seen on the screen, over the bold starts: the current hit's colour is on its words.
  const tokens = await findTokens(page);
  expect(tokens.current, 'the page has the --find-current token').not.toBeNull();
  const colour = overWhite(tokens.current!);
  const shotNow = await stableShot(page);
  const box = on.hits.current[0];
  const p = paintOf(shotNow, [{ left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height }]);
  expect(p.share([Math.round(colour[0]), Math.round(colour[1]), Math.round(colour[2])], 40), 'the current hit is painted over its words on the screen').toBeGreaterThan(0.3);
  await expect(field(page), 'the search box still has what was typed').toHaveValue('attention');
});

test('a highlight made from the right-click menu and a comment can be made with it on, and are still there after a reload (which also keeps it on)', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await setSwitch(page, true);
  const tokens = await markTokens(page);
  const GREEN = 1;

  const hl = await selectPassage(page, ATTENTION, LINES.l1);
  await highlightFromMenu(page, hl, 'green');
  await answerSavePrompt(page, 'Yes', 1_500);
  await clearSelection(page);
  expect((await paintOfSelection(page, hl)).paint.share(tokens.fill[GREEN]), 'the green highlight is painted on its words, with bold starts over them').toBeGreaterThanOrEqual(0.6);

  const text = 'Written while bold word starts are on';
  const noted = await postNote(page, ATTENTION, LINES.l7, text);
  await clearSelection(page);
  await snap(page, testInfo, '19-highlight-and-comment');
  await waitSaved(page);
  const stored = await waitStored(page, (x) => x.marks.some((m) => m.style === 'highlight' && m.deletedAt === null) && x.comments.some((c) => c.body.includes(text) && c.deletedAt === null), 'the highlight and the comment are in the library');
  expect(stored.marks.filter((m) => m.style === 'highlight').length, 'one highlight').toBe(1);
  expect((await annotations(page)).comments.filter((c) => c.body.includes(text)).length, 'one comment').toBe(1);

  await reloadAndWait(page, ATTENTION);
  await expect.poll(() => isOn(page), { message: 'the switch survived the reload', timeout: 8_000 }).toBe(true);
  await expect(cardWith(page, text), 'the comment is back after the reload').toBeVisible({ timeout: 10_000 });
  expect((await paintOfSelection(page, hl)).paint.share(tokens.fill[GREEN]), 'and so is the highlight').toBeGreaterThanOrEqual(0.6);
  void noted;
});

test('the owner\'s own bold mark still makes whole words bold with it on, and keeps them bold when it is turned off', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await setSwitch(page, false);
  const { a, b } = await charRange(page, ATTENTION, LINES.l9);
  const off = await look(page, 0, '19-bold-mark-0-off', testInfo);

  await selectPassage(page, ATTENTION, LINES.l9);
  await page.keyboard.press('Control+b');
  await answerSavePrompt(page, 'Yes', 700);
  await clearSelection(page);
  const markOnly = await look(page, 0, '19-bold-mark-1-mark-only', testInfo);

  await setSwitch(page, true);
  const both = await look(page, 0, '19-bold-mark-2-mark-and-starts', testInfo);
  const glyphs = await glyphsOf(page, 0);
  // Every letter of the marked line, second halves too, is as bold as the mark alone makes it.
  const v = judge({ glyphs, a, b, map: both.map, off: off.shot, full: markOnly.shot, on: both.shot, allBold: true });
  note(testInfo, '19 bold mark with the switch on', describeVerdict(v));
  expect(v.assessed, 'enough letters of the line could be judged').toBeGreaterThanOrEqual(40);
  expect(v.mismatches.length, `every letter of the marked words is bold, not only the starts:\n  ${v.mismatches.slice(0, 8).join('\n  ')}`).toBe(0);

  await setSwitch(page, false);
  const markAgain = await look(page, 0, '19-bold-mark-3-switch-off-again', testInfo);
  expect(changedShare(markOnly.shot, markAgain.shot, markOnly.page), 'with the switch off the marked words stay bold, exactly as the mark alone made them').toBeLessThan(0.0005);

  await selectPassage(page, ATTENTION, LINES.l9);
  await page.keyboard.press('Control+b'); // takes the mark off
  await clearSelection(page);
  const gone = await look(page, 0, '19-bold-mark-4-mark-off', testInfo);
  expect(changedShare(off.shot, gone.shot, off.page), 'and without the mark the page is as it was at the start').toBeLessThan(0.0005);
});

// =================================================================================================================
// Rotation, two-page view and presentation mode
// =================================================================================================================

test('rotation: the bold starts turn with the page, and follow the same rule, upright and turned all the way round', async ({ openViewer, server }, testInfo) => {
  test.setTimeout(480_000);
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  const { a } = await charRange(page, ATTENTION, MID);
  for (const deg of [0, 90, 180, 270]) {
    if (deg > 0) {
      expect(await turn(page, 'cw'), `Ctrl+] turns the pages to ${deg} degrees`).toBe(deg);
      await waitGlyph(page, ATTENTION.page, a);
      await settle(page, 600);
    }
    const run = await runRule(page, ATTENTION, MID, { label: `turned-${deg}`, testInfo });
    record(testInfo, `turned ${deg}`, run.verdict);
    expectRule(run.verdict, `the page turned ${deg} degrees`, 150);
    await snap(page, testInfo, `19-turned-${deg}`);
  }
});

test('two-page view: both pages of a pair have bold starts by the same rule', async ({ openViewer, server }, testInfo) => {
  test.setTimeout(420_000);
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: PAIR_WINDOW });
  await chooseView(page, ROWS.two);
  await expect.poll(async () => (await view(page)).twoPage, { message: 'View → Two-page view turns it on' }).toBe(true);
  await rt(page).setScale(1);
  await settleView(page, 700);
  await waitForTextLayer(page, 0);
  await waitForTextLayer(page, 1);
  await snap(page, testInfo, '19-two-page-before');

  const left = await runRule(page, ATTENTION, MID, { label: 'pair-left', testInfo });
  record(testInfo, 'two-page, left page', left.verdict);
  expectRule(left.verdict, 'the left page of the pair', 150);
  const right = await runRule(page, ATTENTION_P2, BROKEN, { label: 'pair-right', testInfo });
  record(testInfo, 'two-page, right page', right.verdict);
  expectRule(right.verdict, 'the right page of the pair', 100);
  expect((await view(page)).twoPage, 'it was still two-page view throughout').toBe(true);
});

test('presentation mode: the page shown fullscreen has the bold starts, by the same rule', async ({ openViewer, server }, testInfo) => {
  test.setTimeout(420_000);
  const page = await openPaper(openViewer, server, ATTENTION, { viewport: TURN_WINDOW });
  // The switch cannot be reached in presentation mode (no header), so each picture goes in, looks and comes out.
  const take = async (name: string) => {
    await startPresentation(page);
    const l = await look(page, 0, name, testInfo);
    await page.keyboard.press('Escape');
    await waitNotFullscreen(page, 'Esc');
    return l;
  };
  const run = await runRule(page, ATTENTION, MID, { label: 'presentation', testInfo, take });
  record(testInfo, 'presentation mode', run.verdict);
  expectRule(run.verdict, 'the page in presentation mode', 150);
});

// =================================================================================================================
// Print
// =================================================================================================================

test('it never prints: the print copy and the printed sheets are the same with it on as with it off, with marks and without', async ({ context, openViewer, server }, testInfo) => {
  test.setTimeout(600_000);
  await useRecordingPrint(context);
  await useSheetHasher(context);
  const page = await openPaper(openViewer, server, ATTENTION);

  await setSwitch(page, false);
  const screenOff = await look(page, 0);
  await printNow(page, true);
  const offHashes = (await sheetHashes(page)).at(-1)!;
  const offPdf = await printedPdf(page);

  await setSwitch(page, true);
  await printNow(page, true);
  const onWithHashes = (await sheetHashes(page)).at(-1)!;
  const onWithPdf = await printedPdf(page);
  await printNow(page, false);
  const onWithoutHashes = (await sheetHashes(page)).at(-1)!;
  const onWithoutPdf = await printedPdf(page);
  expect((await printLog(page)).calls, 'three prints were made').toBe(3);
  const screenOn = await look(page, 0, '19-screen-on-after-printing', testInfo);
  expect(changedShare(screenOff.shot, screenOn.shot, screenOff.page), 'the screen shows bold starts (so the prints below are compared with a viewer that has them on)').toBeGreaterThan(SOMETHING_DRAWN);

  // What the print path receives: the pictures of the print copy at the moment the viewer asks the browser to print.
  expect(offHashes.sheets.length, 'the print copy holds pictures of the sheets').toBeGreaterThan(0);
  for (const [name, h] of [['with marks', onWithHashes], ['without marks', onWithoutHashes]] as const) {
    expect(h.sheets.length, `${name}: the same number of sheet pictures`).toBe(offHashes.sheets.length);
    h.sheets.forEach((s, i) => {
      expect.soft(s.hash, `${name}: sheet ${i + 1}'s picture is the picture printed with it off (no bold start in it)`).toBe(offHashes.sheets[i].hash);
      expect.soft(s.dark, `${name}: sheet ${i + 1} holds as much black as with it off`).toBe(offHashes.sheets[i].dark);
    });
  }

  // What the browser would print: sheet 1 of each PDF, seen as a page.
  // Triage (implementer, G8): the printouts are pictures only, so a viewer tab showing them with the switch on puts R90's scan note over the sheet; look with it off.
  await setSwitch(page, false);
  const size = (await sheetSizes(offPdf))[0];
  const win = { width: 1280, height: 1160 };
  expect(size.width, 'sheets are page sized').toBeGreaterThan(300);
  const outOff = await openPrintout(openViewer, server, offPdf, 'word-starts-off', win);
  const outOn = await openPrintout(openViewer, server, onWithPdf, 'word-starts-on-with-marks', win);
  const outOnPlain = await openPrintout(openViewer, server, onWithoutPdf, 'word-starts-on-without-marks', win);
  const sOff = await sheetOf(outOff, 0);
  const sOn = await sheetOf(outOn, 0);
  const sOnPlain = await sheetOf(outOnPlain, 0);
  await snap(outOff, testInfo, '19-printed-off');
  await snap(outOn, testInfo, '19-printed-on-with-marks');
  await snap(outOnPlain, testInfo, '19-printed-on-without-marks');
  for (const [name, s] of [['with marks', sOn], ['without marks', sOnPlain]] as const) {
    const different = shareOf(sOff.frame, changed(sOff.frame, s.frame), sOff.box);
    expect.soft(different, `printed ${name}, the sheet is the sheet printed with it off (no bold word starts on paper)`).toBeLessThan(0.0002);
  }
});

// =================================================================================================================
// Scanned pages
// =================================================================================================================

test('a scanned page shows nothing bold and a quiet note says why, once for this tab; another tab gets its own note', async ({ context, openViewer, server }, testInfo) => {
  await useNoteWatch(context);
  const text = await openPaper(openViewer, server, ATTENTION);
  await setSwitch(text, true);
  expect((await noteWatch(text)).appeared, 'a page of real text shows no note').toBe(0);

  const scan = await openViewer(server.url(SCAN_120));
  await waitReady(scan, 45_000);
  await expect.poll(async () => (await noteWatch(scan)).appeared, { message: `the quiet note "${SCAN_NOTE}" appears when the scanned page is first shown with the switch on`, timeout: 15_000, intervals: [100, 250, 500] }).toBe(1);
  const where = await scan.getByText(SCAN_NOTE).first().boundingBox({ timeout: 1_500 }).catch(() => null);
  await snap(scan, testInfo, '19-scan-note');
  expect((await noteWatch(scan)).loud, 'the note is quiet: not in a dialog, and it does not take the keyboard focus').toEqual([]);

  // The page itself is as the file draws it.
  await waitForTextOrPicture(scan);
  const around = (): Box[] => (where === null ? [{ left: 0, top: 0, right: 100_000, bottom: 120 }, { left: 0, top: 640, right: 100_000, bottom: 100_000 }] : [grown({ left: where.x, top: where.y, right: where.x + where.width, bottom: where.y + where.height }, 16)]);
  expect(await drawnShare(scan, 0, { except: around, name: '19-scan', testInfo }), 'a scanned page shows nothing bold: the page is the same with the switch on and off').toBeLessThan(0.0003);
  expect((await noteWatch(scan)).appeared, 'turning the switch off and on again does not bring the note back: it is once per tab').toBe(1);

  for (const i of [30, 90, 5]) {
    await rt(scan).scrollToPage(i);
    await settle(scan, 1_200);
  }
  expect((await noteWatch(scan)).appeared, 'scrolling to other scanned pages does not bring it back either').toBe(1);
  expect((await noteWatch(text)).appeared, 'the text tab never showed it').toBe(0);

  const scan2 = await openViewer(server.url(SCAN_120));
  await waitReady(scan2, 45_000);
  await expect.poll(async () => (await noteWatch(scan2)).appeared, { message: 'a second tab on a scan gets the note once for itself', timeout: 15_000 }).toBe(1);
});

test('in a file that mixes text and scanned pages, only the text pages get bold starts, and the note comes with the first scanned page, not before', async ({ context, openViewer, server }, testInfo) => {
  test.setTimeout(360_000);
  await useNoteWatch(context);
  const page = await openPaper(openViewer, server, MIXED);
  await setSwitch(page, true);
  await settle(page, 600);
  expect((await noteWatch(page)).appeared, 'page 1 is text: no note yet').toBe(0);
  expect(await drawnShare(page, 0, { name: '19-mixed-p1', testInfo }), 'page 1, a text page, has bold starts').toBeGreaterThan(SOMETHING_DRAWN);
  expect((await noteWatch(page)).appeared, 'still no note: the scan has not been shown').toBe(0);

  await rt(page).scrollToPage(1);
  await settleView(page, 900);
  await expect.poll(async () => (await noteWatch(page)).appeared, { message: 'the note comes when the scanned page is shown', timeout: 15_000 }).toBe(1);
  const where = await page.getByText(SCAN_NOTE).first().boundingBox({ timeout: 1_500 }).catch(() => null);
  const around = (): Box[] => (where === null ? [] : [grown({ left: where.x, top: where.y, right: where.x + where.width, bottom: where.y + where.height }, 16)]);
  await snap(page, testInfo, '19-mixed-scan-page');
  expect(await drawnShare(page, 1, { except: around, name: '19-mixed-p2', testInfo }), 'page 2, a scan, is left as it is').toBeLessThan(0.0003);

  await rt(page).scrollToPage(2);
  await settleView(page, 900);
  expect(await drawnShare(page, 2, { except: around, name: '19-mixed-p3', testInfo }), 'page 3, a scan with recognised (invisible) text, is left as it is').toBeLessThan(0.0003);

  await rt(page).scrollToPage(3);
  await settleView(page, 900);
  await waitForTextLayer(page, 3);
  expect(await drawnShare(page, 3, { except: around, name: '19-mixed-p4', testInfo }), 'page 4, text again, has bold starts').toBeGreaterThan(SOMETHING_DRAWN);
  expect((await noteWatch(page)).appeared, 'the note came once').toBe(1);
});

/** Waits for the viewer to show the first scanned picture (the page's canvas has ink), so a picture of the page is a picture of the scan. */
async function waitForTextOrPicture(page: Page): Promise<void> {
  await expectViewer.poll(async () => page.evaluate(() => document.querySelectorAll('[data-page-index="0"] canvas').length), { message: 'the scan\'s page is drawn', timeout: 15_000 }).toBeGreaterThan(0);
  await settle(page, 1_200);
}

// =================================================================================================================
// The shortcut sheet
// =================================================================================================================

test('the shortcut sheet lists Bold word starts with a shortcut that clashes with nothing, the shortcut turns it on and off, and it does not fire while typing', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const sheet = await openSheet(page);
  const row = await sheetKeys(sheet);
  await snap(page, testInfo, '19-shortcut-sheet');
  expect(row, 'the shortcut sheet lists "Bold word starts"').not.toBeNull();
  expect(row!.keys.length, `the sheet gives "${row!.label}" a keyboard shortcut`).toBeGreaterThan(0);
  const shortcut = row!.keys[0];
  note(testInfo, '19 the shortcut the sheet prints', shortcut);
  const same = row!.all.filter((r) => r.label !== row!.label && r.keys.includes(shortcut)).map((r) => r.label);
  expect(same, `the shortcut ${shortcut} is no other row's shortcut in the sheet`).toEqual([]);
  const press = pressable(shortcut);
  expect(CHROME_KEYS.has(press.toLowerCase()), `${shortcut} (pressed as ${press}) is not one of Chrome's own keys`).toBe(false);
  await page.keyboard.press('Escape');
  await expect(sheet, 'Esc closes the sheet').toBeHidden();
  expect.soft((await switchState(page)).text, 'the View menu row shows the shortcut too').toContain(shortcut);

  const before = await look(page, 0);
  await page.keyboard.press(press);
  await expect.poll(() => isOn(page), { message: `pressing ${shortcut} turns it on (the View menu shows the check mark)`, timeout: 6_000 }).toBe(true);
  const on = await look(page, 0, '19-turned-on-by-key', testInfo);
  expect(changedShare(before.shot, on.shot, before.page), `and the page shows bold starts`).toBeGreaterThan(SOMETHING_DRAWN);
  await page.keyboard.press(press);
  await expect.poll(() => isOn(page), { message: `pressing ${shortcut} again turns it off`, timeout: 6_000 }).toBe(false);
  const off = await look(page, 0);
  expect(changedShare(before.shot, off.shot, before.page), 'and the page is as it was').toBeLessThan(0.00005);

  // "Single-key and Ctrl+Alt shortcuts never fire while you are typing."
  const parts = press.split('+');
  const singleKey = parts.length === 1;
  const ctrlAlt = parts.includes('Control') && parts.includes('Alt');
  if (singleKey || ctrlAlt) {
    await openFind(page);
    await page.keyboard.press(press);
    await expect(field(page), 'the find box still has the keyboard').toBeFocused();
    if (singleKey && press.length === 1) await expect(field(page), 'a single-key shortcut types its character into the box').toHaveValue(press);
    await page.keyboard.press('Escape');
    expect(await isOn(page), `${shortcut} typed in the find box does not turn the switch on`).toBe(false);
  } else {
    note(testInfo, '19 typing rule', `${shortcut} is not a single key or a Ctrl+Alt key, so the "never while typing" rule does not apply to it`);
  }
});

// =================================================================================================================
// Speed
// =================================================================================================================

const BLANK_SPEC_MS = 150;

function expectNoLongBlank(r: BlankReport, what: string): void {
  const worst = [...r.records].sort((a, b) => b.ms - a.ms).slice(0, 3).map((x) => `page ${x.page + 1}: ${x.ms.toFixed(0)} ms${x.left ? ' (left view unpainted)' : ''}${x.pending ? ' (still blank)' : ''}`);
  expect(r.wrong, `${what}: a page showed another page's picture`).toEqual([]);
  expect(r.maxMs, `${what}: longest blank ${r.maxMs.toFixed(0)} ms (${budgetNote(BLANK_SPEC_MS)}); worst: ${worst.join('; ')}`).toBeLessThanOrEqual(budgetMs(BLANK_SPEC_MS));
}

probed('with it on, steady scrolling through a 400-page book never leaves a page blank for more than 150 ms, and the bold starts are there when the scroll comes back', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(bookServed(FIXTURES.book)));
  await waitForFirstPage(page);
  await waitForPageOnScreen(page, 1);
  expect((await rt(page).doc())?.pageCount).toBe(BOOK_PAGES);
  await rt(page).setScale(1);
  await settle(page, 800);
  const off = await stableShot(page);
  const offBox = await pageBox(page, 0);
  await setSwitch(page, true);
  const shown = async (): Promise<number> => changedShare(off, await stableShot(page), offBox);
  // The book's text is set in an unembedded standard font: whether the product can bold it is judged apart (soft), so the budget below is judged either way.
  let drawn = 0;
  try {
    await expectViewer.poll(shown, { message: 'bold starts show on page 1 of the book', timeout: 8_000, intervals: [300, 600] }).toBeGreaterThan(SOMETHING_DRAWN);
    drawn = await shown();
  } catch {
    expect.soft(drawn, 'page 1 of the book (unembedded Helvetica) shows bold starts when the switch is on').toBeGreaterThan(SOMETHING_DRAWN);
  }
  await snap(page, testInfo, '19-book-on');

  await probe(page).startBlank();
  const moved = await probe(page).steady(3000, 6);
  await page.waitForTimeout(500);
  const report = await probe(page).stopBlank();
  note(testInfo, '19 steady scroll with it on', `${report.pagesSeen} pages entered view; blank max ${report.maxMs.toFixed(0)} ms, p95 ${report.p95Ms.toFixed(0)} ms; ${report.wrong.length} wrong pictures; longest frame gap ${report.maxFrameGapMs.toFixed(0)} ms; scrolled ${(moved.to - moved.from).toFixed(0)} px`);
  expect(report.pagesSeen, 'the scroll went through the book').toBeGreaterThanOrEqual(6);
  expectNoLongBlank(report, 'steady scroll at 3000 px/s with bold word starts on');

  await probe(page).startBlank();
  await page.keyboard.press('Home');
  await waitForPageOnScreen(page, 1, 5_000);
  const back = await probe(page).stopBlank();
  expectNoLongBlank(back, 'Home with bold word starts on');
  await settle(page, 600);
  const homeBox = await pageBox(page, 0);
  if (drawn > SOMETHING_DRAWN) {
    await expectViewer.poll(async () => changedShare(off, await stableShot(page), homeBox), { message: 'back on page 1 the bold starts are there again (cached per page and zoom, or drawn at once)', timeout: 4_000, intervals: [250, 500] }).toBeGreaterThan(SOMETHING_DRAWN);
  }
});

probed('with it on, a 50-page paper still shows its first page in under a second, and the bold starts follow on that page', async ({ openViewer, server }, testInfo) => {
  const first = await openViewer(server.url(REAL.paper50.url));
  await waitReady(first, 30_000);
  await setSwitch(first, true); // remembered for the next tab

  const page = await openViewer(server.url(REAL.paper50.url));
  const firstInkMs = await waitForFirstPage(page);
  note(testInfo, '19 first page on screen with the switch on remembered (ms)', firstInkMs.toFixed(0));
  expect(firstInkMs, `first picture of page 1 after ${firstInkMs.toFixed(0)} ms with the switch on; ${budgetNote(1000)}`).toBeLessThan(budgetMs(1000));
  await expectViewer.poll(() => page.evaluate(() => performance.getEntriesByName('sop:first-page').length), { message: 'the first-page mark was made' }).toBeGreaterThan(0);
  const markMs = await page.evaluate(() => performance.getEntriesByName('sop:first-page')[0].startTime);
  expect(markMs, `page 1 fully drawn after ${markMs.toFixed(0)} ms with the switch on; ${budgetNote(1000)}`).toBeLessThan(budgetMs(1000));
  await snap(page, testInfo, '19-paper-first-page-on');

  await waitForTextLayer(page, 0).catch(() => undefined);
  await settle(page, 800);
  await expect.poll(() => isOn(page), { message: 'the paper opened with the switch on', timeout: 8_000 }).toBe(true);
  expect.soft(await drawnShare(page, 0, { name: '19-paper-p1', testInfo }), 'the bold starts show on page 1 after the page is drawn').toBeGreaterThan(SOMETHING_DRAWN);
});
