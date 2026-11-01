// User tests for Task 22: a two-column paper. Dragging down the left column must not swallow the right one, and a drag
// from one column into the other follows reading order (the rest of the left column, then the start of the right).
// Spec: "It must handle two-column papers, rotated tables, ligatures, inline maths and right-to-left text" (Text layer);
// risk table: "Text layer misaligned or in the wrong order - Selecting feels broken".
import type { Glyph } from '../../packages/viewer/src/backend/types';
import { expect, test } from '../support/test';
import { copyProblems, squash } from '../support/tl-copy.spec-blind';
import {
  centreOf,
  clearSelection,
  copySelection,
  dragClient,
  dragGlyphs,
  fixture,
  glyphsOf,
  inclusive,
  isVisible,
  openClipboardReader,
  openFixture,
  pageMap,
  rangeText,
  readSelection,
  type CharRange,
} from '../support/tl-blind.spec-blind';

test.setTimeout(120_000);

interface Layout {
  glyphs: Glyph[];
  left: Glyph[][];
  right: Glyph[][];
  /** The gutter, in points. */
  gutter: { from: number; to: number };
}

/** Lines of glyphs in index order: a new line starts when the vertical centre moves by more than half a font size. */
function lines(gs: Glyph[]): Glyph[][] {
  const out: Glyph[][] = [];
  let cy = Number.NaN;
  for (const g of gs) {
    const y = g.box.y + g.box.height / 2;
    if (out.length === 0 || Math.abs(y - cy) > 0.5 * g.fontSize) {
      out.push([g]);
      cy = y;
    } else out[out.length - 1].push(g);
  }
  return out;
}

function layout(glyphs: Glyph[], pageWidth: number): Layout {
  const visible = glyphs.filter(isVisible);
  const mid = pageWidth / 2;
  const left = visible.filter((g) => g.box.x + g.box.width / 2 < mid);
  const right = visible.filter((g) => g.box.x + g.box.width / 2 >= mid);
  // Fixture sanity: PDFium reads the left column first, then the right.
  expect(Math.max(...left.map((g) => g.index)), 'PDFium numbers the whole left column before the right one').toBeLessThan(Math.min(...right.map((g) => g.index)));
  return {
    glyphs,
    left: lines(left),
    right: lines(right),
    gutter: { from: Math.max(...left.map((g) => g.box.x + g.box.width)), to: Math.min(...right.map((g) => g.box.x)) },
  };
}

const mid = (line: Glyph[]) => line[Math.floor(line.length / 2)];
const inColumn = (g: Glyph, column: Glyph[][]) => column.some((l) => l.includes(g));

async function setup(openViewer: Parameters<typeof openFixture>[0], server: Parameters<typeof openFixture>[1]) {
  const o = await openFixture(openViewer, server, fixture('two-column'));
  const glyphs = await glyphsOf(o.page, o.pageIndex);
  return { o, ...layout(glyphs, 612) };
}

const selectedGlyphs = (glyphs: Glyph[], ranges: CharRange[]) => ranges.flatMap((r) => glyphs.slice(r.start, r.end)).filter(isVisible);

test('dragging down the left column selects only left-column text', async ({ openViewer, server }, testInfo) => {
  const { o, glyphs, left, right, gutter } = await setup(openViewer, server);
  expect(left.length).toBeGreaterThan(15);
  const first = left[0][0];
  const target = left[12];

  // 1. Straight down, ending on a glyph of the 13th line.
  let drag = await dragGlyphs(o.page, o.pageIndex, first.index, mid(target).index);
  expect(drag.ranges).toEqual([inclusive(o.pageIndex, first.index, mid(target).index)]);
  expect(selectedGlyphs(glyphs, drag.ranges).every((g) => inColumn(g, left)), 'every selected glyph is in the left column').toBe(true);
  expect(squash(drag.domText)).toBe(squash(await rangeText(o.page, o.pageIndex, first.index, mid(target).index + 1)));

  // 2. The hand drifts right of the end of the line, into the gutter, while going down. Still the left column.
  await clearSelection(o.page);
  const map = await pageMap(o.page, o.pageIndex);
  const lineY = centreOf(map, mid(target)).y;
  const gutterX = map.toClient(gutter.from + 0.2 * (gutter.to - gutter.from), 0).x;
  await dragClient(o.page, centreOf(map, first), { x: gutterX, y: lineY });
  drag = await readSelection(o.page);
  await o.page.screenshot({ path: testInfo.outputPath('t22-left-column-drag-into-gutter.png') });
  expect(drag.ranges.length).toBe(1);
  const picked = selectedGlyphs(glyphs, drag.ranges);
  expect(picked.length).toBeGreaterThan(0);
  expect(picked.some((g) => inColumn(g, right)), 'nothing from the right column was swallowed').toBe(false);
  const endLine = left.findIndex((l) => l.includes(picked[picked.length - 1]));
  expect(Math.abs(endLine - 12), 'the selection ends on the line the pointer was level with (give or take one)').toBeLessThanOrEqual(1);
  expect(drag.ranges[0].start).toBe(first.index);

  // 3. The same in the right column.
  await clearSelection(o.page);
  const rFirst = right[0][0];
  const rTarget = mid(right[5]);
  drag = await dragGlyphs(o.page, o.pageIndex, rFirst.index, rTarget.index);
  expect(drag.ranges).toEqual([inclusive(o.pageIndex, rFirst.index, rTarget.index)]);
  expect(selectedGlyphs(glyphs, drag.ranges).some((g) => inColumn(g, left))).toBe(false);
  expect(o.errors).toEqual([]);
});

test('dragging across the column break follows reading order', async ({ openViewer, server, context }, testInfo) => {
  const reader = await openClipboardReader(context, server);
  const { o, glyphs, left, right } = await setup(openViewer, server);

  // Sideways: from the 4th line of the left column to the 4th line of the right. Reading order says: the rest of the
  // left column, then the right column down to its 4th line. Nothing above the start, nothing below the end.
  const a = mid(left[3]);
  const b = mid(right[3]);
  let drag = await dragGlyphs(o.page, o.pageIndex, a.index, b.index);
  await o.page.screenshot({ path: testInfo.outputPath('t22-across-columns.png') });
  expect(drag.ranges, 'one range, from the left-column glyph to the right-column glyph').toEqual([inclusive(o.pageIndex, a.index, b.index)]);
  const picked = selectedGlyphs(glyphs, drag.ranges);
  expect(picked.some((g) => g.index < a.index)).toBe(false);
  expect(picked.some((g) => inColumn(g, left) && left.findIndex((l) => l.includes(g)) < 3), 'no left-column line above the start').toBe(false);
  expect(picked.some((g) => inColumn(g, right) && right.findIndex((l) => l.includes(g)) > 3), 'no right-column line below the end').toBe(false);
  const copied = await copySelection(o.page, reader);
  expect(copyProblems(glyphs, a.index, b.index + 1, copied), copied).toEqual([]);
  expect(squash(copied)).toBe(squash(await rangeText(o.page, o.pageIndex, a.index, b.index + 1)));

  // At the break itself: the middle of the last left line to the middle of the first right line.
  await clearSelection(o.page);
  const lastLeft = mid(left[left.length - 1]);
  const firstRight = mid(right[0]);
  drag = await dragGlyphs(o.page, o.pageIndex, lastLeft.index, firstRight.index);
  expect(drag.ranges).toEqual([inclusive(o.pageIndex, lastLeft.index, firstRight.index)]);
  const selected = selectedGlyphs(glyphs, drag.ranges);
  expect(selected.every((g) => (inColumn(g, left) && left.length - 1 === left.findIndex((l) => l.includes(g))) || (inColumn(g, right) && right[0].includes(g))), 'only the two lines either side of the break').toBe(true);

  // The same drag the other way round (from the right column back to the left) selects the same range.
  await clearSelection(o.page);
  drag = await dragGlyphs(o.page, o.pageIndex, b.index, a.index);
  expect(drag.ranges).toEqual([inclusive(o.pageIndex, a.index, b.index)]);
  await reader.close();
});
