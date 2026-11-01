// Table-driven checks of the Task 22 test helpers themselves (tl-paint, tl-copy). The walkthrough tests lean on these two
// judges; if a judge passes a ragged selection or fails a clean one, every result built on it is wrong. So each judge
// is shown clean input (must pass) and one defect at a time (must say so).
import { describe, expect, it } from 'vitest';
import type { Glyph } from '../../packages/viewer/src/backend/types';
import { copyProblems, squash } from './tl-copy.spec-blind';
import { analyzeSelectionPaint, parseCssColor, type Box, type Img, type PaintGlyph, type PaintOptions, type Rgba } from './tl-paint.spec-blind';

const TOKEN: Rgba = { r: 11, g: 87, b: 208, a: 0.3 };

function blank(width: number, height: number): Img {
  const data = new Uint8Array(width * height * 4).fill(255);
  return { width, height, data };
}

/** Paints a rectangle with sub-pixel edges the way a browser anti-aliases it: coverage-weighted alpha, one blend. */
function paint(img: Img, b: Box, c: Rgba = TOKEN): void {
  for (let y = Math.floor(b.top); y < Math.ceil(b.bottom); y++) {
    for (let x = Math.floor(b.left); x < Math.ceil(b.right); x++) {
      const cover = (Math.min(x + 1, b.right) - Math.max(x, b.left)) * (Math.min(y + 1, b.bottom) - Math.max(y, b.top));
      const a = c.a * cover;
      const i = 4 * (y * img.width + x);
      img.data[i] = img.data[i] * (1 - a) + c.r * a;
      img.data[i + 1] = img.data[i + 1] * (1 - a) + c.g * a;
      img.data[i + 2] = img.data[i + 2] * (1 - a) + c.b * a;
    }
  }
}

function ink(img: Img, b: Box): void {
  for (let y = Math.round(b.top); y < Math.round(b.bottom); y++) {
    for (let x = Math.round(b.left); x < Math.round(b.right); x++) {
      const i = 4 * (y * img.width + x);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    }
  }
}

function transpose(img: Img): Img {
  const out = blank(img.height, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      for (let k = 0; k < 4; k++) out.data[4 * (x * out.width + y) + k] = img.data[4 * (y * img.width + x) + k]!;
    }
  }
  return out;
}
const flip = (b: Box): Box => ({ left: b.top, top: b.left, right: b.bottom, bottom: b.right });

/** Three 10 pt lines (13.3 px letters) 18 px apart; bands 15 px thick at fractional positions; three words of ink a line. */
function scene(mutate?: (lines: Box[], img: Img, glyphs: PaintGlyph[]) => void | (() => void)): { img: Img; options: PaintOptions } {
  const img = blank(400, 140);
  const centres = [40.3, 58.3, 76.3];
  const bands: Box[] = centres.map((c) => ({ left: 20, right: 360, top: c - 7.5, bottom: c + 7.5 }));
  const lines: Box[] = centres.map((c) => ({ left: 20, right: 360, top: c - 5.5, bottom: c + 5.5 }));
  const glyphs: PaintGlyph[] = [];
  centres.forEach((c) => {
    for (const [x0, x1] of [[22, 58], [100, 140], [320, 358]] as const) {
      const tight: Box = { left: x0, right: x1, top: c - 6, bottom: c + 4 };
      glyphs.push({ tight, loose: { left: x0 - 1, right: x1 + 1, top: c - 8, bottom: c + 6 }, fontSize: 10 });
    }
  });
  const options: PaintOptions = { orientation: 'h', dpr: 1, pxPerPt: 96 / 72, lines, glyphs, colour: TOKEN };
  const after = mutate ? mutate(bands, img, glyphs) : undefined;
  for (const b of bands) paint(img, b);
  for (const g of glyphs) ink(img, { left: g.tight.left + 3, right: g.tight.left + 5, top: g.tight.top + 1, bottom: g.tight.bottom - 1 });
  if (after) after();
  return { img, options };
}

describe('the painting judge (R44)', () => {
  const rows: [string, (b: Box[], img: Img, g: PaintGlyph[]) => void | (() => void), RegExp | null][] = [
    ['a clean selection passes', () => {}, null],
    ['one band 3 px taller than the others', (b) => void (b[1] = { ...b[1], top: b[1].top - 1.5, bottom: b[1].bottom + 1.5 }), /uneven heights/],
    [
      'two bands painted separately so they overlap and darken',
      (b, img) => {
        paint(img, { left: 20, right: 360, top: b[1].bottom - 4, bottom: b[1].bottom + 1 });
      },
      /painted twice/,
    ],
    ['the browser\'s own blue instead of the token', () => {}, /highlight colour/],
    ['a band that stops above the descenders', (_b, _i, g) => void (g[0].tight = { ...g[0].tight, bottom: g[0].tight.bottom + 5 }), /stops .* px above the bottom/],
    [
      'a white gap in the middle of a line',
      (_b, img) => () => {
        for (let y = 30; y < 90; y++) for (let x = 200; x < 204; x++) for (let k = 0; k < 3; k++) img.data[4 * (y * img.width + x) + k] = 255;
      },
      /unpainted pixels/,
    ],
    ['a band that ends 12 px short of the text', (b) => void (b[2] = { ...b[2], right: 346 }), /ends .* px from where the text ends/],
  ];
  it.each(rows)('%s', (name, mutate, expected) => {
    const s = scene(mutate);
    if (name.includes('browser')) {
      // Repaint everything in a native-looking selection colour, over a fresh page.
      const native = blank(400, 140);
      for (const b of s.options.lines) paint(native, { ...b, top: b.top - 2, bottom: b.bottom + 2 }, { r: 51, g: 144, b: 255, a: 0.5 });
      s.img.data.set(native.data);
    }
    const report = analyzeSelectionPaint(s.img, s.options);
    if (expected === null) {
      expect(report.problems).toEqual([]);
      expect(report.lines).toHaveLength(3);
      for (const l of report.lines) expect(l.thickness).toBeCloseTo(15, 0);
    } else {
      expect(report.problems.join('\n')).toMatch(expected);
    }
  });

  it('judges lines that run down the screen (a page turned by 90 degrees) the same way', () => {
    const s = scene();
    const turned: PaintOptions = { ...s.options, orientation: 'v', lines: s.options.lines.map(flip), glyphs: s.options.glyphs.map((g) => ({ ...g, tight: flip(g.tight), loose: flip(g.loose) })) };
    expect(analyzeSelectionPaint(transpose(s.img), turned).problems).toEqual([]);
  });

  it.each([
    ['rgba(11,87,208,.3)', { r: 11, g: 87, b: 208, a: 0.3 }],
    ['rgb(11 87 208 / 30%)', { r: 11, g: 87, b: 208, a: 0.3 }],
    ['#0b57d04d', { r: 11, g: 87, b: 208, a: 0x4d / 255 }],
  ])('reads the colour %s', (css, want) => {
    expect(parseCssColor(css)).toEqual(want);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** One glyph per char of `text`, 6 pt apart, with the box PDFium would give (loose box 12 pt tall at 10 pt). */
function line(text: string, o: { x: number; y: number; size?: number; angle?: number; start?: number }): Glyph[] {
  const size = o.size ?? 10;
  const angle = o.angle ?? 0;
  return [...text].map((ch, i) => {
    const along = i * 6;
    const x = angle === 270 ? o.x : o.x + along;
    const y = angle === 270 ? o.y - along : o.y;
    return { index: (o.start ?? 0) + i, text: ch, box: { x, y, width: 6, height: size * 1.2 }, tight: { x, y, width: 5, height: size }, fontSize: size, angle, generated: false };
  });
}
const gen = (index: number, text: string): Glyph => ({ index, text, box: { x: 0, y: 0, width: 0, height: 0 }, tight: { x: 0, y: 0, width: 0, height: 0 }, fontSize: 0, angle: 0, generated: true });

function page(...parts: Glyph[][]): Glyph[] {
  const all = parts.flat();
  return all.map((g, i) => ({ ...g, index: i }));
}

describe('the copy judge (R26)', () => {
  const twoLines = page(line('recurrent or', { x: 50, y: 100 }), [gen(0, '\r'), gen(0, '\n')], line('convolutional nets', { x: 50, y: 114 }));
  const superscript = page(line('area x', { x: 50, y: 100 }), [gen(0, '\r'), gen(0, '\n')], line('2', { x: 86, y: 98.5, size: 7 }), [gen(0, '\r'), gen(0, '\n')], line(' units', { x: 92, y: 100 }));
  // x in maths italic (U+1D465, two glyphs sharing one box) with its square on the line below the PDFium break.
  const mathsX = page(
    [
      { ...line('x', { x: 50, y: 100 })[0], text: '\uD835' },
      { ...line('x', { x: 50, y: 100 })[0], text: '\uDC65' },
    ],
    [gen(0, '\r'), gen(0, '\n')],
    line('2', { x: 56, y: 98.5, size: 7 }),
  );
  const rotated = page(line('Statio', { x: 200, y: 300, angle: 270 }), [gen(0, '\r'), gen(0, '\n')], line('n', { x: 200, y: 264, angle: 270 }));

  const rows: [string, Glyph[], string, RegExp | null][] = [
    ['two real lines keep their break', twoLines, 'recurrent or\nconvolutional nets', null],
    ['two real lines with CRLF', twoLines, 'recurrent or\r\nconvolutional nets', null],
    ['a real break turned into a space is a lost break', twoLines, 'recurrent or convolutional nets', /real line break was lost/],
    ['a real break that glues two words', twoLines, 'recurrent orconvolutional nets', /glued together/],
    ['a break inside a line, around a superscript, is joined', superscript, 'area x2 units', null],
    ['a break left around the superscript', superscript, 'area x\n2 units', /left inside a line/],
    ['maths italic x (two glyphs, one box) squared copies as x2 or the engine\'s own letters', mathsX, 'x2', null],
    ['maths italic x with the break left in', mathsX, '\uD835\uDC65\n2', /left inside a line/],
    ['rotated glyphs, each its own object, copy as one word', rotated, 'Station', null],
    ['rotated glyphs copied with PDFium\'s inner break', rotated, 'Statio\nn', /left inside a line/],
    ['a break the engine does not have', page(line('ab cd', { x: 0, y: 0 })), 'ab\ncd', /engine has a space but the copy has a line break/],
    ['a ligature glyph copies as its letters', page(line('o\uFB03ce', { x: 0, y: 0 })), 'office', null],
    ['different letters', page(line('office', { x: 0, y: 0 })), 'offise', /differ from the engine's text at letter 4/],
  ];
  it.each(rows)('%s', (_name, glyphs, copied, expected) => {
    const problems = copyProblems(glyphs, 0, glyphs.length, copied);
    if (expected === null) expect(problems).toEqual([]);
    else expect(problems.join('\n')).toMatch(expected);
  });

  it('squash drops every kind of whitespace and the invisible chars', () => {
    expect(squash(' a\r\nb\u00A0c\u00AD\uFFFEd\u0000 ')).toBe('abcd');
  });
});
