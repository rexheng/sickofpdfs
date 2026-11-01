import { expect } from '@playwright/test';
import { test } from './fixtures';
import { record } from './record';
import { RTL, TEXTLAYER_FIXTURES, TWO_COLUMN } from './textlayer-fixtures';

// The brief's suite. Changes: each test writes its measurements with record(); the drag loop uses
// expect.soft, so every pair is measured even after a miss (any miss still fails the test); select-all is one
// test per page against PDFium's text (see below). Fixtures: `fixtures:textlayer` (tl-*.pdf) and `fixtures`.
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
      measured: `${f.name}@${zoom * 100}% drag ${rangesOk}/${pairs.length}${textOk === rangesOk ? '' : ` (text ${textOk}/${pairs.length})`}`,
      note: misses.length ? `${f.name}@${zoom * 100}%: ${misses.slice(0, 3).join(', ')}` : undefined,
    });
  });
  test(`P0-4 ${f.name} @${zoom * 100}%: every glyph edge within 1 px of PDFium's box`, async ({ textlayerPage }) => {
    const r = await (await textlayerPage(f, zoom)).alignment(); // along-text edges per char; ligature expansions split their box equally
    await record('P0-4', {
      pass: r.maxEdgeErrorPx < 1 && r.minVerticalOverlap >= 0.8,
      measured: `${f.name}@${zoom * 100}% edge ${px(r.maxEdgeErrorPx)} px, overlap ${px(r.minVerticalOverlap)}`,
      note: r.maxEdgeErrorPx >= 1 || r.minVerticalOverlap < 0.8 ? `${f.name}@${zoom * 100}% worst: ${r.worst}` : undefined,
    });
    expect(r.maxEdgeErrorPx).toBeLessThan(1);
    expect(r.minVerticalOverlap).toBeGreaterThanOrEqual(0.8);
  });
}
// Select-all, one test per page. The yardstick is PDFium's own text for the whole page (ruling R26: copy is
// judged against Chrome's viewer, i.e. FPDFText), so a dropped or doubled char in the layer fails here. The
// generated LTR fixtures are also compared with their HTML ground truth: exactly, except where PDFium is known
// to insert line breaks of its own (PDFIUM_LINE_BREAKS), where only the text with all whitespace removed must
// match. That difference is the engine limitation R26 records, not a layer defect.
const PDFIUM_LINE_BREAKS = new Set(['rotated-table', 'maths']); // "Statio⏎n⏎D⏎e⏎pth", "x⏎2"
const squash = (s: string) => norm(s).replace(/\s+/g, '');
const firstDiff = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i === a.length && i === b.length ? '' : `first difference at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 15), i + 15))} vs ${JSON.stringify(b.slice(Math.max(0, i - 15), i + 15))}`;
};
for (const f of TEXTLAYER_FIXTURES) {
  const truth = f.truth && f.dir === 'ltr' ? f.truth : undefined; // the brief compares generated LTR fixtures only
  const limit = PDFIUM_LINE_BREAKS.has(f.name);
  test(`P0-4 ${f.name}: select-all text equals PDFium's page text${truth ? (limit ? ' and, apart from PDFium line breaks, the HTML ground truth' : ' and the HTML ground truth') : ''}`, async ({ textlayerPage }) => {
    const p = await textlayerPage(f, 1);
    const dom = norm(await p.selectAllText());
    const pdfium = norm(await p.textRange(0, p.info.glyphs));
    const parts = [`${f.name} select-all ${dom === pdfium ? '= PDFium text' : '≠ PDFium text'} (${dom.length} chars)`];
    const notes = [firstDiff(dom, pdfium)];
    if (truth) {
      const exact = dom === norm(truth);
      const squashed = squash(dom) === squash(truth);
      parts.push(exact ? '= truth' : limit && squashed ? '= truth but for PDFium line breaks (R26 engine limit)' : '≠ truth');
      if (!exact) notes.push(`vs truth ${firstDiff(dom, norm(truth))}`);
      if (limit) test.info().annotations.push({ type: 'engine-limit', description: `PDFium inserts line breaks into this text (R26): ${firstDiff(dom, norm(truth))}` });
    }
    await record('P0-4', {
      pass: dom === pdfium && (!truth || (limit ? squash(dom) === squash(truth) : dom === norm(truth))),
      measured: parts.join('; '),
      note: notes.filter(Boolean).join('; ') || undefined,
    });
    expect(dom).toBe(pdfium);
    if (truth && limit) expect(squash(dom)).toBe(squash(truth));
    else if (truth) expect(dom).toBe(norm(truth));
  });
}
test('P0-4 two-column: dragging from column 1 bottom line to column 2 top line selects no column-2 lower text', async ({ textlayerPage }) => {
  const p = await textlayerPage(TWO_COLUMN, 1);
  const r = await p.dragColumns();
  // Positive control: the same normalised page text does contain the sentence.
  expect(norm(await p.selectAllText())).toContain(TWO_COLUMN.column2LastSentence);
  await record('P0-4', {
    pass: r.ranges.length === 1 && !r.domText.includes(TWO_COLUMN.column2LastSentence!),
    measured: `column drag: ${r.ranges.length} range, ${r.domText.length} chars, ${r.domText.includes(TWO_COLUMN.column2LastSentence!) ? 'includes' : 'no'} column-2 lower text`,
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
    measured: `rtl: ${dirs.filter((d) => d === 'rtl').length}/${dirs.length} spans rtl; drags both ways ${JSON.stringify(rtlToLtr.map((r) => [r.start, r.end]))} and ${JSON.stringify(ltrToRtl.map((r) => [r.start, r.end]))}`,
  });
  expect(dirs).toContain('rtl');
  expect(rtlToLtr).toEqual(ltrToRtl);
});
