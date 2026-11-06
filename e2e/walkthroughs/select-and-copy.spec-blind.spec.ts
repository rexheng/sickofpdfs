// User tests for Task 22: "Select text ... Ctrl+C". The owner drags over a paragraph in a real paper and pastes it
// somewhere else. Copy is judged against PDFium's own text for the range (R26): the same letters in the same order, real
// line breaks kept, and a break PDFium put in the middle of a line (around a superscript, between rotated glyphs) joined.
// Spec: "Select text, right-click, mark it or comment" (mission); "Phase 0 checks this with a selection test suite,
// including copy-paste matching Chrome's viewer"; carried requirements R26 and R27.
import { copyProblems, squash } from '../support/tl-copy.spec-blind';
import { expect, test } from '../support/test';
import {
  clearSelection,
  copySelection,
  dragGlyphs,
  findOnPage,
  fixture,
  glyphsOf,
  inclusive,
  isVisible,
  openClipboardReader,
  openFixture,
  readSelection,
  rangeText,
  truthOf,
} from '../support/tl-blind.spec-blind';

test.setTimeout(120_000);

const PARAGRAPHS = [
  // The abstract of "Attention Is All You Need": one wide paragraph of 14 lines, hyphenated at a line end ("English-to-German").
  { name: 'attention-p1', from: 'The dominant sequence transduction models', to: 'limited training data.' },
  // The abstract of ResNet: a column paragraph with a footnote mark ("competitions1") that makes PDFium break the line.
  { name: 'resnet-p1', from: 'Deeper neural networks are more difficult', to: 'and 1000 layers.' },
];

test('Select and copy: abstracts give the engine\'s text, and line breaks inside lines are joined', async ({ step }, testInfo) => {
  test.setTimeout(480_000);
  for (const p of PARAGRAPHS) {
    await step(`drag over the ${p.name} abstract, Ctrl+C gives the engine's text`, async ({ openViewer, server, context }) => {
      const reader = await openClipboardReader(context, server);
      const o = await openFixture(openViewer, server, fixture(p.name));
      const glyphs = await glyphsOf(o.page, o.pageIndex);

      const first = await findOnPage(o.page, o.pageIndex, p.from);
      const last = await findOnPage(o.page, o.pageIndex, p.to);
      const a = first.start;
      const b = last.start + last.count - 1;
      expect(isVisible(glyphs[a]), 'the first glyph of the paragraph can be aimed at').toBe(true);
      expect(isVisible(glyphs[b]), 'the last glyph of the paragraph can be aimed at').toBe(true);

      const { ranges, domText } = await dragGlyphs(o.page, o.pageIndex, a, b);
      await o.page.screenshot({ path: testInfo.outputPath(`t22-${p.name}-paragraph-selected.png`) });
      expect(ranges, 'the drag from the first glyph to the last selects exactly that paragraph, both ends included (R27)').toEqual([inclusive(o.pageIndex, a, b)]);
      expect(domText.length, 'the browser selection is kept, for find and screen readers').toBeGreaterThan(0);

      const copied = await copySelection(o.page, reader);
      expect(copied, 'Ctrl+C put text on the clipboard').not.toBe('');
      expect(copied).not.toMatch(/[\uFB00-\uFB06\uFFFE]/u);
      expect(copied.includes('\u0000'), 'no NUL on the clipboard').toBe(false); // ligature letters, NUL and the hyphen-join mark never reach the clipboard
      const problems = copyProblems(glyphs, a, b + 1, copied);
      expect(problems, `copied text, judged against the engine's ${b + 1 - a} chars:\n${copied}`).toEqual([]);
      expect(squash(copied)).toBe(squash(await rangeText(o.page, o.pageIndex, a, b + 1)));

      // Clicking elsewhere lets go of the selection; the highlight and the copy go with it.
      await clearSelection(o.page);
      expect((await readSelection(o.page)).ranges).toEqual([]);
      expect(o.errors).toEqual([]);
      await reader.close();
    }, 120_000);
  }
  // PDFium inserts its own line breaks where a run changes baseline or direction. R26 / "join a break when the next glyph
  // continues the same baseline/word": the copy must not carry them.
  for (const name of ['rotated-table', 'maths'] as const) {
    await step(`copying the ${name} page joins the line breaks PDFium put inside lines`, async ({ openViewer, server, context }) => {
      const reader = await openClipboardReader(context, server);
      const fx = fixture(name);
      const o = await openFixture(openViewer, server, fx);
      const glyphs = await glyphsOf(o.page, o.pageIndex);
      const visible = glyphs.filter(isVisible);
      const a = visible[0].index;
      const b = visible[visible.length - 1].index;

      const { ranges } = await dragGlyphs(o.page, o.pageIndex, a, b);
      expect(ranges, 'one drag from the first to the last glyph selects the whole text').toEqual([inclusive(o.pageIndex, a, b)]);
      const copied = await copySelection(o.page, reader);
      expect(copied).not.toBe('');

      expect(copyProblems(glyphs, a, b + 1, copied), `copied:\n${copied}`).toEqual([]);

      // The hand-written truth of the page, as a reader would copy it: every word whole and in order.
      const truth = truthOf(fx);
      expect(truth, 'the fixture truth (.txt) is next to the fixture sources').not.toBeNull();
      expect(squash(copied)).toBe(squash(truth!));
      let cursor = 0;
      // Triage (TB1): the copy keeps the engine's maths italic letters (U+1D465 for x), as the copy judge above allows;
      // the truth has plain letters, so the words are looked for in the NFKC-folded copy, as squash() compares it.
      const folded = copied.normalize('NFKC');
      for (const word of truth!.split(/\s+/u).filter(Boolean)) {
        const at = folded.indexOf(word, cursor);
        expect(at, `"${word}" is whole and in order in:\n${folded}`).toBeGreaterThanOrEqual(0);
        cursor = at + word.length;
      }
    }, 120_000);
  }
});
