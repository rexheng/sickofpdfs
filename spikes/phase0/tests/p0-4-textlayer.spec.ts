import { expect } from '@playwright/test';
import { test } from './fixtures';
import { record } from './record';
import { RTL, TEXTLAYER_FIXTURES, TWO_COLUMN } from './textlayer-fixtures';

// The brief's suite. Two changes, both for the record: each test writes its measurements with record(),
// and the loops use expect.soft, so every pair and fixture is measured even after a miss (any miss still
// fails the test). Fixtures: `fixtures:textlayer` (tl-*.pdf) and `fixtures` (the arXiv papers).
const norm = (s: string) => s.normalize('NFKC').replace(/­/g, '').replace(/\s+/g, ' ').trim();
const px = (n: number) => Math.round(n * 1000) / 1000;

for (const f of TEXTLAYER_FIXTURES) for (const zoom of [1, 2]) {
  test(`P0-4 ${f.name} @${zoom * 100}%: drag selection maps to the PDFium char range`, async ({ textlayerPage }) => {
    const p = await textlayerPage(f, zoom);
    const pairs = p.seededPairs(20);
    let rangesOk = 0;
    let textOk = 0;
    const misses: string[] = [];
    for (const [a, b] of pairs) {
      const sel = await p.dragSelect(a, b); // mouse down at glyph a's centre, up at glyph b's centre
      const want = [{ pageIndex: f.page, start: Math.min(a, b), end: Math.max(a, b) + 1 }];
      const truth = await p.textRange(Math.min(a, b), Math.abs(b - a) + 1);
      const rangeOk = JSON.stringify(sel.ranges) === JSON.stringify(want);
      const copyOk = norm(sel.domText) === norm(truth);
      rangesOk += rangeOk ? 1 : 0;
      textOk += copyOk ? 1 : 0;
      if (!rangeOk || !copyOk) misses.push(`${a}→${b} got ${JSON.stringify(sel.ranges.map((r) => [r.start, r.end]))}${copyOk ? '' : ' text differs'}`);
      expect.soft(sel.ranges).toEqual(want);
      expect.soft(norm(sel.domText)).toBe(norm(truth));
    }
    await record('P0-4', {
      pass: rangesOk === pairs.length && textOk === pairs.length,
      measured: `${f.name}@${zoom * 100}% drag: ${rangesOk}/${pairs.length} ranges, ${textOk}/${pairs.length} text`,
      note: misses.length ? `${f.name}@${zoom * 100}%: ${misses.slice(0, 3).join(', ')}` : undefined,
    });
  });
  test(`P0-4 ${f.name} @${zoom * 100}%: every glyph edge within 1 px of PDFium's box`, async ({ textlayerPage }) => {
    const r = await (await textlayerPage(f, zoom)).alignment(); // along-text edges per char; ligature expansions split their box equally
    await record('P0-4', {
      pass: r.maxEdgeErrorPx < 1 && r.minVerticalOverlap >= 0.8,
      measured: `${f.name}@${zoom * 100}% edges: max ${px(r.maxEdgeErrorPx)} px, p99 ${px(r.p99EdgeErrorPx)} px over ${r.chars} chars, min vertical overlap ${px(r.minVerticalOverlap)}`,
      note: r.maxEdgeErrorPx >= 1 || r.minVerticalOverlap < 0.8 ? `${f.name}@${zoom * 100}% worst: ${r.worst}` : undefined,
    });
    expect(r.maxEdgeErrorPx).toBeLessThan(1);
    expect(r.minVerticalOverlap).toBeGreaterThanOrEqual(0.8);
  });
}
test('P0-4 generated LTR fixtures: select-all text equals the HTML ground truth', async ({ textlayerPage }) => {
  const results: string[] = [];
  for (const f of TEXTLAYER_FIXTURES.filter((x) => x.truth && x.dir === 'ltr')) {
    const text = norm(await (await textlayerPage(f, 1)).selectAllText());
    results.push(`${f.name} ${text === norm(f.truth!) ? 'equal' : 'differs'}`);
    expect.soft(text).toBe(norm(f.truth!));
  }
  await record('P0-4', { pass: results.every((r) => r.endsWith('equal')), measured: `select-all vs truth: ${results.join(', ')}` });
});
test('P0-4 two-column: dragging from column 1 bottom line to column 2 top line selects no column-2 lower text', async ({ textlayerPage }) => {
  const p = await textlayerPage(TWO_COLUMN, 1);
  const r = await p.dragColumns();
  // Positive control: the same normalised page text does contain the sentence.
  expect(norm(await p.selectAllText())).toContain(TWO_COLUMN.column2LastSentence);
  await record('P0-4', {
    pass: r.ranges.length === 1 && !r.domText.includes(TWO_COLUMN.column2LastSentence!),
    measured: `two-column drag across columns: ${r.ranges.length} range [${r.ranges.map((x) => `${x.start}–${x.end}`)}], ${r.domText.length} chars, column-2 last sentence ${r.domText.includes(TWO_COLUMN.column2LastSentence!) ? 'included' : 'not included'}`,
  });
  expect(r.ranges).toHaveLength(1);
  expect(r.domText).not.toContain(TWO_COLUMN.column2LastSentence);
});
test('P0-4 rtl: Hebrew runs carry dir="rtl" and a right-to-left drag gives the same range as left-to-right', async ({ textlayerPage }) => {
  const p = await textlayerPage(RTL, 1);
  const dirs = await p.runDirs();
  const rtlToLtr = (await p.dragSelect(p.lastGlyph, p.firstGlyph)).ranges;
  const ltrToRtl = (await p.dragSelect(p.firstGlyph, p.lastGlyph)).ranges;
  await record('P0-4', {
    pass: dirs.includes('rtl') && JSON.stringify(rtlToLtr) === JSON.stringify(ltrToRtl),
    measured: `rtl: ${dirs.filter((d) => d === 'rtl').length} of ${dirs.length} spans dir=rtl; drag ${p.lastGlyph}→${p.firstGlyph} ${JSON.stringify(rtlToLtr.map((r) => [r.start, r.end]))}, ${p.firstGlyph}→${p.lastGlyph} ${JSON.stringify(ltrToRtl.map((r) => [r.start, r.end]))}`,
  });
  expect(dirs).toContain('rtl');
  expect(rtlToLtr).toEqual(ltrToRtl);
});
