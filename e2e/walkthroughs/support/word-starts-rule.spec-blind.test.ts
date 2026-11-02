// The measuring behind walkthrough 19 (word-starts-rule.spec-blind.ts), checked on pictures made here, where the right answer is known. The walkthrough's verdict on the
// product is only as good as this: if the rule were worked out wrongly, or the ink gain could not tell a bold letter from a plain one, the walkthrough would pass or fail
// the product for the wrong reason. Table-driven; no browser.
import { describe, expect, it } from 'vitest';
import type { Glyph } from '../../../packages/viewer/src/backend/types';
import type { PageMap } from '../../support/tl-blind.spec-blind';
import { BOLD_AT, boldCount, changedShare, coverageGaps, judge, modelOf, pressable } from './word-starts-rule.spec-blind';
import type { Shot } from './marks.spec-blind';

// ---------------------------------------------------------------------------------------------------------------
// Glyphs made from a string: one glyph per character, 10 pt wide boxes in a row, a '\n' is the line break PDFium puts in (generated, no box)

function glyphsOf(text: string): Glyph[] {
  const out: Glyph[] = [];
  let x = 4;
  let line = 0;
  for (const ch of text) {
    const index = out.length;
    if (ch === '\n') {
      out.push({ index, text: '\n', box: { x, y: 10 + line * 30, width: 0, height: 0 }, tight: { x, y: 10 + line * 30, width: 0, height: 0 }, fontSize: 40, angle: 0, generated: true });
      line++;
      x = 4;
      continue;
    }
    const box = { x, y: 10 + line * 30, width: 8, height: 12 };
    // 40 pt: the read box grows by 1.6 px each side, so a 1 px halo is inside it; letters are 2 px apart, so a halo reaches the next letter's box
    out.push({ index, text: ch, box, tight: ch === ' ' ? { ...box, width: 0 } : { x, y: box.y + 1, width: 6, height: 10 }, fontSize: 40, angle: 0, generated: false });
    x += 8;
  }
  return out;
}

const bolds = (text: string): string => {
  const g = glyphsOf(text);
  const m = modelOf(g, 0, g.length - 1);
  return m.wants.filter((w) => w.want === 'bold').map((w) => w.ch).join('');
};

describe('boldCount: the first half rounded up, and the first letter of a short word', () => {
  it.each([
    [1, 1], [2, 1], [3, 1], [4, 2], [5, 3], [6, 3], [7, 4], [8, 4], [9, 5], [10, 5], [11, 6], [12, 6], [13, 7], [14, 7],
  ])('a word of %i letters bolds %i', (letters, bold) => {
    expect(boldCount(letters)).toBe(bold);
  });
});

describe('modelOf: which chars the rule wants bold', () => {
  it.each([
    ['a', 'a'],
    ['an', 'a'],
    ['and', 'a'],
    ['Read', 'Re'],
    ['model', 'mod'],
    ['Reading', 'Read'],
    ['method', 'met'],
    ['facilitating', 'facili'],
    ['The dominant models', 'Tdomin' + 'mod'.slice(0, 0) + 'mod'], // The=T, dominant(8)=domi, models(6)=mod
  ])('%s', (text, _bold) => {
    // Each row is written out below; the first-letter rows are the simple ones
    if (text === 'The dominant models') return expect(bolds(text)).toBe('T' + 'domi' + 'mod');
    expect(bolds(text)).toBe(_bold);
  });

  it('leaves pure numbers alone, whatever their punctuation: "28.4 BLEU on 2014" bolds only BL and o', () => {
    const g = glyphsOf('28.4 BLEU on 2014');
    const m = modelOf(g, 0, g.length - 1);
    expect(m.wants.filter((w) => w.want === 'bold').map((w) => w.ch).join('')).toBe('BLo');
    expect(m.numbers).toEqual(['28', '4', '2014']);
    expect(m.wants.filter((w) => w.kind === 'digit').every((w) => w.want === 'plain')).toBe(true);
  });

  it('takes each part of a hyphenated word as its own word: "state-of-the-art" bolds sta, o, t, a: "staota"', () => {
    expect(bolds('state-of-the-art')).toBe('staota');
    const g = glyphsOf('state-of-the-art');
    expect(modelOf(g, 0, g.length - 1).hyphens).toBe(3);
  });

  it('takes a word broken across lines per line: "transduc-" then "tion" bolds tran and ti', () => {
    expect(bolds('and transduc-\ntion models')).toBe('a' + 'tran' + 'ti' + 'mod');
  });

  it('says what it does not judge: a ligature word, letters mixed with digits, accented letters', () => {
    const g = glyphsOf('significantly H100 café ok');
    const m = modelOf(g, 0, g.length - 1);
    expect(m.skipped.map((s) => s.split(' ')[0])).toEqual(['significantly', 'H100', 'café']);
    expect(m.list).toEqual(['ok']);
  });

  it('judges only the range it is given, both ends included', () => {
    const g = glyphsOf('one two three');
    const m = modelOf(g, 4, 6);
    expect(m.list).toEqual(['two']);
  });
});

describe('coverageGaps: a passage is a fair test only if it holds every case of the rule', () => {
  it('the whole range of cases has no gap, and a short passage names what is missing', () => {
    const fair = glyphsOf('a an and Read model Reading method 28 well-known');
    expect(coverageGaps(modelOf(fair, 0, fair.length - 1))).toEqual([]);
    const poor = glyphsOf('the cat sat');
    expect(coverageGaps(modelOf(poor, 0, poor.length - 1))).toEqual(
      expect.arrayContaining(['a one-letter word', 'a two-letter word', 'a four-letter word (half of 4 is 2)', 'a number', 'a hyphen']),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pictures: every letter is a dark 6 x 10 box on white (at 1 px per point). A bold letter has a one-pixel halo round it; "full" has the halo on every letter.

const W = 330;
const H = 80;
const map: PageMap = {
  pxPerPt: 1,
  orientation: 'h',
  toClient: (x, y) => ({ x, y }),
  box: (r) => ({ left: r.x, right: r.x + r.width, top: r.y, bottom: r.y + r.height }),
};

function picture(glyphs: Glyph[], haloOn: (g: Glyph) => boolean, halo = 1): Shot {
  const data = new Uint8Array(W * H * 4).fill(255);
  const dark = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = 0;
  };
  for (const g of glyphs) {
    if (g.generated || g.tight.width === 0) continue;
    const grow = haloOn(g) ? halo : 0;
    for (let y = g.tight.y - grow; y < g.tight.y + g.tight.height + grow; y++) for (let x = g.tight.x - grow; x < g.tight.x + g.tight.width + grow; x++) dark(Math.round(x), Math.round(y));
  }
  return { img: { width: W, height: H, data }, dpr: 1 };
}

describe('judge: it tells what the page draws from the three pictures', () => {
  const text = 'Reading models. 28.4 is well-known\nand ok';
  const glyphs = glyphsOf(text);
  const model = modelOf(glyphs, 0, glyphs.length - 1);
  const run = (drawn: (index: number) => boolean) => {
    const off = picture(glyphs, () => false);
    const full = picture(glyphs, () => true);
    const on = picture(glyphs, (g) => drawn(g.index));
    return judge({ glyphs, a: 0, b: glyphs.length - 1, map, off, full, on });
  };
  const wanted = new Set(model.wants.filter((w) => w.want === 'bold').map((w) => w.index));

  it('finds nothing wrong when the page draws exactly what the rule wants, and reads the stroke as about the bold mark\'s', () => {
    const v = run((i) => wanted.has(i));
    expect(v.mismatches).toEqual([]);
    expect(v.assessed).toBeGreaterThan(20);
    expect(v.strokeRatio).toBeGreaterThanOrEqual(0.7); // below 1 because in the bold-mark picture every letter's neighbours are bold too
  });

  it('finds the rounding wrong when the page bolds the first half rounded DOWN (7 letters: 3, not 4)', () => {
    const down = new Set(model.wants.filter((w) => w.kind === 'letter' && w.pos < Math.floor(w.word.length / 2)).map((w) => w.index));
    for (const w of model.wants) if (w.kind === 'letter' && w.word.length <= 3 && w.pos === 0) down.add(w.index);
    const v = run((i) => down.has(i));
    expect(v.byRule.offByOne.length).toBeGreaterThan(0);
    expect(v.byRule.offByOne.join('\n')).toMatch(/"Reading"|"models"|"well"|"known"/);
    expect(v.byRule.numbersBold).toEqual([]);
  });

  it('finds the rest of the word bold when the page draws whole words', () => {
    const v = run((i) => model.wants.some((w) => w.index === i && w.kind === 'letter'));
    expect(v.mismatches.length).toBeGreaterThan(0);
    expect(v.byRule.numbersBold).toEqual([]);
  });

  it('finds numbers drawn bold, and a first letter drawn plain', () => {
    const digits = model.wants.filter((w) => w.kind === 'digit').map((w) => w.index);
    const v1 = run((i) => wanted.has(i) || digits.includes(i));
    expect(v1.byRule.numbersBold.length).toBe(digits.length);
    const firsts = new Set(model.wants.filter((w) => w.kind === 'letter' && w.pos === 0).map((w) => w.index));
    const v2 = run((i) => wanted.has(i) && !firsts.has(i));
    expect(v2.byRule.firstLetterPlain.length).toBe(firsts.size);
  });

  it('finds a page that draws nothing: every letter the rule wants bold is plain, and the bold gain is nil', () => {
    const v = run(() => false);
    expect(v.mismatches.length).toBe(wanted.size);
    expect(v.medianOn).toBeLessThan(0.01);
  });

  it('is not fooled by a neighbour: a bold letter right beside a plain one leaves the plain one under the threshold', () => {
    const v = run((i) => wanted.has(i));
    expect(v.worstPlain).toBeLessThan(BOLD_AT);
    expect(v.worstBold).toBeGreaterThan(BOLD_AT);
  });
});

describe('changedShare: how much of a picture changed', () => {
  const a = picture(glyphsOf('ab'), () => false);
  const b = picture(glyphsOf('ab'), () => true);
  const all = { left: 0, top: 0, right: W, bottom: H };
  it('is 0 for the same picture, positive for a heavier one, and leaves out what it is told to', () => {
    expect(changedShare(a, a, all)).toBe(0);
    const share = changedShare(a, b, all);
    expect(share).toBeGreaterThan(0);
    expect(changedShare(a, b, all, 2, [all])).toBe(0);
  });
});

describe('pressable: a key as the shortcut sheet prints it, as Playwright presses it', () => {
  it.each([
    ['Ctrl+Alt+B', 'Control+Alt+b'],
    ['Alt+Shift+5', 'Alt+Shift+5'],
    ['Shift+F4', 'Shift+F4'],
    ['B', 'b'],
    ['Ctrl+Plus', 'Control++'],
    ['Ctrl+Minus', 'Control+-'],
  ])('%s is pressed as %s', (printed, pressed) => {
    expect(pressable(printed)).toBe(pressed);
  });
});
