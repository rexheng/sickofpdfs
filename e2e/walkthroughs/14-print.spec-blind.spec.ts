// Walkthrough 14, printing (Task 27).
// Spec: Reading basics, "Print: Ctrl+P renders pages through PDFium into a print-only copy, with or without your marks"; shortcuts,
// "Print / download original: Ctrl+P / Ctrl+S"; criterion 6, "Print ... work at least as well as in Chrome's viewer".
// Interface file (Task 27): Ctrl+P opens a dialog "Preparing to print… {done} / {total}" with Cancel (aborts and disposes); each page is
// rendered upright at 200 dpi into an <img> sized {w/72}in x {h/72}in inside #sop-print-root, one sheet per page with
// `break-after: page`; every sheet has its own page size through CSS named pages (`@page p-N { size: <w>pt <h>pt; margin: 0 }`, width and
// height swapped for /Rotate 90 and 270; never `size: landscape`); `@media print` hides #sop-app and shows #sop-print-root;
// #sop-print-hint says "Use Ctrl+P or File → Print to print this PDF." and shows only when no print root exists; the print copy is
// disposed on afterprint.
//
// A script cannot drive Chrome's print preview, so window.print() is replaced by a recorder (support/nav.spec-blind.ts). At the moment
// the viewer calls it, the recorder looks at the print copy. The test then asks Chromium for the PDF it would print (page.pdf with the
// print stylesheet), counts its sheets, reads their sizes, and opens that PDF in a second viewer to look at what is on them.
import { PDFDocument } from 'pdf-lib';
import { FIXTURES, MIXED_PAGES, ensureMixed, served } from './support/fixtures.spec-blind';
import { inches, printLog, sizeInPoints, useRecordingPrint } from './support/nav.spec-blind';
import { inkBox, regionStats } from './support/pixels.spec-blind';
import { expect, rt, scrollerRect, settled, shoot, snap, test, waitForFirstPage } from './support/viewer.spec-blind';

test.beforeAll(async () => {
  await ensureMixed();
});

const HINT = /Use Ctrl\+P or File\s*(?:→|->)\s*Print to print this PDF\./;

/** The displayed size of each mixed.pdf page, in points: the media box, turned for /Rotate 90 and 270. */
const MIXED_SHEETS = MIXED_PAGES.map((p) => (p.rotate % 180 === 90 ? { w: p.height, h: p.width } : { w: p.width, h: p.height }));

test('Ctrl+P shows "Preparing to print… n / total" with a Cancel button, and Cancel stops it and leaves nothing behind', async ({ context, openViewer, server }, testInfo) => {
  await useRecordingPrint(context);
  const page = await openViewer(server.url('/f/scan-120.pdf'));
  await waitForFirstPage(page, 45_000);

  // With no print copy, the browser's own print (the menu, say) would show the hint instead of the viewer.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#sop-print-hint'), 'no print copy yet: a print would show the hint').toBeVisible();
  await expect(page.locator('#sop-print-hint')).toHaveText(HINT);
  await expect(page.locator('#sop-print-root')).toHaveCount(0);
  await expect(page.getByRole('menubar'), 'and not the viewer\'s own menus').toBeHidden();
  await page.emulateMedia({ media: null });

  await page.keyboard.press('Control+p');
  const message = page.getByText(/Preparing to print/).first();
  await expect(message, 'Ctrl+P opens the progress dialog').toBeVisible({ timeout: 10_000 });
  expect.soft(await page.getByRole('dialog').or(page.getByRole('alertdialog')).filter({ hasText: /Preparing to print/ }).count(), 'the progress is in a dialog').toBe(1);
  const progress = async (): Promise<{ done: number; total: number }> => {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const m = /Preparing to print\D*(\d+)\s*\/\s*(\d+)/.exec(text);
    return m ? { done: Number(m[1]), total: Number(m[2]) } : { done: -1, total: -1 };
  };
  const first = await progress();
  expect(first.total, 'it counts the 120 pages of this scan').toBe(120);
  await expect.poll(async () => (await progress()).done, { message: 'the count goes up as pages are drawn', timeout: 45_000, intervals: [200, 400, 800] }).toBeGreaterThan(Math.max(first.done, 0));
  expect((await progress()).done, 'it is not finished').toBeLessThan(120);
  await snap(page, testInfo, '14-progress');

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(message, 'Cancel closes the dialog').toBeHidden({ timeout: 5_000 });
  await expect(page.locator('#sop-print-root'), 'and throws away what was drawn so far').toHaveCount(0, { timeout: 5_000 });
  await page.waitForTimeout(2_500); // long enough for a print that was merely hidden to carry on and call print()
  expect((await printLog(page)).calls, 'Cancel means the browser is never asked to print').toBe(0);

  // The viewer is as it was: the hint is what a print would show, and reading carries on.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#sop-print-hint')).toBeVisible();
  await page.emulateMedia({ media: null });
  const top = await rt(page).scrollTop();
  await page.keyboard.press('PageDown');
  await expect.poll(() => rt(page).scrollTop(), { message: 'the page keys work again after Cancel' }).toBeGreaterThan(top + 100);
  await snap(page, testInfo, '14-after-cancel');
});

test('the print copy has one sheet per page, each at its own size (landscape and rotated pages too), drawn upright, with none of the viewer around it', async ({ context, openViewer, server }, testInfo) => {
  await useRecordingPrint(context);
  const page = await openViewer(server.url(served(FIXTURES.mixed)));
  await waitForFirstPage(page);

  await page.keyboard.press('Control+p');
  await expect.poll(async () => (await printLog(page)).calls, { message: 'Ctrl+P ends in window.print()', timeout: 30_000, intervals: [100, 250, 500] }).toBe(1);
  const snapshot = (await printLog(page)).snapshots[0];

  // ---- The print copy the viewer made ----
  expect(snapshot.hasRoot, 'the print copy is #sop-print-root').toBe(true);
  expect(snapshot.dialogsOpen, 'the progress dialog is closed before printing, so it is not printed').toBe(0);
  expect(snapshot.sheets.length, 'one sheet for each of the 5 pages').toBe(MIXED_SHEETS.length);
  snapshot.sheets.forEach((sheet, i) => {
    const want = MIXED_SHEETS[i];
    const label = `sheet ${i + 1} (${want.w} x ${want.h} pt)`;
    expect(sheet.pictures, `${label} holds exactly one picture`).toBe(1);
    expect(sheet.decoded, `${label}: the picture is decoded before printing starts`).toBe(true);
    expect(Math.abs(inches(sheet.width) - want.w / 72), `${label}: the picture is ${want.w / 72} in wide (it says ${sheet.width})`).toBeLessThan(0.02);
    expect(Math.abs(inches(sheet.height) - want.h / 72), `${label}: the picture is ${want.h / 72} in tall (it says ${sheet.height})`).toBeLessThan(0.02);
    expect(Math.abs(sheet.pixels.w - (want.w * 200) / 72), `${label}: drawn at 200 dpi (${sheet.pixels.w} px wide)`).toBeLessThanOrEqual(3);
    expect(Math.abs(sheet.pixels.h - (want.h * 200) / 72), `${label}: drawn at 200 dpi (${sheet.pixels.h} px tall)`).toBeLessThanOrEqual(3);
    expect(sheet.pageName, `${label} names its page size`).not.toBe('');
    const rule = snapshot.pageRules.find((r) => r.name === sheet.pageName);
    expect(rule, `${label}: there is an @page rule called "${sheet.pageName}"`).toBeDefined();
    const size = sizeInPoints(rule!.size);
    expect(size, `${label}: its size is two lengths, not a keyword like landscape (it says "${rule!.size}")`).not.toBeNull();
    expect(Math.abs(size![0] - want.w), `${label}: the page is ${want.w} pt wide`).toBeLessThanOrEqual(0.6);
    expect(Math.abs(size![1] - want.h), `${label}: the page is ${want.h} pt tall`).toBeLessThanOrEqual(0.6);
    expect(inches(rule!.margin) === 0 || /^0(px)?$/.test(rule!.margin.trim()), `${label}: no margin (it says "${rule!.margin}")`).toBe(true);
  });

  // ---- What the browser would print: the screen's viewer is gone, the print copy is all there is ----
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#sop-print-root'), 'in print the print copy shows').toBeVisible();
  await expect(page.locator('#sop-print-hint'), 'and the hint does not, since there is a print copy').toBeHidden();
  await expect(page.getByRole('menubar'), 'the viewer\'s menus are not printed').toBeHidden();
  await expect(page.locator('header'), 'nor its header').toBeHidden();
  await snap(page, testInfo, '14-print-media');
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: null });
  const printed = await PDFDocument.load(pdf);
  const sheets = printed.getPages().map((p) => p.getSize());
  expect(sheets.length, 'the printout has 5 sheets: one per page, and no blank sheet after the last').toBe(MIXED_SHEETS.length);
  sheets.forEach((s, i) => {
    const want = MIXED_SHEETS[i];
    expect(Math.abs(s.width - want.w), `sheet ${i + 1} is ${want.w} pt wide (it is ${s.width.toFixed(1)})`).toBeLessThanOrEqual(1.5);
    expect(Math.abs(s.height - want.h), `sheet ${i + 1} is ${want.h} pt tall (it is ${s.height.toFixed(1)})`).toBeLessThanOrEqual(1.5);
  });
  expect(sheets.some((s) => s.width > s.height), 'the printout includes landscape sheets').toBe(true);

  // ---- The copy goes away when printing is over ----
  if ((await printLog(page)).afterprint === 0) await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#sop-print-root'), 'after printing the print copy is disposed').toHaveCount(0, { timeout: 5_000 });
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#sop-print-hint'), 'and a later print shows the hint again').toBeVisible();
  await page.emulateMedia({ media: null });
  expect(await rt(page).state(), 'the viewer is still showing the PDF').toBe('ready');

  // ---- Look at what is on the printed sheets: open the printout in a second viewer ----
  server.serveSequence('/p/printed.pdf', [pdf]);
  const out = await openViewer(server.url('/p/printed.pdf'));
  await waitForFirstPage(out);
  expect((await rt(out).doc())!.pageCount, 'the printout opens with 5 pages').toBe(MIXED_SHEETS.length);
  for (let i = 0; i < MIXED_SHEETS.length; i++) {
    await rt(out).scrollToPage(i);
    await settled(() => rt(out).scrollTop(), 1, 2_000);
    await out.waitForTimeout(500); // the sharp picture of the page
    const shot = await shoot(out, testInfo.outputPath(`14-printed-sheet-${i + 1}.png`));
    const canvas = shot.canvases.find((c) => c.page === i);
    expect(canvas, `printed sheet ${i + 1} is on screen`).toBeDefined();
    const scroller = await scrollerRect(out);
    // The part of the sheet that is in the window.
    const x0 = Math.max(canvas!.x, scroller.x);
    const y0 = Math.max(canvas!.y, scroller.y);
    const visible = { x: x0, y: y0, width: Math.min(canvas!.x + canvas!.cssWidth, scroller.x + scroller.width) - x0, height: Math.min(canvas!.y + canvas!.cssHeight, scroller.y + scroller.height) - y0 };
    const stats = regionStats(shot.img, shot.ratio, visible);
    expect(stats.dark, `printed sheet ${i + 1}: paper with text, not the dark viewer (${(stats.dark * 100).toFixed(1)}% dark)`).toBeLessThan(0.08);
    expect(stats.nonWhite, `printed sheet ${i + 1}: mostly white paper`).toBeLessThan(0.2);
    const topLeft = { x: canvas!.x, y: canvas!.y, width: canvas!.cssWidth * 0.5, height: canvas!.cssHeight * 0.2 };
    const label = inkBox(shot.img, shot.ratio, topLeft, 128);
    expect(label, `printed sheet ${i + 1}: its "Page ${i + 1}" label is at the top left`).not.toBeNull();
    expect(label!.aspect, `printed sheet ${i + 1}: the label reads left to right (a rotated page printed upright, not on its side)`).toBeGreaterThan(2);
    const cornerWhite = { x: canvas!.x + canvas!.cssWidth * 0.97, y: canvas!.y + canvas!.cssHeight * 0.005, width: canvas!.cssWidth * 0.02, height: canvas!.cssHeight * 0.01 };
    expect(inkBox(shot.img, shot.ratio, cornerWhite, 250), `printed sheet ${i + 1}: the top right corner is white paper`).toBeNull();
  }
  await snap(out, testInfo, '14-printout-last-sheet');
});
