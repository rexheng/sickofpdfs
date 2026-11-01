// Checks for "selection rectangles" (R44): the line rectangles that selection and marks are painted from. Used by the S7
// browser tests on the engine's own getTextRangeRects and on the PageTextProvider that wraps it, so the same bar holds
// at both places. All numbers are points in unrotated page space (top-left origin, y down), as PdfRect is.
import { expect } from 'vitest';
import type { Glyph, PdfRect } from '../../src/backend/types';

/** Reads the rectangles of chars [start, start + count) of a page. */
export type RectSource = (pageIndex: number, start: number, count: number) => Promise<PdfRect[]>;

export const right = (r: PdfRect) => r.x + r.width;
export const bottom = (r: PdfRect) => r.y + r.height;

export interface Selected {
  /** The chars of the range that have ink: not PDFium's generated breaks and spaces, not white space. */
  inked: Glyph[];
  /** The inked chars cut into visual lines (and columns): a new line starts where the baseline moves, or the text jumps sideways. */
  lines: Glyph[][];
}

/**
 * PDFium's own line breaks (the CR LF in its text) are not the lines on the page: it leaves some out. A visual line is a
 * run of chars, in reading order, on one baseline without a jump of more than two ems to the side.
 */
export function selectedGlyphs(glyphs: Glyph[], start: number, count: number): Selected {
  const inked = glyphs.filter((g) => g.index >= start && g.index < start + count && !g.generated && g.text.trim() !== '' && g.tight.width > 0.5 && g.tight.height > 0.5);
  const lines: Glyph[][] = [];
  let prev: Glyph | null = null;
  for (const g of inked) {
    const sameBaseline = prev !== null && Math.abs(g.box.y + g.box.height / 2 - (prev.box.y + prev.box.height / 2)) < 0.5 * Math.max(g.fontSize, 1);
    const jump = prev !== null && (g.box.x - (prev.box.x + prev.box.width) > 2 * g.fontSize || prev.box.x - g.box.x > g.fontSize);
    if (!prev || !sameBaseline || jump) lines.push([]);
    lines[lines.length - 1].push(g);
    prev = g;
  }
  return { inked, lines };
}

const inside = (outer: PdfRect, inner: PdfRect, tol: number) =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && right(inner) <= right(outer) + tol && bottom(inner) <= bottom(outer) + tol;

/** Points the two rectangles share, on each axis (negative: a gap). */
export const overlap = (a: PdfRect, b: PdfRect) => ({
  x: Math.min(right(a), right(b)) - Math.max(a.x, b.x),
  y: Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y),
});

/** Overlap of up to this much, in points on each axis at once, is below what a pixel can show at 100% zoom (0.75 pt per px at DPR 1). */
export const OVERLAP_TOL = 0.25;

/** Rectangles with sane numbers, inside the page. */
export function expectSane(rects: PdfRect[], page: { width: number; height: number }, label: string) {
  expect(rects.length, `${label}: at least one rectangle`).toBeGreaterThan(0);
  for (const r of rects) {
    expect([r.x, r.y, r.width, r.height].every(Number.isFinite), `${label}: finite numbers ${JSON.stringify(r)}`).toBe(true);
    expect(r.width, `${label}: width`).toBeGreaterThan(0);
    expect(r.height, `${label}: height`).toBeGreaterThan(0);
    expect(inside({ x: 0, y: 0, width: page.width, height: page.height }, r, 0.5), `${label}: inside the page ${JSON.stringify(r)}`).toBe(true);
  }
}

/** The rectangles of different lines do not overlap (R44: "no darker bands"). */
export function expectNoOverlap(rects: PdfRect[], label: string) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const o = overlap(rects[i], rects[j]);
      expect(o.x > OVERLAP_TOL && o.y > OVERLAP_TOL, `${label}: rects ${i} and ${j} overlap by ${o.x.toFixed(2)} x ${o.y.toFixed(2)} pt: ${JSON.stringify(rects[i])} ${JSON.stringify(rects[j])}`).toBe(false);
    }
  }
}

/** The mark covers the selected text: every glyph's ink lies in a rectangle, and no rectangle holds none of them. */
export function expectCovers(rects: PdfRect[], sel: Selected, label: string, tol = 0.75) {
  for (const g of sel.inked) {
    expect(
      rects.some((r) => inside(r, g.tight, tol)),
      `${label}: glyph #${g.index} ${JSON.stringify(g.text)} at ${JSON.stringify(g.tight)} is in no rectangle`,
    ).toBe(true);
  }
  for (const r of rects) {
    const centre = (g: Glyph) => ({ x: g.tight.x + g.tight.width / 2, y: g.tight.y + g.tight.height / 2 });
    expect(
      sel.inked.some((g) => {
        const c = centre(g);
        return c.x >= r.x && c.x <= right(r) && c.y >= r.y && c.y <= bottom(r);
      }),
      `${label}: a rectangle that covers no selected glyph ${JSON.stringify(r)}`,
    ).toBe(true);
  }
}

/** The rectangles start at the first selected glyph and end at the last (a selection that starts or ends mid-line paints only from there to there). */
export function expectEdges(rects: PdfRect[], sel: Selected, label: string, tol = 1.5) {
  const left = Math.min(...rects.map((r) => r.x));
  const end = Math.max(...rects.map(right));
  expect(Math.abs(left - Math.min(...sel.inked.map((g) => g.tight.x))), `${label}: left edge ${left}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(end - Math.max(...sel.inked.map((g) => right(g.tight)))), `${label}: right edge ${end}`).toBeLessThanOrEqual(tol);
}

/** Heights of these rectangles agree to within `relTol` of their median. */
export function expectUniformHeights(rects: PdfRect[], relTol: number, label: string) {
  const hs = rects.map((r) => r.height).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)];
  for (const r of rects) expect(Math.abs(r.height - median) / median, `${label}: height ${r.height.toFixed(2)} against a median of ${median.toFixed(2)}`).toBeLessThanOrEqual(relTol);
}

/** Every rectangle lies wholly on one side of the gutter [gutterLeft, gutterRight], and both sides have some. */
export function expectSeparateColumns(rects: PdfRect[], gutterLeft: number, gutterRight: number, label: string) {
  for (const r of rects) {
    const left = right(r) <= gutterRight;
    const rightSide = r.x >= gutterLeft;
    expect(left || rightSide, `${label}: a rectangle crosses the gutter ${gutterLeft}-${gutterRight}: ${JSON.stringify(r)}`).toBe(true);
  }
  expect(rects.some((r) => right(r) <= gutterRight), `${label}: some rectangles in the left column`).toBe(true);
  expect(rects.some((r) => r.x >= gutterLeft), `${label}: some rectangles in the right column`).toBe(true);
}
