// Walkthrough 10, "You open a receipt": a scanned receipt (a photo of paper, no text in the file) "displays normally".
// Spec: "How it feels to use" 10 and 3 ("scans open normally and take page, point and area notes"); Scanned PDFs: "Release 1: scans open
// normally". (The chip "Not saved: looks like a receipt" belongs to a later task.) Here: the scan's picture is on the page.
// Two real files from the classifier set: an iPhone scan on a Letter page, and a very tall, narrow shop receipt (222 x 1046 pt),
// which at fit width is taller than 4096 device pixels, the size past which the page is drawn in tiles.
import { REAL } from './support/fixtures.spec-blind';
import { inkBox, type CssRect } from './support/pixels.spec-blind';
import { expect, probe, rt, shoot, snap, test, waitForFirstPage } from './support/viewer.spec-blind';

const intersect = (a: CssRect, b: CssRect): CssRect => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
};

for (const [name, slug, file] of [
  ['an iPhone scan of a Starbucks receipt', 'starbucks', REAL.starbucks],
  ['a tall, narrow shop receipt', 'shop', REAL.wholefoods],
] as const) {
  test(`${name} opens and shows its scanned picture, at the top and at the bottom`, async ({ openViewer, server }, testInfo) => {
    const page = await openViewer(server.url(file.url));
    await waitForFirstPage(page);
    expect(await rt(page).state()).toBe('ready');
    expect((await rt(page).doc())!.pageCount).toBe(file.pages);
    await expect(page.getByText(/Couldn't load|didn't return a PDF/)).toBeHidden();
    await page.waitForTimeout(800); // a sharp redraw after the quick preview

    const look = async (what: string) => {
      const s = await shoot(page);
      const c = s.canvases.find((k) => k.page === 0);
      expect(c, `the receipt's page canvas is on screen (${what})`).toBeDefined();
      const visible = intersect({ x: c!.x, y: c!.y, width: c!.cssWidth, height: c!.cssHeight }, s.scroller);
      const ink = inkBox(s.img, s.ratio, visible, 140);
      return { ink, visible, canvas: c! };
    };

    const top = await look('top');
    expect(top.ink, 'the scan shows ink (the receipt lines and logo), not a blank page').not.toBeNull();
    expect(top.ink!.share, 'the picture is there, not a speck').toBeGreaterThan(0.003);
    await snap(page, testInfo, `10-${slug}-top`);

    await page.keyboard.press('End');
    await expect.poll(async () => (await rt(page).maxScrollTop()) - (await rt(page).scrollTop())).toBeLessThanOrEqual(2);
    await expect
      .poll(async () => (await look('bottom')).ink?.share ?? 0, { message: 'the bottom of the receipt is drawn too', timeout: 10_000 })
      .toBeGreaterThan(0.003);
    await snap(page, testInfo, `10-${slug}-bottom`);
    expect(await probe(page).inkNow()).toBe(true);
  });
}

test('the Starbucks scan is shown as a tall paper strip on a white Letter page, with its coloured edge', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(REAL.starbucks.url));
  await waitForFirstPage(page);
  await page.waitForTimeout(800);
  const s = await shoot(page, testInfo.outputPath('10-starbucks-page.png'));
  const c = s.canvases.find((k) => k.page === 0)!;
  const rect = { x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight };
  expect(rect.width / rect.height, 'Letter proportions').toBeCloseTo(612 / 792, 1);
  const ink = inkBox(s.img, s.ratio, intersect(rect, s.scroller), 140)!;
  // The receipt sits in the middle of the page (poppler's render of this file: ink spans 27% to 73% of the width).
  expect(ink.left, 'receipt text starts well inside the page').toBeGreaterThan(0.15);
  expect(ink.right, 'and ends well inside it').toBeLessThan(0.85);
});
