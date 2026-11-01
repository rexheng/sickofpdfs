// Spec-blind unit tests for zoom (Task 21). Written from the spec and the interface file only.
// Spec: "Zoom: Fit width, fit page, 25 to 400%; Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+wheel ..."; "Zoom steps, fit modes and keyboard scrolling
// follow Chromium's open-source viewer". Interface file: ZOOM_STEPS (the Chromium presets), MIN_SCALE 0.25, MAX_SCALE 4, PAGE_GAP 16,
// PT_TO_CSS 96/72, stepZoom(scale, dir), wheelZoom = clamp(scale * exp(-deltaPx / 400)), resolveScale(mode, viewport, pages,
// { viewRotation, spread }). "PageSize from the engine is the UNROTATED page size; layout applies the page's /Rotate plus the view
// rotation (clockwise)."
import { describe, expect, it } from 'vitest';
import type { PageSize } from '../backend/types';
import { MAX_SCALE, MIN_SCALE, PAGE_GAP, PT_TO_CSS, ZOOM_STEPS, resolveScale, stepZoom, wheelZoom } from './zoom';

const LETTER: PageSize = { width: 612, height: 792, rotation: 0 };
const LETTER_R90: PageSize = { width: 612, height: 792, rotation: 90 };

describe('the constants are the interface file\'s', () => {
  it('ZOOM_STEPS are Chromium\'s presets, 25% to 400%', () => {
    expect([...ZOOM_STEPS]).toEqual([0.25, 0.333, 0.5, 0.666, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]);
    expect(MIN_SCALE).toBe(0.25);
    expect(MAX_SCALE).toBe(4);
    expect(PAGE_GAP).toBe(16);
    expect(PT_TO_CSS).toBeCloseTo(96 / 72, 12);
  });
});

describe('stepZoom: the next Chromium preset above or below', () => {
  // [from, dir, expected]
  it.each([
    [1, 1, 1.1],
    [1, -1, 0.9],
    [0.25, 1, 0.333],
    [0.333, 1, 0.5],
    [0.5, -1, 0.333],
    [3, 1, 4],
    [2, -1, 1.75],
    // not on a preset (fit width gives any value): the nearest preset in the direction asked
    [1.53, 1, 1.75],
    [1.53, -1, 1.5],
    [0.4, 1, 0.5],
    [0.4, -1, 0.333],
    [3.9, 1, 4],
    // the ends hold
    [0.25, -1, 0.25],
    [4, 1, 4],
    // outside the range (a wheel zoom clamps, but be safe)
    [5, -1, 4],
    [0.1, 1, 0.25],
  ] as const)('stepZoom(%s, %s) = %s', (from, dir, expected) => {
    expect(stepZoom(from, dir)).toBeCloseTo(expected, 6);
  });

  it('zooming in then out from a preset comes back to it, and a full walk visits every preset once', () => {
    let s: number = ZOOM_STEPS[0];
    const up: number[] = [s];
    for (let i = 0; i < ZOOM_STEPS.length + 3; i++) {
      s = stepZoom(s, 1);
      if (s !== up[up.length - 1]) up.push(s);
    }
    expect(up).toEqual([...ZOOM_STEPS]);
    for (const z of ZOOM_STEPS.slice(1, -1)) expect(stepZoom(stepZoom(z, 1), -1)).toBeCloseTo(z, 6);
  });
});

describe('wheelZoom: clamp(scale * exp(-deltaPx / 400))', () => {
  it.each([
    [1, -100, 0, Math.exp(0.25)],
    [1, 100, 0, Math.exp(-0.25)],
    [2, -40, 0, 2 * Math.exp(0.1)],
    [1, 0, 0, 1],
    [3.5, -1000, 0, 4], // clamps at 400%
    [0.3, 1000, 0, 0.25], // clamps at 25%
  ] as const)('wheelZoom(%s, %s, mode %s) = %s', (scale, deltaY, mode, expected) => {
    expect(wheelZoom(scale, deltaY, mode)).toBeCloseTo(expected, 9);
  });

  it('turning the wheel up zooms in, down zooms out, and lines and pages count for more than pixels', () => {
    expect(wheelZoom(1, -3, 0)).toBeGreaterThan(1);
    expect(wheelZoom(1, 3, 0)).toBeLessThan(1);
    // DOM_DELTA_LINE = 1 and DOM_DELTA_PAGE = 2: the same number of lines or pages is a bigger turn than the same number of pixels.
    expect(wheelZoom(1, -3, 1)).toBeGreaterThan(wheelZoom(1, -3, 0));
    expect(wheelZoom(1, -1, 2)).toBeGreaterThan(wheelZoom(1, -1, 1));
  });
});

describe('resolveScale', () => {
  const VIEW = { width: 1280, height: 800 };
  const none = { viewRotation: 0 as const, spread: 'none' as const };
  const shownWidth = (scale: number, pt: number) => scale * PT_TO_CSS * pt;

  it('a fixed scale is that scale, clamped to 25%..400%', () => {
    expect(resolveScale({ kind: 'scale', scale: 1.25 }, VIEW, [LETTER], none)).toBeCloseTo(1.25, 9);
    expect(resolveScale({ kind: 'scale', scale: 9 }, VIEW, [LETTER], none)).toBe(4);
    expect(resolveScale({ kind: 'scale', scale: 0.01 }, VIEW, [LETTER], none)).toBe(0.25);
  });

  it('fit width: the page fills the width (a margin at most), and a wider window gives a bigger page', () => {
    const s = resolveScale({ kind: 'fit-width' }, VIEW, [LETTER], none);
    expect(shownWidth(s, 612)).toBeLessThanOrEqual(VIEW.width);
    expect(shownWidth(s, 612)).toBeGreaterThan(VIEW.width * 0.85);
    const wider = resolveScale({ kind: 'fit-width' }, { width: 1920, height: 800 }, [LETTER], none);
    expect(wider).toBeGreaterThan(s);
    const narrow = resolveScale({ kind: 'fit-width' }, { width: 600, height: 800 }, [LETTER], none);
    expect(narrow).toBeLessThan(s);
  });

  it('fit page: the whole page fits, so a short window is held back by the height', () => {
    const s = resolveScale({ kind: 'fit-page' }, VIEW, [LETTER], none);
    expect(s * PT_TO_CSS * 792).toBeLessThanOrEqual(VIEW.height);
    expect(s * PT_TO_CSS * 792).toBeGreaterThan(VIEW.height * 0.8);
    expect(s).toBeLessThan(resolveScale({ kind: 'fit-width' }, VIEW, [LETTER], none));
    // a slide (landscape 16:9) in the same window is held by the width instead
    const slide: PageSize = { width: 960, height: 540, rotation: 0 };
    const fs = resolveScale({ kind: 'fit-page' }, VIEW, [slide], none);
    expect(shownWidth(fs, 960)).toBeLessThanOrEqual(VIEW.width);
    expect(fs * PT_TO_CSS * 540).toBeLessThanOrEqual(VIEW.height);
  });

  it('a page whose /Rotate is 90 is fitted as it is displayed: 792 wide, not 612', () => {
    const upright = resolveScale({ kind: 'fit-width' }, VIEW, [LETTER], none);
    const turned = resolveScale({ kind: 'fit-width' }, VIEW, [LETTER_R90], none);
    expect(upright / turned).toBeCloseTo(792 / 612, 1);
    // and the view's own rotation adds to the page's: a plain page turned 90 by the viewer fits the same way
    const viewTurned = resolveScale({ kind: 'fit-width' }, VIEW, [LETTER], { viewRotation: 90, spread: 'none' });
    expect(viewTurned).toBeCloseTo(turned, 6);
    // 90 + 90 is upside down: the same shape as 0
    const both = resolveScale({ kind: 'fit-width' }, VIEW, [LETTER_R90], { viewRotation: 90, spread: 'none' });
    expect(both).toBeCloseTo(upright, 6);
  });

  it('the result never leaves 25%..400%, however small the page or the window', () => {
    const tiny: PageSize = { width: 50, height: 50, rotation: 0 };
    expect(resolveScale({ kind: 'fit-width' }, { width: 1600, height: 900 }, [tiny], none)).toBe(4);
    const huge: PageSize = { width: 20000, height: 20000, rotation: 0 };
    expect(resolveScale({ kind: 'fit-width' }, { width: 400, height: 300 }, [huge], none)).toBe(0.25);
  });
});
