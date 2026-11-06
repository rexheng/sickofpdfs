// Walkthrough: "Zoom in Chrome's ways" and keep the reading position.
// Spec, Reading basics / Zoom: "Fit width, fit page, 25 to 400%; Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+wheel and pinch zoom the
// page, not the browser". Shortcuts: "Ctrl+= and Ctrl++ both zoom in"; "Zoom in / out / fit width = Ctrl+= / Ctrl+- / Ctrl+0".
// Engine: "Zoom steps, fit modes ... follow Chromium's open-source viewer"; "re-render sharply at any zoom or Windows scaling".
// Interface file: ZOOM_STEPS (the Chromium presets), wheelZoom = clamp(scale * exp(-deltaPx / 400)), "keys and wheel keep the
// page-space point under the pointer (keys: the viewport centre) fixed", canvas backing = round(cssW * dpr) x round(cssH * dpr).
//
// "Keeping the reading position" is measured as: the point of the page that was under the pointer (or at the centre of the
// view, for keys) before the zoom is still under it after.
import { FIXTURES, ensureBook, served } from './support/fixtures.spec-blind';
import { edgeWidth, readStrip } from './support/pixels.spec-blind';
import { chooseFitPage, ctrlWheel, expect, note, rt, scrollerRect, settled, shoot, snap, test, viewportCentre, waitForFirstPage, waitForPageOnScreen } from './support/viewer.spec-blind';
import type { Page } from '@playwright/test';

const ZOOM_STEPS = [0.25, 0.333, 0.5, 0.666, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const nextUp = (s: number) => ZOOM_STEPS.find((z) => z > s + 1e-3) ?? 4;
const nextDown = (s: number) => [...ZOOM_STEPS].reverse().find((z) => z < s - 1e-3) ?? 0.25;
const clamp = (s: number) => Math.min(4, Math.max(0.25, s));
const PT_TO_CSS = 96 / 72;

test.beforeAll(async () => {
  await ensureBook();
});

/** The book, scrolled to the middle of page 25, so that zooming in or out has room on both sides. */
async function openMidBook(page: Page): Promise<void> {
  await waitForFirstPage(page);
  await rt(page).scrollToPage(24);
  const c = await viewportCentre(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, 300);
  await settled(() => rt(page).scrollTop(), 1);
  await waitForPageOnScreen(page, 25).catch(() => {}); // the page is drawn before we start to zoom
}

/**
 * After a zoom, the page point that was at `at` must be at `at` again: always vertically, and sideways whenever the view could
 * have been scrolled sideways far enough to do it (a page narrower than the window is centred, so its point cannot stay put).
 */
async function expectReadingPositionKept(page: Page, anchor: { pageIndex: number; x: number; y: number }, at: { x: number; y: number }, what: string): Promise<void> {
  await expect
    .poll(async () => Math.abs((await rt(page).clientPointOf(anchor)).y - at.y), { message: `${what}: the point under the pointer moved vertically`, timeout: 3_000 })
    .toBeLessThanOrEqual(3);
  await expect
    .poll(
      async () => {
        const now = await rt(page).clientPointOf(anchor);
        const room = await page.evaluate(() => {
          const sc = document.querySelector('[role="document"]')!;
          return { left: sc.scrollLeft, max: sc.scrollWidth - sc.clientWidth };
        });
        const wanted = room.left + (now.x - at.x); // the scroll position that would put the point back
        return wanted >= -2 && wanted <= room.max + 2 ? Math.abs(now.x - at.x) : 0; // not reachable by scrolling: nothing to ask
      },
      { message: `${what}: the point under the pointer moved sideways although the view could have followed it`, timeout: 3_000 },
    )
    .toBeLessThanOrEqual(3);
}

async function anchorAt(page: Page, at: { x: number; y: number }) {
  const anchor = await rt(page).pdfPointAt(at.x, at.y);
  expect(anchor, `the point (${at.x}, ${at.y}) is on a page`).not.toBeNull();
  return anchor!;
}

test('Zooming: Ctrl+plus and minus, Ctrl+wheel, fit width, fit page, the 25% and 400% limits, and a sharp redraw', async ({ step }, testInfo) => {
  test.setTimeout(420_000);
  await step('Ctrl+= and Ctrl++ zoom in one Chromium step, keeping the reading position', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);
    await page.keyboard.press('Control+0'); // start from a known mode
    const centre = await viewportCentre(page);
    await snap(page, testInfo, '03-before-zoom-in');

    for (const combo of ['Control+=', 'Control++', 'Control+=']) {
      const before = await settled(() => rt(page).scale());
      const anchor = await anchorAt(page, centre);
      await page.keyboard.press(combo);
      const want = nextUp(before);
      await expect.poll(() => rt(page).scale(), { message: `${combo} from ${before.toFixed(3)} should give ${want}` }).toBeCloseTo(want, 2);
      await expectReadingPositionKept(page, anchor, centre, combo);
      expect((await rt(page).snapshot()).zoom, 'a zoom step leaves fit mode').toMatchObject({ kind: 'scale' });
    }
    await snap(page, testInfo, '03-after-zoom-in');
  }, 60_000);
  await step('Ctrl+- zooms out one Chromium step, keeping the reading position', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);
    await page.keyboard.press('Control+0');
    const centre = await viewportCentre(page);

    for (let i = 0; i < 3; i++) {
      const before = await settled(() => rt(page).scale());
      const anchor = await anchorAt(page, centre);
      await page.keyboard.press('Control+-');
      const want = nextDown(before);
      await expect.poll(() => rt(page).scale(), { message: `Ctrl+- from ${before.toFixed(3)} should give ${want}` }).toBeCloseTo(want, 2);
      await expectReadingPositionKept(page, anchor, centre, 'Ctrl+-');
    }
    await snap(page, testInfo, '03-after-zoom-out');
  }, 60_000);
  await step('Ctrl+wheel zooms the page, around the pointer, and not the browser', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);
    await page.keyboard.press('Control+-'); // some room to zoom in both ways
    await page.keyboard.press('Control+-');
    await settled(() => rt(page).scale());
    const centre = await viewportCentre(page);
    const pointer = { x: centre.x - 220, y: centre.y + 120 };
    const browserBefore = await page.evaluate(() => ({ dpr: window.devicePixelRatio, pinch: window.visualViewport?.scale ?? 1 }));

    for (const deltaY of [-120, -120, 200, 80]) {
      const before = await settled(() => rt(page).scale());
      const anchor = await anchorAt(page, pointer);
      await ctrlWheel(page, pointer.x, pointer.y, deltaY);
      const want = clamp(before * Math.exp(-deltaY / 400)); // interface: wheelZoom
      await expect
        .poll(async () => (await rt(page).scale()) / want, { message: `Ctrl+wheel ${deltaY} from ${before.toFixed(3)} should give about ${want.toFixed(3)}`, timeout: 3_000 })
        .toBeGreaterThan(0.95);
      expect((await rt(page).scale()) / want).toBeLessThan(1.05);
      await expectReadingPositionKept(page, anchor, pointer, `Ctrl+wheel ${deltaY}`);
    }
    await snap(page, testInfo, '03-after-ctrl-wheel');
    const browserAfter = await page.evaluate(() => ({ dpr: window.devicePixelRatio, pinch: window.visualViewport?.scale ?? 1 }));
    expect(browserAfter, 'Chrome\'s own page zoom did not change').toEqual(browserBefore);
  }, 60_000);
  await step('Ctrl+0 is fit width: the page fills the width and nothing scrolls sideways', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+=');
    await settled(() => rt(page).scale());
    const centre = await viewportCentre(page);
    const anchor = await anchorAt(page, centre);

    await page.keyboard.press('Control+0');
    await expect.poll(async () => (await rt(page).snapshot()).zoom.kind, { message: 'Ctrl+0 selects fit width' }).toBe('fit-width');
    await settled(() => rt(page).scale());
    const box = (await rt(page).pageBoxes())[anchor.pageIndex];
    const view = await page.evaluate(() => {
      const s = document.querySelector('[role="document"]')!;
      return { clientWidth: s.clientWidth, scrollWidth: s.scrollWidth };
    });
    expect(view.scrollWidth, 'no sideways scrolling at fit width').toBeLessThanOrEqual(view.clientWidth + 1);
    expect(box.width, 'the page fills most of the width').toBeGreaterThan(view.clientWidth * 0.85);
    expect(box.width).toBeLessThanOrEqual(view.clientWidth + 1);
    // Units: scale 1 is 100%, which is 96 / 72 CSS px per point.
    expect(box.width).toBeCloseTo(612 * (await rt(page).scale()) * PT_TO_CSS, 0);
    await expectReadingPositionKept(page, anchor, centre, 'Ctrl+0');
    await snap(page, testInfo, '03-fit-width');
  }, 60_000);
  await step('zoom stops at 25% and at 400%, and the page is still drawn there', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);

    for (let i = 0; i < 20; i++) await page.keyboard.press('Control+-');
    await expect.poll(() => rt(page).scale(), { message: 'Ctrl+- stops at the 25% preset' }).toBeCloseTo(0.25, 3);
    await page.keyboard.press('Control+-');
    await settled(() => rt(page).scale());
    expect(await rt(page).scale(), 'no zoom below 25%').toBeCloseTo(0.25, 3);
    await snap(page, testInfo, '03-zoom-25');
    const small = await shoot(page);
    expect(small.canvases.length, 'several small pages are on screen at 25%').toBeGreaterThanOrEqual(2);

    for (let i = 0; i < 25; i++) await page.keyboard.press('Control+=');
    await expect.poll(() => rt(page).scale(), { message: 'Ctrl+= stops at the 400% preset' }).toBeCloseTo(4, 3);
    await page.keyboard.press('Control+=');
    await settled(() => rt(page).scale());
    expect(await rt(page).scale(), 'no zoom above 400%').toBeCloseTo(4, 3);
    // At 400% a page is 3264 px wide: the view must scroll sideways, and the drawn part must be a page, not a blank.
    await page.evaluate(() => {
      document.querySelector('[role="document"]')!.scrollLeft = 0;
    });
    await rt(page).scrollToPage(24);
    // (The page-number strip is wider than the window at 400%, so look at the edge of its first square instead: a drawn page has it.)
    await expect
      .poll(async () => {
        const s = await shoot(page);
        const c = s.canvases.find((k) => k.page === 24);
        return c ? edgeWidth(s.img, s.ratio, { x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight }, s.scroller, 0) : null;
      }, { message: 'at 400% the page was never drawn', timeout: 8_000 })
      .not.toBeNull();
    await snap(page, testInfo, '03-zoom-400');
  }, 60_000);
  await step('Fit page shows one whole page, top to bottom', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);
    await chooseFitPage(page);
    await expect.poll(async () => (await rt(page).snapshot()).zoom.kind, { message: 'the viewer is in fit-page mode' }).toBe('fit-page');
    await settled(() => rt(page).scale());
    // Whether the page is lined up with the top of the window by itself is not in the spec, so it is recorded, not judged; the
    // reader goes to the page (as Page Down would) and then must see all of it.
    const before = await rt(page).scrollTop();
    const centre = await viewportCentre(page);
    const here = (await rt(page).pdfPointAt(centre.x, centre.y))?.pageIndex ?? 24;
    await rt(page).scrollToPage(here);
    note(testInfo, 'fit page lined the page up by itself', String(Math.abs(before - (await rt(page).scrollTop())) <= 20));
    await settled(() => rt(page).scrollTop(), 1);
    const view = await scrollerRect(page);
    const boxes = await rt(page).pageBoxes();
    const box = boxes.find((b) => b.index === here)!;
    expect(box.height, 'a whole page fits in the view').toBeLessThanOrEqual(view.height + 1);
    expect(box.height, 'and fills most of it').toBeGreaterThan(view.height * 0.8);
    expect(box.width).toBeLessThanOrEqual(view.width + 1);
    // Both the top and the bottom strip of the same page can be read on screen at once.
    await expect
      .poll(async () => {
        const s = await shoot(page);
        const c = s.canvases.find((k) => k.page === box.index);
        if (!c) return null;
        const r = { x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight };
        const top = readStrip(s.img, s.ratio, r, s.scroller, 0);
        const bottom = readStrip(s.img, s.ratio, r, s.scroller, 2);
        return top !== null && top === bottom ? top : null;
      }, { message: 'the whole page (its top and bottom strips) can be read at once', timeout: 6_000 })
      .not.toBeNull();
    await snap(page, testInfo, '03-fit-page');
  }, 60_000);
  await step('after zooming, the page is redrawn sharply, not a stretched picture', async ({ openViewer, server }) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);
    await page.keyboard.press('Control+0');
    for (const target of [2, 3, 4]) {
      while ((await settled(() => rt(page).scale())) < target - 1e-3) await page.keyboard.press('Control+=');
      await page.evaluate(() => {
        document.querySelector('[role="document"]')!.scrollLeft = 0;
      });
      await rt(page).scrollToPage(24);
      // The first strip of page 25 has a hard black-to-white edge. Wherever it is, it must be a few pixels wide at most.
      await expect
        .poll(async () => {
          const s = await shoot(page);
          const c = s.canvases.find((k) => k.page === 24);
          if (!c) return null;
          return edgeWidth(s.img, s.ratio, { x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight }, s.scroller, 0);
        }, { message: `at ${target * 100}% the page edge never became sharp`, timeout: 6_000 })
        .toBeLessThanOrEqual(3);
      await snap(page, testInfo, `03-sharp-at-${target * 100}`);
    }
  }, 60_000);
});

test.describe('Windows scaling at 150%', () => {
  test.use({ deviceScaleFactor: 1.5 });

  test('every page canvas has round(width x 1.5) by round(height x 1.5) pixels (to within one), at every zoom, and the page is sharp', async ({ openViewer, server }, testInfo) => {
    const page = await openViewer(server.url(served(FIXTURES.book)));
    await openMidBook(page);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.5);
    for (const key of ['Control+0', 'Control+=', 'Control+=', 'Control+-']) {
      await page.keyboard.press(key);
      await settled(() => rt(page).scale());
      await expect
        .poll(async () => {
          const s = await shoot(page);
          const bad = s.canvases.filter((c) => Math.abs(c.backingWidth - Math.round(c.cssWidth * 1.5)) > 1 || Math.abs(c.backingHeight - Math.round(c.cssHeight * 1.5)) > 1);
          return bad.map((c) => `page ${c.page + 1}: backing ${c.backingWidth}x${c.backingHeight} for ${c.cssWidth.toFixed(1)}x${c.cssHeight.toFixed(1)} css px`);
        }, { message: `after ${key}`, timeout: 4_000 })
        .toEqual([]);
    }
    await page.evaluate(() => {
      document.querySelector('[role="document"]')!.scrollLeft = 0;
    });
    await rt(page).scrollToPage(24);
    await expect
      .poll(async () => {
        const s = await shoot(page);
        const c = s.canvases.find((k) => k.page === 24);
        if (!c) return null;
        return edgeWidth(s.img, s.ratio, { x: c.x, y: c.y, width: c.cssWidth, height: c.cssHeight }, s.scroller, 0);
      }, { message: 'at 150% scaling the page edge never became sharp', timeout: 6_000 })
      .toBeLessThanOrEqual(4);
    await snap(page, testInfo, '03-hidpi');
  });
});
