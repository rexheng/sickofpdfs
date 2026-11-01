// The outline finder the figure walkthroughs rely on (rings.spec-blind.ts). Its verdicts decide whether a figure "has an outline", so it is
// checked on pictures made here, where the right answer is known: an outline of a given thickness around a given box, a tint (not an
// outline), a line that is too short to count, a screenshot of a clip that starts away from the corner of the window, and a high-density screen.
import { describe, expect, it } from 'vitest';
import { changed, findRing, frameOf, iou, meanChange, near, variety, type Frame, type RGB } from './rings.spec-blind';

const WHITE: RGB = [255, 255, 255];
const BLUE: RGB = [11, 87, 208];

/** A white picture `w` x `h` device px, with `paint(x, y)` giving the colour of each pixel that is not white. */
function picture(w: number, h: number, dpr: number, paint: (x: number, y: number) => RGB | null, ox = 0, oy = 0): Frame {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y) ?? WHITE;
      data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return frameOf({ width: w, height: h, data }, dpr, ox, oy);
}

/** A rectangular outline `t` device px thick whose outer edge is the box (l, t, r, b), in device px. */
const outline = (l: number, t: number, r: number, b: number, thick: number, c: RGB) => (x: number, y: number): RGB | null =>
  x >= l && x < r && y >= t && y < b && (x < l + thick || x >= r - thick || y < t + thick || y >= b - thick) ? c : null;

const blank = picture(240, 200, 1, () => null);
const BOX = { left: 40, top: 30, right: 200, bottom: 170 };

describe('findRing', () => {
  it('finds a 2 px solid outline on the box, with its thickness, its colour and a perfect overlap', () => {
    const after = picture(240, 200, 1, outline(40, 30, 200, 170, 2, BLUE));
    const ring = findRing(after, changed(blank, after), BOX, { band: 12, prefer: BLUE });
    expect(ring.found).toBe(4);
    expect(ring.thickness).toBeCloseTo(2, 0);
    expect(ring.iou).toBeGreaterThan(0.95);
    expect(ring.top?.colour).toEqual(BLUE);
  });

  it('finds a faint 1 px outline that lies 8 px outside the box, and reports where it is', () => {
    const faint: RGB = [145, 179, 234];
    const after = picture(240, 200, 1, outline(32, 22, 208, 178, 1, faint));
    const ring = findRing(after, changed(blank, after), BOX, { band: 14 });
    expect(ring.found).toBe(4);
    expect(ring.thickness).toBeLessThanOrEqual(1.01);
    expect(ring.top!.at).toBeCloseTo(22.5, 0);
    expect(ring.left!.at).toBeCloseTo(32.5, 0);
    expect(ring.iou).toBeGreaterThan(0.75);
  });

  it('does not take a tint over the whole figure for an outline: its lines are as thick as the figure', () => {
    const after = picture(240, 200, 1, (x, y) => (x >= 40 && x < 200 && y >= 30 && y < 170 ? ([253, 226, 147] as RGB) : null));
    const ring = findRing(after, changed(blank, after), BOX, { band: 12 });
    expect(ring.thickness, 'a fill is not a 1 or 2 px line').toBeGreaterThan(10);
  });

  it('counts the sides that are there: two lines make 2 of 4, and no box', () => {
    const after = picture(240, 200, 1, (x, y) => (x >= 40 && x < 200 && (y === 30 || y === 31 || y === 168 || y === 169) ? BLUE : null));
    const ring = findRing(after, changed(blank, after), BOX, { band: 12 });
    expect(ring.found).toBe(2);
    expect(ring.box).toBeNull();
    expect(ring.iou).toBe(0);
  });

  it('ignores a short stroke (a tick or a toolbar edge) that covers a third of a side', () => {
    const after = picture(240, 200, 1, (x, y) => (y === 30 && x >= 90 && x < 140 ? BLUE : null));
    expect(findRing(after, changed(blank, after), BOX, { band: 12 }).top).toBeNull();
  });

  it('ignores lines that were already there: only what changed counts', () => {
    const frame = picture(240, 200, 1, outline(40, 30, 200, 170, 1, [0, 0, 0]));
    expect(findRing(frame, changed(frame, frame), BOX, { band: 12 }).found).toBe(0);
  });

  it('reads a screenshot of a clip: positions are in window px, not clip px', () => {
    // the clip starts at (100, 300) in the window; its outline is 2 px thick at the window's (140..300, 330..470)
    const after = picture(240, 200, 1, outline(40, 30, 200, 170, 2, BLUE), 100, 300);
    const before = picture(240, 200, 1, () => null, 100, 300);
    const ring = findRing(after, changed(before, after), { left: 140, top: 330, right: 300, bottom: 470 }, { band: 10 });
    expect(ring.found).toBe(4);
    expect(ring.top!.at).toBeCloseTo(331, 0);
    expect(ring.right!.at).toBeCloseTo(299, 0);
  });

  it('on a screen with 2 device px to the CSS px, a 2 CSS px line is 2 CSS px thick, not 4', () => {
    const after = picture(480, 400, 2, outline(80, 60, 400, 340, 4, BLUE));
    const ring = findRing(after, changed(picture(480, 400, 2, () => null), after), BOX, { band: 10 });
    expect(ring.found).toBe(4);
    expect(ring.thickness).toBeCloseTo(2, 0);
  });

  it('finds an outline by its colour alone, when there is no earlier picture (an area, whose colour is a design token)', () => {
    const area: RGB = [224, 155, 0];
    const after = picture(240, 200, 1, outline(40, 30, 200, 170, 2, area));
    const ring = findRing(after, near(after, area, 40), BOX, { band: 8 });
    expect(ring.found).toBe(4);
    expect(findRing(after, near(after, BLUE, 40), BOX, { band: 8 }).found, 'and not by another colour').toBe(0);
  });
});

describe('the small measures', () => {
  it('iou: the same box is 1, a box half the size inside it is 0.25, apart is 0', () => {
    expect(iou(BOX, BOX)).toBe(1);
    expect(iou(BOX, { left: 40, top: 30, right: 120, bottom: 100 })).toBeCloseTo(0.25, 2);
    expect(iou(BOX, { left: 300, top: 300, right: 400, bottom: 400 })).toBe(0);
  });

  it('meanChange is 0 when nothing in the box changed, and large for a tint', () => {
    const tint = picture(240, 200, 1, (x, y) => (x >= 40 && x < 200 && y >= 30 && y < 170 ? ([253, 226, 147] as RGB) : null));
    expect(meanChange(blank, blank, BOX)).toBe(0);
    expect(meanChange(blank, tint, BOX)).toBeGreaterThan(50);
  });

  it('variety is 0 for a flat picture and above 0.1 for one with a drawing in it', () => {
    expect(variety(blank.img)).toBe(0);
    expect(variety(picture(64, 64, 1, (x, y) => ((x + y) % 7 < 3 ? ([40, 90, 200] as RGB) : null)).img)).toBeGreaterThan(0.1);
  });
});
