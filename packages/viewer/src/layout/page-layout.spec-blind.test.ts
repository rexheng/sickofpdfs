// Spec-blind unit tests for the page layout and the virtual list's window (Task 21). Written from the spec and the interface file only.
// Spec, Visual design: "white pages with 16 px gaps"; Viewer: "Pages scroll in a virtual list". Interface file: PAGE_GAP = 16, PageBox in CSS px,
// computeLayout(pages, { scale, viewRotation, spread, viewportWidth }), visibleRange(layout, scrollTop, viewportHeight, overscan);
// "PageSize from the engine is the UNROTATED page size; layout applies the page's /Rotate plus the view rotation (clockwise)".
import { describe, expect, it } from 'vitest';
import type { PageSize } from '../backend/types';
import { computeLayout, visibleRange } from './page-layout';
import { PAGE_GAP, PT_TO_CSS } from './zoom';

const LETTER: PageSize = { width: 612, height: 792, rotation: 0 };
const base = { scale: 1, viewRotation: 0 as const, spread: 'none' as const, viewportWidth: 1280 };

describe('computeLayout', () => {
  it('stacks pages top to bottom with a 16 px gap, in page order, each at its size x scale x 96/72', () => {
    const pages: PageSize[] = [LETTER, { width: 842, height: 595, rotation: 0 }, { width: 420, height: 595, rotation: 0 }];
    const l = computeLayout(pages, { ...base, scale: 1.5 });
    expect(l.boxes.map((b) => b.index)).toEqual([0, 1, 2]);
    pages.forEach((p, i) => {
      expect(l.boxes[i]!.width).toBeCloseTo(p.width * 1.5 * PT_TO_CSS, 0);
      expect(l.boxes[i]!.height).toBeCloseTo(p.height * 1.5 * PT_TO_CSS, 0);
    });
    for (let i = 1; i < l.boxes.length; i++) {
      const prev = l.boxes[i - 1]!;
      expect(l.boxes[i]!.top - (prev.top + prev.height), `gap before page ${i + 1}`).toBeCloseTo(PAGE_GAP, 0);
    }
    expect(l.boxes[0]!.top).toBeGreaterThanOrEqual(0);
    expect(l.boxes[0]!.top).toBeLessThanOrEqual(PAGE_GAP);
    const last = l.boxes[2]!;
    expect(l.height, 'the document is at least as tall as its last page').toBeGreaterThanOrEqual(last.top + last.height);
  });

  it('pages narrower than the window are centred; pages wider make the document wider than the window', () => {
    const narrow = computeLayout([LETTER], { ...base, scale: 1 }).boxes[0]!;
    expect(narrow.left + narrow.width / 2).toBeCloseTo(640, -1); // within 5 px of the middle of the window
    const wide = computeLayout([LETTER], { ...base, scale: 4 });
    expect(wide.boxes[0]!.width).toBeCloseTo(612 * 4 * PT_TO_CSS, 0);
    expect(wide.width, 'the content is wider than the 1280 px window, so it scrolls sideways').toBeGreaterThanOrEqual(wide.boxes[0]!.left + wide.boxes[0]!.width);
    expect(wide.width).toBeGreaterThan(1280);
    expect(wide.boxes[0]!.left).toBeGreaterThanOrEqual(0);
  });

  it('a page with /Rotate 90 is laid out landscape; the view rotation adds to the page rotation (clockwise)', () => {
    const turned = computeLayout([{ ...LETTER, rotation: 90 }], base).boxes[0]!;
    expect(turned.width).toBeCloseTo(792 * PT_TO_CSS, 0);
    expect(turned.height).toBeCloseTo(612 * PT_TO_CSS, 0);
    const byView = computeLayout([LETTER], { ...base, viewRotation: 90 }).boxes[0]!;
    expect([byView.width, byView.height]).toEqual([turned.width, turned.height]);
    const both = computeLayout([{ ...LETTER, rotation: 90 }], { ...base, viewRotation: 90 }).boxes[0]!;
    expect(both.width).toBeCloseTo(612 * PT_TO_CSS, 0);
    expect(both.height).toBeCloseTo(792 * PT_TO_CSS, 0);
    const three = computeLayout([{ ...LETTER, rotation: 270 }], { ...base, viewRotation: 90 }).boxes[0]!; // 270 + 90 = 360
    expect(three.width).toBeCloseTo(612 * PT_TO_CSS, 0);
  });

  it('the two-page view puts pages side by side, so the same pages take about half the height', () => {
    const pages = Array.from({ length: 10 }, () => LETTER);
    const spread = computeLayout(pages, { ...base, spread: 'two-page', scale: 0.5, viewportWidth: 1600 });
    const tops = new Map<number, number>();
    for (const b of spread.boxes) tops.set(Math.round(b.top), (tops.get(Math.round(b.top)) ?? 0) + 1);
    expect([...tops.values()].some((n) => n === 2), 'at least one pair of pages shares a row').toBe(true);
    expect(spread.boxes).toHaveLength(10);
    expect(spread.height).toBeLessThan(computeLayout(pages, { ...base, scale: 0.5, viewportWidth: 1600 }).height * 0.75);
  });

  it('a 3000-page book lays out at once and stays ordered', () => {
    const pages = Array.from({ length: 3000 }, () => LETTER);
    const l = computeLayout(pages, base);
    expect(l.boxes).toHaveLength(3000);
    expect(l.boxes[2999]!.top).toBeGreaterThan(l.boxes[2998]!.top);
    expect(l.height).toBeGreaterThanOrEqual(l.boxes[2999]!.top + l.boxes[2999]!.height);
  });
});

describe('visibleRange', () => {
  const pages = Array.from({ length: 40 }, () => LETTER);
  const layout = computeLayout(pages, { ...base, scale: 1 });

  /** The plain definition: pages that overlap [scrollTop, scrollTop + vh], widened by `overscan` pages, kept inside the document. */
  function oracle(scrollTop: number, vh: number, overscan: number): { first: number; last: number } {
    const hit = layout.boxes.filter((b) => b.top < scrollTop + vh && b.top + b.height > scrollTop).map((b) => b.index);
    return { first: Math.max(0, Math.min(...hit) - overscan), last: Math.min(layout.boxes.length - 1, Math.max(...hit) + overscan) };
  }

  const stride = layout.boxes[1]!.top - layout.boxes[0]!.top;
  it.each([
    ['the top of the document', 0, 800, 0],
    ['the top, with one page of overscan', 0, 800, 1],
    ['the middle of page 3', 2 * stride + 400, 800, 0],
    ['straddling pages 3 and 4, overscan 1', 2 * stride + 700, 800, 1],
    ['exactly at a page boundary', 5 * stride, 800, 0],
    ['a tall window of several pages', 10 * stride + 100, 3500, 1],
    ['the end of the document (the largest scroll position)', layout.height - 800, 800, 1],
  ] as const)('%s', (_name, scrollTop, vh, overscan) => {
    expect(visibleRange(layout, scrollTop, vh, overscan)).toEqual(oracle(scrollTop, vh, overscan));
  });

  it('agrees with the plain definition at every 137 px of scroll through the whole document', () => {
    for (let top = 0; top <= layout.height - 800; top += 137) {
      const got = visibleRange(layout, top, 800, 1);
      const want = oracle(top, 800, 1);
      expect(got, `at scrollTop ${top}`).toEqual(want);
    }
  });

  it('never asks for more than a handful of pages in a 3000-page book', () => {
    const big = computeLayout(Array.from({ length: 3000 }, () => LETTER), base);
    const r = visibleRange(big, 1_000_000, 800, 1);
    expect(r.last - r.first).toBeLessThanOrEqual(4);
    expect(r.first).toBeGreaterThan(500);
  });
});
