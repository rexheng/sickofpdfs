// Walkthrough 17, print with marks (Phase 2 Round 3, slice S17). Gate 1, plan section 4 item 11 and the S17 entry of section 2.
//   Spec, Reading basics: "Print: Ctrl+P renders pages through PDFium into a print-only copy, with or without your marks."
//   Spec, Marks: "printing 'with marks' draws the same overlay onto each page. They are written into a PDF only when you export."
//   Plan S17: "Ctrl+P can print your marks on the pages. ... it draws the same overlay geometry, BoldLayer included, onto each print page."
//   Plan S16: an area draws in --sop-area-outline; a figure comment keeps its outline (spec: "A figure comment shows an outline, not a highlight").
//
// How it looks at the print. A script cannot drive Chrome's print preview, so window.print() is replaced by a recorder (support/nav.spec-blind.ts,
// as in walkthrough 14). At the moment the viewer asks the browser to print, the test asks Chromium for the PDF it would print (page.pdf with the
// print stylesheet) and opens that PDF in a second viewer tab, where each printed sheet is a page like any other: the marks are judged from the
// PIXELS of the printed sheet, in the colours of the design tokens, at the places they have on the screen. Whether the marks are baked into the sheet's
// picture or drawn over it is not the spec's business, so nothing here looks inside the print copy.
//
// The two prints (with marks, then without) are compared with each other: outside the marked lines the two sheets must be the same, and a page with
// no marks must print the same either way.
//
// GUESSES (the spec is silent): how "with or without" is offered. The walkthrough looks, after Ctrl+P, for what a person would see: a dialog or menu
// with a choice named for the marks ("Print with marks" and "Print without marks" as buttons or radio buttons, or a box "Include marks" that is
// ticked or not), and a Print button that goes on; if no choice appears and the viewer prints at once, the walkthrough cannot choose and says so.
import type { Page } from '@playwright/test';
import { changed, near, findRing, describeRing, shareOf, type Frame } from '../support/rings.spec-blind';
import { expect, hooks, test, type FixtureServer } from '../support/test';
import {
  FIG_PICTURE,
  altDrag,
  boxOfNorm,
  clientOfPoint,
  figureBox,
  grow,
  normOfBox,
  openFigurePaper,
  outlineTokens,
  snapFrame,
  within,
  type Box,
} from './support/figures.spec-blind';
import {
  ATTENTION,
  LINES,
  WIDE,
  answerSavePrompt,
  clearSelection,
  describe,
  hex,
  highlightFromMenu,
  isPlain,
  lineBoxes,
  lineColours,
  markPixelsOnPage,
  markTokens,
  note,
  openPaper,
  pageRect,
  paintOf,
  selectPassage,
  settle,
  startNoteAnswering,
  strokesOf,
  type Selected,
} from './support/marks.spec-blind';
import { pageMap } from '../support/tl-blind.spec-blind';
import { printLog, useRecordingPrint } from './support/nav.spec-blind';
import { shot } from './support/takeover';
import { waitReady } from './support/viewer.spec-blind';

test.setTimeout(300_000);

// ---------------------------------------------------------------------------------------------------------------
// Printing, with or without marks

const MARKS_WORD = /\b(?:marks?|notes?|annotations?)\b/i;
const WITH_MARKS = /^(?!.*\b(?:without|no|exclude)\b)(?=.*\b(?:marks?|notes?|annotations?)\b).*\b(?:with|include|print)\b/i;
const WITHOUT_MARKS = /\bwithout\b.*\b(?:marks?|notes?|annotations?)\b|\bno\s+(?:marks?|notes?|annotations?)\b|\bexclude\b|\bpages? only\b|\bjust the pages\b|\bplain\b/i;

/**
 * Ctrl+P, then the choice if the viewer asks for one: a button, radio button or menu item named for printing with (or without) the marks, or
 * a box about the marks that is ticked or not, and a Print button in the dialog. Says how it went; waits for the viewer to ask the browser to print.
 */
async function printWithMarks(page: Page, withMarks: boolean): Promise<{ asked: boolean; how: string }> {
  const before = (await printLog(page)).calls;
  await page.keyboard.press('Control+p');
  const wanted = withMarks ? WITH_MARKS : WITHOUT_MARKS;
  const roles = ['button', 'radio', 'menuitemradio', 'menuitem', 'option', 'tab'] as const;
  const pick = roles.map((role) => page.getByRole(role, { name: wanted })).reduce((a, b) => a.or(b));
  const tick = page.getByRole('checkbox', { name: MARKS_WORD }).or(page.getByRole('switch', { name: MARKS_WORD })).or(page.getByRole('menuitemcheckbox', { name: MARKS_WORD }));
  let how = 'no choice was offered: the viewer printed at once';
  let asked = false;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await printLog(page)).calls > before) break;
    if (await pick.first().isVisible().catch(() => false)) {
      how = `clicked "${((await pick.first().innerText().catch(() => '')) || (await pick.first().getAttribute('aria-label')) || '').replace(/\s+/g, ' ').trim()}"`;
      await pick.first().click();
      asked = true;
    } else if (await tick.first().isVisible().catch(() => false)) {
      await tick.first().setChecked(withMarks);
      how = `${withMarks ? 'ticked' : 'cleared'} "${((await tick.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()}"`;
      asked = true;
    } else {
      await page.waitForTimeout(150);
      continue;
    }
    const go = page.getByRole('dialog').getByRole('button', { name: /^(?:print|continue|ok|next|start)\b/i });
    if (await go.first().isVisible({ timeout: 600 }).catch(() => false)) await go.first().click();
    break;
  }
  await expect.poll(async () => (await printLog(page)).calls, { message: `Ctrl+P ends in window.print() (${how})`, timeout: 120_000, intervals: [200, 500, 1000] }).toBeGreaterThan(before);
  return { asked, how };
}

/** The PDF the browser would print, with the print copy disposed afterwards as the browser's afterprint does. */
async function printedPdf(page: Page): Promise<Buffer> {
  const afterprint = (await printLog(page)).afterprint;
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: null });
  if ((await printLog(page)).afterprint === afterprint) await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#sop-print-root'), 'after printing the print copy is disposed').toHaveCount(0, { timeout: 8000 });
  return pdf;
}

/** The printout opened in a viewer tab at 100%, ready to be photographed sheet by sheet. */
async function openPrintout(openViewer: (source: string) => Promise<Page>, server: FixtureServer, pdf: Buffer, name: string): Promise<Page> {
  server.serveSequence(`/p/${name}.pdf`, [pdf]);
  const out = await openViewer(server.url(`/p/${name}.pdf`));
  await out.setViewportSize(WIDE);
  await waitReady(out, 45_000);
  await hooks(out).eval((h) => h.viewer.setScale(1));
  return out;
}

/** Sheet `i` of the printout on the screen: its picture and where the sheet is. */
async function sheetOf(out: Page, i: number): Promise<{ frame: Frame; box: Box }> {
  await hooks(out).eval((h, idx) => h.viewer.scrollTo(idx), i);
  await out.waitForSelector(`[data-page-index="${i}"]`, { state: 'attached' });
  await settle(out, 1200); // the sheet's sharp picture
  await out.mouse.move(4, 420);
  return { frame: await snapFrame(out), box: await pageRect(out, i) };
}

const pageCountOf = (p: Page): Promise<number> => hooks(p).eval((h) => h.doc()!.open.pageCount);

/** A box of the source page (window px) as the same place on a sheet. */
const toSheet = (b: Box, from: Box, to: Box): Box => {
  const fx = (x: number) => to.left + ((x - from.left) / (from.right - from.left)) * (to.right - to.left);
  const fy = (y: number) => to.top + ((y - from.top) / (from.bottom - from.top)) * (to.bottom - to.top);
  return { left: fx(b.left), right: fx(b.right), top: fy(b.top), bottom: fy(b.bottom) };
};

/** The share of the sheet's pixels that differ between two prints, outside `keep` (each grown by `pad` px). */
function changedOutside(a: Frame, b: Frame, sheet: Box, keep: Box[], pad: number): number {
  const probe = changed(a, b);
  const grown = keep.map((k) => grow(k, pad));
  const x0 = Math.max(0, Math.floor(sheet.left * a.dpr));
  const x1 = Math.min(a.img.width - 1, Math.ceil(sheet.right * a.dpr));
  const y0 = Math.max(0, Math.floor(sheet.top * a.dpr));
  const y1 = Math.min(a.img.height - 1, Math.ceil(sheet.bottom * a.dpr));
  let n = 0;
  let hit = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = x / a.dpr;
      const cy = y / a.dpr;
      if (grown.some((k) => cx >= k.left && cx <= k.right && cy >= k.top && cy <= k.bottom)) continue;
      n++;
      if (probe(x, y)) hit++;
    }
  }
  return n === 0 ? 0 : hit / n;
}

const YELLOW = 0;
const GREEN = 1;

// ---------------------------------------------------------------------------------------------------------------

test('printing with marks puts the highlights, underline, strike and bold on the printed page; printing without marks leaves the page plain; nothing else changes', async ({ context, openViewer, server }, testInfo) => {
  await useRecordingPrint(context);
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);

  // The marks: a yellow highlight (H), a green one (the menu), an underline, a strike and bold, on five lines of the abstract.
  const made: { name: string; sel: Selected }[] = [];
  const mark = async (name: string, line: (typeof LINES)[keyof typeof LINES], how: () => Promise<void>) => {
    const sel = await selectPassage(page, ATTENTION, line);
    await how();
    made.push({ name, sel });
  };
  await mark('yellow highlight', LINES.l1, () => page.keyboard.press('h'));
  await answerSavePrompt(page, 'Yes', 500);
  await mark('green highlight', LINES.l3, async () => {
    await clearSelection(page);
    const sel = await selectPassage(page, ATTENTION, LINES.l3);
    await highlightFromMenu(page, sel, 'green');
  });
  await mark('underline', LINES.l5, () => page.keyboard.press('Control+u'));
  await mark('strike', LINES.l7, () => page.keyboard.press('Alt+Shift+5'));
  await mark('bold', LINES.l9, () => page.keyboard.press('Control+b'));
  await clearSelection(page);
  await settle(page, 600);
  const onScreen = await pageRect(page, 0);
  const lines = await Promise.all(made.map(async (m) => (await lineBoxes(page, m.sel))[0]));
  expect((await markPixelsOnPage(page, 0, tokens)), 'the marks are on the screen before printing').toBeGreaterThan(200);
  await shot(page, testInfo, 'marks-on-screen');

  // ---- Print with marks ----
  const withChoice = await printWithMarks(page, true);
  note(testInfo, 'print with marks', withChoice.how);
  const withPdf = await printedPdf(page);
  // ---- Print without marks (a second print: the choice does not stay) ----
  const withoutChoice = await printWithMarks(page, false);
  note(testInfo, 'print without marks', withoutChoice.how);
  expect.soft(withChoice.asked && withoutChoice.asked, `Ctrl+P offers the choice "with or without your marks" (with: ${withChoice.how}; without: ${withoutChoice.how})`).toBe(true);
  const withoutPdf = await printedPdf(page);

  expect((await markPixelsOnPage(page, 0, tokens)), 'after printing the marks are still on the screen').toBeGreaterThan(200);

  const outWith = await openPrintout(openViewer, server, withPdf, 'with-marks');
  const outWithout = await openPrintout(openViewer, server, withoutPdf, 'without-marks');
  const pages = await pageCountOf(page);
  expect(await pageCountOf(outWith), 'the printout has one sheet for each page').toBe(pages);
  expect(await pageCountOf(outWithout)).toBe(pages);
  const a = await sheetOf(outWith, 0);
  const b = await sheetOf(outWithout, 0);
  await shot(outWith, testInfo, 'printed-with-marks');
  await shot(outWithout, testInfo, 'printed-without-marks');
  expect(Math.abs(a.box.right - a.box.left - (onScreen.right - onScreen.left)) + Math.abs(a.box.bottom - a.box.top - (onScreen.bottom - onScreen.top)), 'the sheet is the page, not widened for the margin column').toBeLessThanOrEqual(3);

  const printed = (i: number): Box[] => [toSheet(lines[i], onScreen, a.box)];
  const plain = (i: number): Box[] => [toSheet(lines[i], onScreen, b.box)];
  const grabbed = (f: Frame) => ({ img: f.img, dpr: f.dpr });

  // yellow and green highlights
  const yellow = paintOf(grabbed(a.frame), printed(0));
  expect.soft(yellow.share(tokens.fill[YELLOW]), `the yellow highlight is on the printed line, in the mark's yellow ${hex(tokens.fill[YELLOW])}: ${describe(yellow)}`).toBeGreaterThanOrEqual(0.6);
  const green = paintOf(grabbed(a.frame), printed(1));
  expect.soft(green.share(tokens.fill[GREEN]), `the green highlight is on the printed line, in the mark's green ${hex(tokens.fill[GREEN])}: ${describe(green)}`).toBeGreaterThanOrEqual(0.6);
  // underline
  const under = strokesOf(grabbed(a.frame), printed(2)[0], lineColours(tokens.line[YELLOW]));
  expect.soft(under.rows.length, `an underline in the line colour ${hex(tokens.line[YELLOW])} runs along the printed words`).toBeGreaterThan(0);
  expect.soft(Math.min(...under.rows), 'in the lower part of the line').toBeGreaterThanOrEqual(0.6);
  // strike
  const strike = strokesOf(grabbed(a.frame), printed(3)[0], lineColours(tokens.line[YELLOW]), { above: 0, below: 0, cover: 0.2 });
  expect.soft(strike.rows.length, `a strike in the line colour runs through the printed words`).toBeGreaterThan(0);
  expect.soft(strike.rows.every((r) => r >= 0.2 && r <= 0.8), 'through the middle of the line').toBe(true);
  // bold: heavier ink than the same words printed without marks
  const boldOn = paintOf(grabbed(a.frame), printed(4));
  const boldOff = paintOf(grabbed(b.frame), plain(4));
  expect.soft(boldOn.darkness, `bold prints heavier: ${boldOff.darkness.toFixed(0)} black px without marks, ${boldOn.darkness.toFixed(0)} with`).toBeGreaterThanOrEqual(boldOff.darkness * 1.03);
  expect.soft(boldOn.darkness, 'but it is still the same words').toBeLessThanOrEqual(boldOff.darkness * 2);

  // without marks, every one of those lines is plain paper and ink
  for (const [i, m] of made.entries()) {
    const p = paintOf(grabbed(b.frame), plain(i));
    expect.soft(isPlain(p), `without marks the ${m.name} line prints plain: ${describe(p)}`).toBe(true);
  }
  expect.soft(strokesOf(grabbed(b.frame), plain(2)[0], lineColours(tokens.line[YELLOW])).rows, 'no underline without marks').toEqual([]);
  expect.soft(strokesOf(grabbed(b.frame), plain(3)[0], lineColours(tokens.line[YELLOW]), { above: 0, below: 0, cover: 0.2 }).rows, 'no strike without marks').toEqual([]);

  // Nothing else changes: outside the five lines the two prints are the same sheet (no card, no margin column, no stray mark).
  const stray = changedOutside(a.frame, b.frame, a.box, lines.map((l) => toSheet(l, onScreen, a.box)), 8);
  expect.soft(stray, 'outside the marked lines the sheet with marks and the sheet without are the same').toBeLessThan(0.0005);

  // A page with no marks prints the same either way.
  const a2 = await sheetOf(outWith, 1);
  const b2 = await sheetOf(outWithout, 1);
  expect.soft(shareOf(a2.frame, changed(a2.frame, b2.frame), a2.box), 'a page with no marks prints the same with or without marks').toBeLessThan(0.0002);
});

test('an Alt+drag area and a figure comment print too, in their own outline; printing without marks leaves the figure bare', async ({ context, openViewer, server }, testInfo) => {
  await useRecordingPrint(context);
  const fig = FIG_PICTURE;
  const page = await openFigurePaper(openViewer, server, fig);
  const tokens = await outlineTokens(page);

  // An area over the abstract, then a comment on the figure.
  const from = await clientOfPoint(page, fig.pageIndex, 80, 300);
  const to = await clientOfPoint(page, fig.pageIndex, 250, 385);
  const dragBox: Box = { left: from.x, top: from.y, right: to.x, bottom: to.y };
  await altDrag(page, from, to);
  await answerSavePrompt(page, 'Yes', 500);
  const dragNorm = await normOfBox(page, fig.pageIndex, dragBox);
  await page.mouse.move(8, 420);
  await settle(page, 500);
  const fbox = await figureBox(page, fig);
  const aim = within(fbox, fig.aim.x, fig.aim.y);
  await page.mouse.move(aim.x, aim.y);
  await page.waitForTimeout(600);
  await page.mouse.click(aim.x, aim.y);
  await startNoteAnswering(page, 'Yes');
  await page.keyboard.type('Comment on the picture', { delay: 8 });
  await page.keyboard.press('Enter');
  await settle(page, 800);
  await shot(page, testInfo, 'area-and-figure-comment-on-screen');

  const withChoice = await printWithMarks(page, true);
  const withPdf = await printedPdf(page);
  const withoutChoice = await printWithMarks(page, false);
  const withoutPdf = await printedPdf(page);
  expect.soft(withChoice.asked && withoutChoice.asked, `Ctrl+P offers the choice (with: ${withChoice.how}; without: ${withoutChoice.how})`).toBe(true);

  const outWith = await openPrintout(openViewer, server, withPdf, 'figure-with-marks');
  const outWithout = await openPrintout(openViewer, server, withoutPdf, 'figure-without-marks');
  const a = await sheetOf(outWith, fig.pageIndex);
  const b = await sheetOf(outWithout, fig.pageIndex);
  await shot(outWith, testInfo, 'printed-with-marks');
  await shot(outWithout, testInfo, 'printed-without-marks');

  // the area, in the area colour, where it was dragged
  const areaOnSheet = await boxOfNorm(outWith, fig.pageIndex, dragNorm);
  const areaRing = findRing(a.frame, near(a.frame, tokens.area, 40), areaOnSheet, { band: 8, prefer: tokens.area });
  expect(areaRing.found, `the area prints as a rectangle in the area colour ${hex(tokens.area)}: ${describeRing(areaRing)}`).toBe(4);
  const areaBare = findRing(b.frame, near(b.frame, tokens.area, 40), await boxOfNorm(outWithout, fig.pageIndex, dragNorm), { band: 8, prefer: tokens.area });
  expect(areaBare.found, `and not without marks: ${describeRing(areaBare)}`).toBe(0);

  // the figure's outline: there with marks, bare without
  const figOnSheet = (await pageMap(outWith, fig.pageIndex)).box(fig.rect);
  const band = Math.max(20, 0.15 * Math.min(figOnSheet.right - figOnSheet.left, figOnSheet.bottom - figOnSheet.top));
  const outlined = findRing(a.frame, changed(b.frame, a.frame), figOnSheet, { band });
  expect(outlined.found, `the commented figure prints with its outline: ${describeRing(outlined)}`).toBe(4);
  expect(outlined.iou, 'around the figure').toBeGreaterThanOrEqual(0.55);
  const stray = changedOutside(a.frame, b.frame, a.box, [areaOnSheet, grow(figOnSheet, band)], 8);
  expect(stray, 'outside the area and the figure the two prints are the same (no card, no pin of the margin, no stray mark)').toBeLessThan(0.0005);
});
