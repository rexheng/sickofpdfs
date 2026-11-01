// Spec-blind table tests for the mark geometry of S7 (packages/viewer/src/marks/geometry.ts).
//
// Sources: the plan's S7 ("Conversions from PdfRect to NormRect (crop box) and from NormRect to CSS px, at any rotation.
// One SVG path per style and colour, so overlaps never darken. Underline sits at the rect's bottom, strikethrough at its
// middle, and the dotted underline uses the same rects. A hit test, and sortKey"), contracts section 1/2 (stored geometry
// is NormRect: 0-1 of the crop box, unrotated, origin top-left; engine geometry is PdfRect in points, unrotated, origin at
// the crop box's top-left; "Zoom, DPR and rotation never touch the stored numbers"), PageSize in the backend types (the
// page is shown turned by its /Rotate plus the viewer's rotation, clockwise).
//
// The function names and call shapes are not in the plan. p2-geometry-api.ts says what is guessed and finds the functions;
// the expected values here are worked out by hand from the definitions above and do not come from the code.
import { describe, expect, it } from 'vitest';
import type { Rotation } from '../backend/types';
import { expectedCss, hitTest, markPaths, normToCss, pathBox, pdfRectToNorm, sortKey, turnedPoint } from '../../test/spec-blind/p2-geometry-api';
import type { Box, NormRect, PaintMark, View } from '../../test/spec-blind/p2-geometry-api';

const near = (got: number, want: number, eps = 1e-6) => expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThan(eps);
const nearBox = (got: Box, want: Box, eps = 1e-6) => {
  near(got.x, want.x, eps);
  near(got.y, want.y, eps);
  near(got.width, want.width, eps);
  near(got.height, want.height, eps);
};

describe('PdfRect to NormRect (the crop box)', () => {
  // points on a page, and the page's crop box size: 0-1 of the crop box, origin top-left, y down
  const ROWS: { name: string; rect: [number, number, number, number]; page: [number, number]; want: NormRect }[] = [
    { name: 'the whole page', rect: [0, 0, 612, 792], page: [612, 792], want: [0, 0, 1, 1] },
    { name: 'a quarter in the top-left corner', rect: [0, 0, 100, 50], page: [200, 100], want: [0, 0, 0.5, 0.5] },
    { name: 'a line of text on a Letter page', rect: [72, 100, 468, 12], page: [612, 792], want: [72 / 612, 100 / 792, 540 / 612, 112 / 792] },
    { name: 'A4 (non-integer size)', rect: [59.5, 84.19, 238.11, 16.84], page: [595.276, 841.89], want: [59.5 / 595.276, 84.19 / 841.89, 297.61 / 595.276, 101.03 / 841.89] },
    { name: 'a crop box smaller than the media box: the page is the crop box, so a rect 50 pt in from its edge is 1/6 of 300', rect: [50, 20, 150, 40], page: [300, 400], want: [50 / 300, 20 / 400, 200 / 300, 60 / 400] },
    { name: 'a wide, short slide', rect: [360, 202.5, 72, 20.25], page: [720, 405], want: [0.5, 0.5, 0.6, 0.55] },
  ];
  it.each(ROWS)('$name', ({ rect, page, want }) => {
    const got = pdfRectToNorm({ x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, { width: page[0], height: page[1] });
    expect(got).toHaveLength(4);
    got.forEach((n, i) => near(n, want[i], 1e-9));
  });

  it('x0 < x1 and y0 < y1: a NormRect is corners, not a position and a size', () => {
    const [x0, y0, x1, y1] = pdfRectToNorm({ x: 10, y: 20, width: 30, height: 40 }, { width: 100, height: 200 });
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
  });
});

describe('NormRect to CSS px, at any rotation', () => {
  // A 200 x 100 pt page at 2 css px per point. norm [0.1, 0.2, 0.5, 0.6] is the box x 20..100, y 20..60 pt on the upright page.
  // Worked by hand: turned 90 clockwise the page is 200 px wide and 400 tall, and the top-left corner goes to the top-right.
  const N: NormRect = [0.1, 0.2, 0.5, 0.6];
  const HAND: { turn: Rotation; want: Box }[] = [
    { turn: 0, want: { x: 40, y: 40, width: 160, height: 80 } },
    { turn: 90, want: { x: 80, y: 40, width: 80, height: 160 } },
    { turn: 180, want: { x: 200, y: 80, width: 160, height: 80 } },
    { turn: 270, want: { x: 40, y: 200, width: 80, height: 160 } },
  ];

  it.each(HAND)('turned $turn degrees (worked by hand)', ({ turn, want }) => {
    nearBox(normToCss(N, { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: turn }), want);
  });

  // The page's own /Rotate and the viewer's turn add up
  const SUMS: [Rotation, Rotation, Rotation][] = [
    [90, 0, 90],
    [0, 90, 90],
    [90, 90, 180],
    [180, 90, 270],
    [270, 180, 90],
    [270, 90, 0],
    [180, 180, 0],
    [270, 270, 180],
  ];
  it.each(SUMS)('/Rotate %i plus a viewer turn of %i is %i', (rotation, viewRotation, turn) => {
    const view: View = { width: 200, height: 100, rotation, scale: 2, viewRotation };
    nearBox(normToCss(N, view), expectedCss(N, view, turn));
    nearBox(normToCss(N, view), HAND.find((h) => h.turn === turn)!.want);
  });

  // A grid: crop boxes (square, portrait, landscape, tiny), zooms from 25% to 400% (css px per point: 1/3 to 16/3), all four turns
  const BOXES: [number, number][] = [
    [612, 792],
    [595.276, 841.89],
    [720, 405],
    [300, 400],
  ];
  const SCALES = [1 / 3, 1, 4 / 3, 8 / 3, 16 / 3];
  const RECTS: NormRect[] = [
    [0, 0, 1, 1],
    [0.1, 0.1, 0.9, 0.12],
    [0.55, 0.7, 0.9, 0.73],
    [0.001, 0.5, 0.002, 0.51],
  ];
  const GRID = BOXES.flatMap(([w, h]) => SCALES.flatMap((s) => ([0, 90, 180, 270] as Rotation[]).flatMap((turn) => RECTS.map((r) => ({ w, h, s, turn, r })))));
  it('a grid of boxes, zooms, turns and rectangles agrees with the definition (' + GRID.length + ' cases)', () => {
    for (const { w, h, s, turn, r } of GRID) {
      const got = normToCss(r, { width: w, height: h, rotation: 0, scale: s, viewRotation: turn });
      nearBox(got, expectedCss(r, { width: w, height: h, scale: s }, turn), 1e-6);
      // a turned page is H wide and W tall: the rectangle stays inside it
      const shown = turn % 180 === 0 ? { w: w * s, h: h * s } : { w: h * s, h: w * s };
      expect(got.x).toBeGreaterThanOrEqual(-1e-6);
      expect(got.y).toBeGreaterThanOrEqual(-1e-6);
      expect(got.x + got.width).toBeLessThanOrEqual(shown.w + 1e-6);
      expect(got.y + got.height).toBeLessThanOrEqual(shown.h + 1e-6);
    }
  });

  it('the stored numbers do not change with zoom or turn: only the conversion does', () => {
    const rect = { x: 72, y: 100, width: 468, height: 12 };
    const stored = pdfRectToNorm(rect, { width: 612, height: 792 });
    for (const turn of [0, 90, 180, 270] as Rotation[]) {
      // the same line, seen at 50% and at 200% (css px per point 2/3 and 8/3): the sizes scale by 4 and the position follows
      const small = normToCss(stored, { width: 612, height: 792, rotation: 0, scale: 2 / 3, viewRotation: turn });
      const big = normToCss(stored, { width: 612, height: 792, rotation: 0, scale: 8 / 3, viewRotation: turn });
      near(big.width, small.width * 4, 1e-6);
      near(big.height, small.height * 4, 1e-6);
      near(big.x, small.x * 4, 1e-6);
      near(big.y, small.y * 4, 1e-6);
    }
  });

  it('a corner of the page goes where the turn says: top-left to top-right at 90, to bottom-right at 180, to bottom-left at 270', () => {
    const view = { width: 200, height: 100, scale: 1 };
    const tl: NormRect = [0, 0, 0.01, 0.01];
    const at = (turn: Rotation) => normToCss(tl, { ...view, rotation: 0, viewRotation: turn });
    expect(at(0).x).toBeLessThan(1);
    expect(at(0).y).toBeLessThan(1);
    expect(at(90).x + at(90).width).toBeGreaterThan(99); // the shown page is 100 wide
    expect(at(90).y).toBeLessThan(1);
    expect(at(180).x + at(180).width).toBeGreaterThan(199);
    expect(at(180).y + at(180).height).toBeGreaterThan(99);
    expect(at(270).x).toBeLessThan(1);
    expect(at(270).y + at(270).height).toBeGreaterThan(199);
    near(turnedPoint(0, 0, view, 90).x, 100); // the oracle agrees
  });
});

describe('sortKey', () => {
  // The schema (Phase 1 plan, marks table): `page_index` is the first page and `sort_key` is "top of the first rect (0-1)";
  // rows come out ordered by (page_index, sort_key). So sortKey is the top of the first rect, and a document note has none.
  const text = (top: number) => ({
    kind: 'text' as const,
    quote: { quote: 'x', prefix: '', suffix: '' },
    start: { page: 3, index: 40 },
    end: { page: 3, index: 60 },
    rects: [{ page: 3, rects: [[0.1, top, 0.9, top + 0.02] as NormRect, [0.1, top + 0.03, 0.5, top + 0.05] as NormRect] }],
  });

  it('a text anchor sorts by the top of its first rect, so lines come out top to bottom', () => {
    const tops = [0, 0.05, 0.31, 0.5, 0.999];
    const keys = tops.map((t) => sortKey(text(t)));
    keys.forEach((k, i) => {
      expect(k).toBeCloseTo(tops[i], 9);
      if (i > 0) expect(k as number).toBeGreaterThan(keys[i - 1] as number);
    });
  });

  it('an area, a point and a page note sort by their top; a document note has no key', () => {
    expect(sortKey({ kind: 'area', page: 1, rect: [0.1, 0.4, 0.5, 0.6], dHash: '0'.repeat(16) })).toBeCloseTo(0.4, 9);
    expect(sortKey({ kind: 'point', page: 1, point: [0.5, 0.25] })).toBeCloseTo(0.25, 9);
    expect(sortKey({ kind: 'page', page: 1 })).toBe(0);
    expect(sortKey({ kind: 'document' })).toBeNull();
  });
});

describe('one path per style and colour', () => {
  const VIEW: View = { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: 0 };
  // three lines of text, as the engine would give them: [x0, y0, x1, y1] in 0-1
  const L1: NormRect = [0.1, 0.1, 0.9, 0.2];
  const L2: NormRect = [0.1, 0.25, 0.9, 0.35];
  const L3: NormRect = [0.1, 0.4, 0.5, 0.5];
  const SPAN: NormRect = [0.3, 0.15, 0.7, 0.3]; // a second mark, over the end of L1 and the start of L2: overlaps both

  const marks: PaintMark[] = [
    { id: 'a', style: 'highlight', color: 1, rects: [L1, L2, L3] },
    { id: 'b', style: 'highlight', color: 1, rects: [SPAN] },
    { id: 'c', style: 'highlight', color: 2, rects: [SPAN] },
    { id: 'd', style: 'underline', color: 1, rects: [L1] },
    { id: 'e', style: 'underline', color: 1, rects: [L3] },
    { id: 'f', style: 'strike', color: 1, rects: [L2] },
  ];

  it('overlapping marks of one style and colour share a path; another colour or style gets its own', () => {
    const paths = markPaths(marks, VIEW);
    const key = (p: { style: string; color: number | null }) => `${p.style}/${String(p.color)}`;
    const counts = new Map<string, number>();
    for (const p of paths) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
    expect([...counts.entries()].sort()).toEqual([
      ['highlight/1', 1],
      ['highlight/2', 1],
      ['strike/1', 1],
      ['underline/1', 1],
    ]);
  });

  it('the highlight path covers exactly the union of its rectangles, in css px', () => {
    const p = markPaths(marks, VIEW).find((x) => x.style === 'highlight' && x.color === 1)!;
    const want = [L1, L2, L3, SPAN].map((r) => expectedCss(r, VIEW, 0));
    const x0 = Math.min(...want.map((b) => b.x));
    const y0 = Math.min(...want.map((b) => b.y));
    nearBox(pathBox(p.d).box, { x: x0, y: y0, width: Math.max(...want.map((b) => b.x + b.width)) - x0, height: Math.max(...want.map((b) => b.y + b.height)) - y0 }, 1e-6);
    expect(pathBox(p.d).subpaths, 'one outline per rectangle at most, and at least one').toBeGreaterThanOrEqual(1);
  });

  // The bottom edge of a rectangle, and its middle, as they are on the turned page
  const edge = (r: NormRect, view: View, at: 'bottom' | 'middle') => {
    const turn = ((view.rotation + view.viewRotation) % 360) as Rotation;
    const v = at === 'bottom' ? r[3] : (r[1] + r[3]) / 2;
    const a = turnedPoint(r[0], v, view, turn);
    const b = turnedPoint(r[2], v, view, turn);
    return { a, b, horizontal: turn % 180 === 0 };
  };

  it.each([0, 90, 180, 270] as Rotation[])('underline sits at the bottom of the text line and strike through its middle, with the page turned %i degrees', (turn) => {
    const view: View = { ...VIEW, viewRotation: turn };
    const paths = markPaths([{ id: 'u', style: 'underline', color: 3, rects: [L1] }, { id: 's', style: 'strike', color: 3, rects: [L1] }], view);
    const box = expectedCss(L1, view, turn);
    const thickness = turn % 180 === 0 ? box.height : box.width; // the line's height, across the text
    for (const style of ['underline', 'strike'] as const) {
      const p = paths.find((x) => x.style === style);
      expect(p, `a ${style} path`).toBeDefined();
      const got = pathBox(p!.d).box;
      const e = edge(L1, view, style === 'underline' ? 'bottom' : 'middle');
      if (e.horizontal) {
        // along the text: the whole line; across it: at the edge (bottom) or at the middle, and thin
        near(got.x, Math.min(e.a.x, e.b.x), 1); // the whole length of the line, to the pixel
        near(got.x + got.width, Math.max(e.a.x, e.b.x), 1);
        expect(Math.abs(got.y + got.height / 2 - e.a.y), `${style} offset from its line`).toBeLessThanOrEqual(0.3 * thickness);
        expect(got.height, `${style} is thin`).toBeLessThanOrEqual(0.35 * thickness);
      } else {
        near(got.y, Math.min(e.a.y, e.b.y), 1);
        near(got.y + got.height, Math.max(e.a.y, e.b.y), 1);
        expect(Math.abs(got.x + got.width / 2 - e.a.x), `${style} offset from its line`).toBeLessThanOrEqual(0.3 * thickness);
        expect(got.width, `${style} is thin`).toBeLessThanOrEqual(0.35 * thickness);
      }
    }
  });

  it('the paths follow the turn: the highlight of a line on a page turned 90 degrees is the rotated box', () => {
    const view: View = { ...VIEW, viewRotation: 90 };
    const p = markPaths([{ id: 'a', style: 'highlight', color: 1, rects: [L3] }], view)[0];
    nearBox(pathBox(p.d).box, expectedCss(L3, view, 90), 1e-6);
  });
});

describe('hit test', () => {
  const VIEW: View = { width: 200, height: 100, rotation: 0, scale: 2, viewRotation: 0 };
  const lines: PaintMark = { id: 'two-lines', style: 'highlight', color: 1, rects: [[0.1, 0.1, 0.9, 0.2], [0.1, 0.3, 0.5, 0.4]] }; // css 40..360 x 20..40, and 40..200 x 60..80
  const other: PaintMark = { id: 'other', style: 'underline', color: 2, rects: [[0.6, 0.6, 0.8, 0.7]] }; // css 240..320 x 120..140

  const ROWS: { name: string; point: { x: number; y: number }; want: string | null }[] = [
    { name: 'inside the first line', point: { x: 200, y: 30 }, want: 'two-lines' },
    { name: 'inside the second line', point: { x: 100, y: 70 }, want: 'two-lines' },
    { name: 'in the gap between the two lines of one mark', point: { x: 100, y: 50 }, want: null },
    { name: 'right of the short second line', point: { x: 300, y: 70 }, want: null },
    { name: 'just inside a corner', point: { x: 40.5, y: 20.5 }, want: 'two-lines' },
    { name: 'just outside a corner', point: { x: 39, y: 19 }, want: null },
    { name: 'on another mark', point: { x: 280, y: 130 }, want: 'other' },
    { name: 'on blank page', point: { x: 5, y: 190 }, want: null },
  ];
  it.each(ROWS)('$name', ({ point, want }) => {
    expect(hitTest([lines, other], VIEW, point)).toBe(want);
  });

  it('on a page turned 90 degrees the same mark is hit where it is drawn, not where it was', () => {
    const view: View = { ...VIEW, viewRotation: 90 };
    const box = expectedCss([0.1, 0.1, 0.9, 0.2], view, 90);
    expect(hitTest([lines], view, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe('two-lines');
    expect(hitTest([lines], view, { x: 200, y: 30 }), 'the old place is empty').toBeNull();
  });

  it('where marks overlap, one of them is found', () => {
    const a: PaintMark = { id: 'a', style: 'highlight', color: 1, rects: [[0.1, 0.1, 0.5, 0.2]] };
    const b: PaintMark = { id: 'b', style: 'underline', color: 1, rects: [[0.3, 0.1, 0.7, 0.2]] };
    expect(['a', 'b']).toContain(hitTest([a, b], VIEW, { x: 160, y: 30 }));
    expect(hitTest([a, b], VIEW, { x: 60, y: 30 })).toBe('a');
    expect(hitTest([a, b], VIEW, { x: 260, y: 30 })).toBe('b');
  });
});
