// User tests for Task 22, R44: the owner complained that the selection highlight looked messy and uneven. The highlight
// must be painted from an overlay (PDFium's merged line rectangles), not by the browser: lines of the same height, no two
// lines overlapping, edges that follow the text, one colour with no darker bands, and the browser's own ::selection
// invisible. The judge reads a real screenshot, so it holds for any way of drawing the overlay.
// Spec: carried requirement R44 (selection painting); "Take screenshots at 100% and 200%".
import { expect, test } from '../support/test';
import {
  clearSelection,
  describePaint,
  dragGlyphs,
  findOnPage,
  fixture,
  glyphsOf,
  isVisible,
  judgePainting,
  openFixture,
  readSelection,
  setZoom,
  th,
  VIEW_100_WIDE,
  VIEW_200,
  VIEW_200_WIDE,
  type Opened,
} from '../support/tl-blind.spec-blind';

test.setTimeout(150_000);

/** Drags over the text from `from` to the end of `to` (both found with the engine's search) and returns the glyph range. */
async function selectPassage(o: Opened, from: string, to: string): Promise<{ a: number; b: number }> {
  const first = await findOnPage(o.page, o.pageIndex, from);
  const last = await findOnPage(o.page, o.pageIndex, to);
  const a = first.start;
  const b = last.start + last.count - 1;
  const { ranges } = await dragGlyphs(o.page, o.pageIndex, a, b);
  expect(ranges, 'the drag selected the passage').toEqual([{ pageIndex: o.pageIndex, start: a, end: b + 1 }]);
  return { a, b };
}

const RESNET = { from: 'Deeper neural networks are more difficult', to: 'and 1000 layers.' };

for (const zoom of [1, 2]) {
  test(`the ResNet abstract highlight is clean at ${zoom * 100}%`, async ({ openViewer, server }, testInfo) => {
    const o = await openFixture(openViewer, server, fixture('resnet-p1'), { scale: zoom, ...(zoom === 2 ? { viewport: VIEW_200 } : {}) });
    await selectPassage(o, RESNET.from, RESNET.to);
    const report = await judgePainting(o.page, testInfo, o.pageIndex, `t22-resnet-abstract-selected-${zoom * 100}.png`);
    testInfo.annotations.push({ type: 'painting', description: describePaint(report) });
    expect(report.lineCount, 'the abstract is several lines').toBeGreaterThan(8);
    expect(report.lines.length, 'every line the engine reports is painted').toBe(report.lineCount);
    expect(report.problems, describePaint(report)).toEqual([]);
    expect(o.errors).toEqual([]);
  });
}

test('the Attention abstract (one wide column, hyphenated line end) is painted clean at 100%', async ({ openViewer, server }, testInfo) => {
  const o = await openFixture(openViewer, server, fixture('attention-p1'));
  await selectPassage(o, 'The dominant sequence transduction models', 'limited training data.');
  const report = await judgePainting(o.page, testInfo, o.pageIndex, 't22-attention-abstract-selected-100.png');
  expect(report.lineCount).toBeGreaterThan(10);
  expect(report.problems, describePaint(report)).toEqual([]);
});

test('lines of different sizes (a heading over body text) are each painted to their own size, with no overlap', async ({ openViewer, server }, testInfo) => {
  const o = await openFixture(openViewer, server, fixture('attention-p1'));
  // The "Abstract" heading (12 pt) and the first lines of the 10 pt abstract under it.
  await selectPassage(o, 'Abstract', 'based solely on attention mechanisms,');
  const report = await judgePainting(o.page, testInfo, o.pageIndex, 't22-heading-and-body-selected.png');
  const sizes = new Set(report.lines.map((l) => l.fontSize));
  expect(sizes.size, 'the selection holds two font sizes').toBeGreaterThanOrEqual(2);
  expect(report.problems, describePaint(report)).toEqual([]);
});

test('the browser\'s own ::selection is invisible while the DOM selection is kept', async ({ openViewer, server }) => {
  const o = await openFixture(openViewer, server, fixture('two-column'));
  const glyphs = await glyphsOf(o.page, o.pageIndex);
  const visible = glyphs.filter(isVisible);
  const { ranges, domText } = await dragGlyphs(o.page, o.pageIndex, visible[0].index, visible[60].index);
  expect(ranges.length).toBe(1);
  expect(domText.length, 'the DOM selection still holds the text, for copy, find and screen readers').toBeGreaterThan(30);

  const css = await o.page.evaluate(() => {
    const span = document.querySelector('[data-page-index="0"] [data-start]')!;
    const own = getComputedStyle(span, '::selection');
    // Every ::selection rule the page's style sheets declare that sets a background, as the browser parsed it.
    const rules: { selector: string; background: string }[] = [];
    const visit = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes('::selection') && rule.style.backgroundColor !== '') {
          rules.push({ selector: rule.selectorText, background: rule.style.backgroundColor });
        } else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        /* a sheet the page may not read */
      }
    }
    return { background: own.backgroundColor, rules };
  });
  const transparent = /^(transparent|rgba\(0, 0, 0, 0\))$/u;
  // Triage (TB1): the build's CSS minifier writes `background: transparent` as `background: 0 0`, whose colour is `initial`,
  // which is transparent. The computed check below is the one that matters.
  const transparentRule = /^(transparent|rgba\(0, 0, 0, 0\)|initial)$/u;
  expect(css.rules.some((r) => transparentRule.test(r.background)), `a ::selection rule sets the background to transparent (rules seen: ${JSON.stringify(css.rules)})`).toBe(true);
  expect(css.background, 'the computed ::selection background on a text span').toMatch(transparent);
});

test('a selection made at 100% is still painted right after zooming to 200% and back', async ({ openViewer, server }, testInfo) => {
  const o = await openFixture(openViewer, server, fixture('resnet-p1'));
  const { a, b } = await selectPassage(o, RESNET.from, RESNET.to);
  const before = await judgePainting(o.page, testInfo, o.pageIndex, 't22-zoom-before-100.png');
  expect(before.problems, describePaint(before)).toEqual([]);

  await o.page.setViewportSize(VIEW_200);
  await setZoom(o.page, 2);
  await th(o.page).eval((h, i) => h.viewer.scrollTo(i), o.pageIndex);
  await o.page.waitForTimeout(500);
  expect((await readSelection(o.page)).ranges, 'zooming keeps the selection').toEqual([{ pageIndex: o.pageIndex, start: a, end: b + 1 }]);
  const zoomed = await judgePainting(o.page, testInfo, o.pageIndex, 't22-zoom-after-200.png');
  expect(zoomed.problems, describePaint(zoomed)).toEqual([]);
  expect(zoomed.lines[0].thickness, 'the bands are twice as thick at twice the size').toBeGreaterThan(1.7 * before.lines[0].thickness);

  await o.page.setViewportSize({ width: 1100, height: 1160 });
  await setZoom(o.page, 1);
  await th(o.page).eval((h, i) => h.viewer.scrollTo(i), o.pageIndex);
  await o.page.waitForTimeout(500);
  const back = await judgePainting(o.page, testInfo, o.pageIndex, 't22-zoom-back-100.png');
  expect(back.problems, describePaint(back)).toEqual([]);

  // A fresh drag after the zoom lands on the glyphs under the pointer (the layer moved with the page).
  await clearSelection(o.page);
  await o.page.setViewportSize({ width: 1400, height: 1700 });
  await setZoom(o.page, 1.5);
  await th(o.page).eval((h, i) => h.viewer.scrollTo(i), o.pageIndex);
  await o.page.waitForTimeout(500);
  const glyphs = await glyphsOf(o.page, o.pageIndex);
  const pick = glyphs.filter(isVisible);
  const from = pick[40].index;
  const to = pick[400].index;
  const drag = await dragGlyphs(o.page, o.pageIndex, from, to);
  expect(drag.ranges).toEqual([{ pageIndex: o.pageIndex, start: from, end: to + 1 }]);
  const fresh = await judgePainting(o.page, testInfo, o.pageIndex, 't22-zoom-150-new-drag.png');
  expect(fresh.problems, describePaint(fresh)).toEqual([]);
});

test('a page turned by /Rotate 90 selects and paints along its lines, at 100% and 200%', async ({ openViewer, server }, testInfo) => {
  const o = await openFixture(openViewer, server, fixture('rotated-page'), { viewport: VIEW_100_WIDE });
  const glyphs = await glyphsOf(o.page, o.pageIndex);
  const pick = glyphs.filter(isVisible);
  const a = pick[10].index;
  const b = pick[330].index; // about nine lines of the left column
  const { ranges } = await dragGlyphs(o.page, o.pageIndex, a, b);
  expect(ranges).toEqual([{ pageIndex: o.pageIndex, start: a, end: b + 1 }]);
  const at100 = await judgePainting(o.page, testInfo, o.pageIndex, 't22-rotated-page-100.png');
  expect(at100.lineCount).toBeGreaterThan(5);
  expect(at100.problems, describePaint(at100)).toEqual([]);

  await o.page.setViewportSize(VIEW_200_WIDE);
  await setZoom(o.page, 2);
  await th(o.page).eval((h, i) => h.viewer.scrollTo(i), o.pageIndex);
  await o.page.waitForTimeout(500);
  expect((await readSelection(o.page)).ranges).toEqual([{ pageIndex: o.pageIndex, start: a, end: b + 1 }]);
  const at200 = await judgePainting(o.page, testInfo, o.pageIndex, 't22-rotated-page-200.png');
  expect(at200.problems, describePaint(at200)).toEqual([]);

  // A new drag at 200% still hits the glyphs it is aimed at.
  await clearSelection(o.page);
  const c = pick[700].index;
  const d = pick[900].index;
  expect((await dragGlyphs(o.page, o.pageIndex, c, d)).ranges).toEqual([{ pageIndex: o.pageIndex, start: c, end: d + 1 }]);
});
