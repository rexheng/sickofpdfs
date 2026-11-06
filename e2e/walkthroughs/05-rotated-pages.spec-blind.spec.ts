// Walkthrough: "A rotated page shows the right way up."
// The reading list the owner opens has pages of different shapes: Letter, A4 landscape, a Letter page whose file says
// /Rotate 90, a 16:9 slide and A5. Each reads "Page N" in 48 pt at the top-left AS DISPLAYED (see support/fixtures.spec-blind.ts).
// Spec: Viewer, "Rotate and views" and Reading basics (a PDF must look as it does in Chrome's viewer).
// Interface file / Task 15 rules: "PageSize from the engine is the UNROTATED page size; layout applies the page's /Rotate plus the view
// rotation (clockwise)"; "The page is displayed width wide and height tall when (rotation + viewRotation) % 180 is 0".
import { FIXTURES, MIXED_PAGES, ensureMixed, served } from './support/fixtures.spec-blind';
import { inkBox } from './support/pixels.spec-blind';
import { expect, rt, settled, shoot, snap, test, waitForFirstPage } from './support/viewer.spec-blind';

test.beforeAll(async () => {
  await ensureMixed();
});

test('Rotated pages: every label upright, and the engine and the layout agree on the /Rotate 90 page', async ({ step }, testInfo) => {
  test.setTimeout(120_000);
  await step('every page of a mixed reading list shows its label upright at the top-left, including the /Rotate 90 page', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.mixed)));
    await waitForFirstPage(page);
    expect((await rt(page).doc())?.pageCount).toBe(MIXED_PAGES.length);
    await rt(page).setScale(0.5); // each whole page fits in the window
    await settled(() => rt(page).scale());
    expect((await rt(page).snapshot()).viewRotation, 'the viewer starts with no rotation of its own').toBe(0);

    for (const spec of MIXED_PAGES) {
      const index = spec.n - 1;
      await rt(page).scrollToPage(index);
      // Wait for page `index` to be drawn: ink inside its canvas.
      let rect = { x: 0, y: 0, width: 0, height: 0 };
      await expect
        .poll(async () => {
          const s = await shoot(page);
          const c = s.canvases.find((k) => k.page === index);
          if (!c) return false;
          rect = { x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight };
          return inkBox(s.img, s.ratio, rect, 128) !== null;
        }, { message: `page ${spec.n} (${spec.name}) never showed ink`, timeout: 8_000 })
        .toBe(true);

      const s = await shoot(page, testInfo.outputPath(`05-page-${spec.n}.png`));
      // 1. The page is shown with the proportions it has when displayed.
      const turned = spec.rotate % 180 === 90;
      const shownW = turned ? spec.height : spec.width;
      const shownH = turned ? spec.width : spec.height;
      expect(rect.width / rect.height, `page ${spec.n} (${spec.name}) is shown ${shownW} x ${shownH}`).toBeCloseTo(shownW / shownH, 1);

      // 2. Its label is at the top-left, laid along the line, not standing on end or in another corner.
      const band = { x: rect.x, y: rect.y, width: rect.width, height: rect.height * 0.3 };
      const ink = inkBox(s.img, s.ratio, band, 128);
      expect(ink, `page ${spec.n}: ink in the top band`).not.toBeNull();
      expect(ink!.aspect, `page ${spec.n}: "Page ${spec.n}" is horizontal text (aspect ${ink!.aspect.toFixed(2)})`).toBeGreaterThan(2);
      expect(ink!.left, `page ${spec.n}: the label starts at the left`).toBeLessThan(0.15);
      expect(ink!.right, `page ${spec.n}: the label ends before the middle of the page (right edge at ${ink!.right.toFixed(2)})`).toBeLessThan(0.5);
      expect(ink!.bottom * 0.3, `page ${spec.n}: the label is in the top fifth of the page`).toBeLessThan(0.2);
      // 3. Nothing else dark in the top-right or bottom-right (the places a label would land if the page were turned the wrong way).
      const otherCorners = [
        { x: rect.x + rect.width * 0.55, y: rect.y, width: rect.width * 0.45, height: rect.height * 0.3 },
        { x: rect.x + rect.width * 0.55, y: rect.y + rect.height * 0.7, width: rect.width * 0.45, height: rect.height * 0.3 },
      ];
      for (const corner of otherCorners) expect(inkBox(s.img, s.ratio, corner, 128), `page ${spec.n}: no ink in a far corner`).toBeNull();
    }
    await snap(page, testInfo, '05-rotated-last-page');
  }, 60_000);
  await step('the engine and the layout agree about the rotated page: unrotated size, /Rotate 90, shown landscape', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.mixed)));
    await waitForFirstPage(page);
    const doc = await rt(page).doc();
    expect(doc!.pages[2], 'page 3 is a Letter page with /Rotate 90').toEqual({ width: 612, height: 792, rotation: 90 });
    const boxes = await rt(page).pageBoxes();
    expect(boxes).toHaveLength(MIXED_PAGES.length);
    const b = boxes[2];
    expect(b.width, 'the page is laid out 792 wide ...').toBeGreaterThan(b.height);
    expect(b.width / b.height).toBeCloseTo(792 / 612, 2);
    expect(boxes[0].width / boxes[0].height, 'while page 1 stays portrait').toBeCloseTo(612 / 792, 2);
    // Pages are stacked top to bottom without overlapping, in order.
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].top, `page ${i + 1} starts below page ${i}`).toBeGreaterThanOrEqual(boxes[i - 1].top + boxes[i - 1].height);
  }, 60_000);
});
