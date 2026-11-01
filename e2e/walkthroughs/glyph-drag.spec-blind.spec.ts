// User tests for Task 22, R27: a drag that starts or ends part-way across a glyph includes that glyph, the way
// Chrome's own PDF viewer selects. Native browser selection puts each end at the nearest caret, so a press on the right
// half of a letter would leave it out (the Phase 0 report: 0 to 8 of 20 drags came out exact).
// Spec: carried requirement R27; the interface file's dragSelect ("mouse down at glyphCenter(a), up at glyphCenter(b)").
import type { Glyph } from '../../packages/viewer/src/backend/types';
import { expect, test } from '../support/test';
import {
  centreOf,
  clearSelection,
  dragClient,
  dragGlyphs,
  fixture,
  glyphsOf,
  inclusive,
  isVisible,
  openFixture,
  pageMap,
  pointIn,
  readSelection,
  rangeText,
  seededPairs,
  setZoom,
  th,
  type CharRange,
  VIEW_200,
  VIEW_200_WIDE,
} from '../support/tl-blind.spec-blind';
import { collapse } from '../support/tl-copy.spec-blind';

test.setTimeout(180_000);

const same = (got: CharRange[], want: CharRange) => got.length === 1 && got[0].pageIndex === want.pageIndex && got[0].start === want.start && got[0].end === want.end;
const describeFail = (a: number, b: number, mode: string, got: CharRange[], glyphs: Glyph[]) =>
  `${mode} a=${a} "${glyphs[a].text}" b=${b} "${glyphs[b].text}": wanted [${Math.min(a, b)}, ${Math.max(a, b) + 1}) got ${JSON.stringify(got.map((r) => [r.start, r.end]))}`;

// Press and release positions inside a glyph's box, as fractions of its width from the left. Upright pages only.
const MODES = [
  { name: 'right half of the first glyph to left half of the last', pa: 0.85, pb: 0.15 },
  { name: 'left edge to right edge', pa: 0.08, pb: 0.92 },
  { name: 'both on the right half', pa: 0.8, pb: 0.8 },
  { name: 'both on the left half', pa: 0.2, pb: 0.2 },
];

test('a drag that starts or ends part-way across a glyph includes that glyph', async ({ openViewer, server }, testInfo) => {
  const failures: string[] = [];
  let tried = 0;
  for (const name of ['two-column', 'resnet-p1', 'attention-p1']) {
    const o = await openFixture(openViewer, server, fixture(name));
    const glyphs = await glyphsOf(o.page, o.pageIndex);
    const pool = glyphs.filter(isVisible).map((g) => g.index);
    const map = await pageMap(o.page, o.pageIndex);
    const pairs = seededPairs(pool, 12, `r27-${name}`);
    for (const [i, [a, b]] of pairs.entries()) {
      const mode = MODES[i % MODES.length];
      // Forward (a before b) and backward (press on the later glyph), same pair.
      for (const [from, to] of [[Math.min(a, b), Math.max(a, b)], [Math.max(a, b), Math.min(a, b)]] as const) {
        await clearSelection(o.page);
        // Forwards, the press is on the right of the earlier glyph and the release on the left of the later one. Backwards,
        // the press is on the left of the later glyph and the release on the right of the earlier one: the same stress, mirrored.
        const forward = from < to;
        await dragClient(o.page, pointIn(map, glyphs[from], forward ? mode.pa : mode.pb), pointIn(map, glyphs[to], forward ? mode.pb : mode.pa));
        const { ranges } = await readSelection(o.page);
        tried++;
        if (!same(ranges, inclusive(o.pageIndex, a, b))) failures.push(`${name}: ${describeFail(from, to, mode.name, ranges, glyphs)}`);
      }
    }
    if (name === 'resnet-p1') await o.page.screenshot({ path: testInfo.outputPath('t22-r27-last-drag.png') });
    await o.page.close();
  }
  expect(tried).toBe(3 * 12 * 2);
  expect(failures, `${failures.length} of ${tried} part-glyph drags missed a glyph or added one`).toEqual([]);
});

test('drags between glyph centres select the glyphs and read as the engine reads them, at 100% and 200%, on an upright and a turned page', async ({ openViewer, server }, testInfo) => {
  const failures: string[] = [];
  let tried = 0;
  for (const [name, zoom] of [['two-column', 1], ['two-column', 2], ['ligatures', 1], ['rtl', 1], ['rotated-page', 1], ['rotated-page', 2], ['maths', 1]] as const) {
    const o = await openFixture(openViewer, server, fixture(name));
    if (zoom !== 1) {
      await o.page.setViewportSize(name === 'rotated-page' ? VIEW_200_WIDE : VIEW_200);
      await setZoom(o.page, zoom);
      await th(o.page).eval((h, i) => h.viewer.scrollTo(i), o.pageIndex);
    }
    const glyphs = await glyphsOf(o.page, o.pageIndex);
    const pool = glyphs.filter(isVisible).map((g) => g.index);
    for (const [a, b] of seededPairs(pool, 10, `centres-${name}-${zoom}`)) {
      await clearSelection(o.page);
      const { ranges, domText } = await dragGlyphs(o.page, o.pageIndex, a, b);
      tried++;
      const want = inclusive(o.pageIndex, a, b);
      if (!same(ranges, want)) {
        failures.push(`${name}@${zoom * 100}%: ${describeFail(a, b, 'centre to centre', ranges, glyphs)}`);
        continue;
      }
      // The browser's own selection holds the same letters (find and screen readers read it).
      const engine = collapse(await rangeText(o.page, o.pageIndex, want.start, want.end)).replace(/\s/gu, '');
      if (collapse(domText).replace(/\s/gu, '') !== engine) {
        failures.push(`${name}@${zoom * 100}%: the DOM selection text differs from the engine's for [${want.start}, ${want.end})`);
      }
    }
    await o.page.screenshot({ path: testInfo.outputPath(`t22-drag-${name}-${zoom * 100}.png`) });
    await o.page.close();
  }
  expect(failures, `${failures.length} of ${tried} drags`).toEqual([]);
});

test('glyphCenter(page, char) is where the glyph is drawn, at 100% and 200%, upright and turned', async ({ openViewer, server }) => {
  const off: string[] = [];
  for (const [name, zoom] of [['two-column', 1], ['two-column', 2], ['rotated-page', 1], ['rotated-page', 2], ['rtl', 1]] as const) {
    const o = await openFixture(openViewer, server, fixture(name));
    if (zoom !== 1) {
      await o.page.setViewportSize(name === 'rotated-page' ? VIEW_200_WIDE : VIEW_200);
      await setZoom(o.page, zoom);
      await th(o.page).eval((h, i) => h.viewer.scrollTo(i), o.pageIndex);
    }
    const glyphs = await glyphsOf(o.page, o.pageIndex);
    const map = await pageMap(o.page, o.pageIndex);
    for (const g of glyphs.filter(isVisible).filter((_, i) => i % 37 === 0)) {
      const hook = await th(o.page).eval((h, a) => h.glyphCenter(a.i, a.c), { i: o.pageIndex, c: g.index });
      const mine = centreOf(map, g);
      if (Math.hypot(hook.x - mine.x, hook.y - mine.y) > 1.5) off.push(`${name}@${zoom * 100}% glyph ${g.index} "${g.text}": hook ${hook.x.toFixed(1)},${hook.y.toFixed(1)} vs box centre ${mine.x.toFixed(1)},${mine.y.toFixed(1)}`);
    }
    await o.page.close();
  }
  expect(off).toEqual([]);
});
