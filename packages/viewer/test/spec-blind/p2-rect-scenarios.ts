// The R44 scenarios, written once and run on whatever hands out line rectangles: the engine's getTextRangeRects, and the
// PageTextProvider that wraps it (S7). Real pages come from test-assets/classifier; the rest are generated with pdf-lib.
//
// Sources: the plan's S7 ("marks use the same PDFium line rects as the selection (R44), so they look as clean as
// Chrome's"), the Phase 1 plan's carried requirement R44 ("uniform line heights, no overlap bands, edges that follow the
// text"), PdfBackend.getTextRangeRects ("one rectangle per line, and per column where a line crosses a column gap;
// rectangles of different lines do not overlap unless the text itself does"), and the owner's brief for this slice.
import { describe, expect, it } from 'vitest';
import { PAPER_PARAGRAPHS } from '../../../core/test/spec-blind/anchoring-fixtures';
import type { DocHandle, Glyph, PdfBackend, PdfRect } from '../../src/backend/types';
import { classifier, copyOf } from './browser-helpers';
import { setPdfRotation, typesetPdf } from './p2-pdf-fixtures';
import type { RectSource } from './p2-rect-checks';
import { expectCovers, expectEdges, expectNoOverlap, expectSane, expectSeparateColumns, expectUniformHeights, right, selectedGlyphs } from './p2-rect-checks';

export interface ScenarioHost {
  title: string;
  backend: () => PdfBackend;
  rectsOf: (be: PdfBackend, doc: DocHandle) => RectSource;
}

const SLOW = 90_000;

export function defineRectScenarios(host: ScenarioHost): void {
  describe(host.title, () => {
    async function withPdf<T>(bytes: Uint8Array, fn: (x: { be: PdfBackend; doc: DocHandle; rectsOf: RectSource; pages: { width: number; height: number }[] }) => Promise<T>): Promise<T> {
      const be = host.backend();
      const info = await be.open(copyOf(bytes));
      try {
        return await fn({ be, doc: info.doc, rectsOf: host.rectsOf(be, info.doc), pages: info.pages });
      } finally {
        await be.close(info.doc).catch(() => undefined);
      }
    }

    /** First hit of `query` on a page: the PDFium char range the engine itself reports. */
    async function hit(be: PdfBackend, doc: DocHandle, page: number, query: string, nth = 0) {
      const hits = await be.searchPage(doc, page, query, { matchCase: true, wholeWord: false });
      if (!hits[nth]) throw new Error(`fixture error: ${JSON.stringify(query)} (#${nth}) is not on page ${page}`);
      return hits[nth];
    }
    const span = (a: { start: number }, b: { start: number; count: number }) => ({ start: a.start, count: b.start + b.count - a.start });

    it('a real paragraph (ResNet abstract, 12 lines): one rectangle per line, all the same height, no overlap, covering every glyph', async () => {
      await withPdf(await classifier('learning/arxiv-1512.03385-resnet.pdf'), async ({ be, doc, rectsOf, pages }) => {
        const { start, count } = span(await hit(be, doc, 0, 'Deeper neural networks are more difficult to train.'), await hit(be, doc, 0, '100 and 1000 layers.'));
        const rects = await rectsOf(0, start, count);
        const sel = selectedGlyphs((await be.getPageGlyphs(doc, 0)).glyphs, start, count);
        expect(sel.lines.length, 'precondition: the abstract is a paragraph of many lines').toBeGreaterThanOrEqual(10);

        expectSane(rects, pages[0], 'abstract');
        expect(rects, 'one rectangle per line').toHaveLength(sel.lines.length);
        expectUniformHeights(rects, 0.02, 'abstract');
        expectNoOverlap(rects, 'abstract');
        expectCovers(rects, sel, 'abstract');
        expectEdges(rects, sel, 'abstract');
        // reading order: top to bottom, and the lines do not trade places
        for (let i = 1; i < rects.length; i++) expect(rects[i].y, `rect ${i} is below rect ${i - 1}`).toBeGreaterThan(rects[i - 1].y);
      });
    }, SLOW);

    it('prose set line by line, full lines, leading equal to the type size: same height, lines touch but do not overlap', async () => {
      const set = await typesetPdf(PAPER_PARAGRAPHS[1], { wrapAt: 74, fontSize: 11, leading: 11 });
      await withPdf(set.bytes, async ({ be, doc, rectsOf, pages }) => {
        const text = await be.getPageText(doc, 0);
        const rects = await rectsOf(0, 0, text.length);
        const sel = selectedGlyphs((await be.getPageGlyphs(doc, 0)).glyphs, 0, text.length);
        expectSane(rects, pages[0], 'tight prose');
        expect(rects).toHaveLength(set.lines.length);
        expectNoOverlap(rects, 'tight prose');
        expectCovers(rects, sel, 'tight prose');
        // full lines of one paragraph: every line but each paragraph's last, which is short (and its ink may have no ascender or descender)
        const full = rects.filter((_, i) => set.lines[i + 1]?.paragraph === set.lines[i].paragraph);
        expect(full.length, 'precondition: several full lines').toBeGreaterThanOrEqual(5);
        expectUniformHeights(full, 0.03, 'tight prose, full lines');
      });
    }, SLOW);

    it.each([['column'], ['row']] as const)('two columns drawn in %s order: a rectangle per line per column, none across the gutter', async (order) => {
      const set = await typesetPdf(PAPER_PARAGRAPHS.flat(), { columns: 2, order, wrapAt: 34, fontSize: 10, leading: 12, page: [612, 300] });
      await withPdf(set.bytes, async ({ be, doc, rectsOf, pages }) => {
        const text = await be.getPageText(doc, 0);
        const rects = await rectsOf(0, 0, text.length);
        const sel = selectedGlyphs((await be.getPageGlyphs(doc, 0)).glyphs, 0, text.length);
        const onPage = set.lines.filter((l) => l.page === 0);
        expect(onPage.some((l) => l.column === 1), 'precondition: the page really has two columns').toBe(true);

        expectSane(rects, pages[0], 'two columns');
        // The gutter is the gap between the columns: 24 pt, centred on the page
        expectSeparateColumns(rects, 306 - 12, 306 + 12, 'two columns');
        expect(rects, 'a rectangle per line').toHaveLength(onPage.length);
        expectNoOverlap(rects, 'two columns');
        expectCovers(rects, sel, 'two columns');
        // no rectangle is wider than a column
        for (const r of rects) expect(r.width, `a rectangle ${JSON.stringify(r)} wider than a column`).toBeLessThanOrEqual((612 - 120 - 24) / 2 + 1);
      });
    }, SLOW);

    it('a real two-column page (ResNet p.1): a selection from the foot of the left column to the top of the right gives separate rectangles', async () => {
      await withPdf(await classifier('learning/arxiv-1512.03385-resnet.pdf'), async ({ be, doc, rectsOf, pages }) => {
        const glyphs = (await be.getPageGlyphs(doc, 0)).glyphs.filter((g) => !g.generated);
        // the char where reading jumps from the left column (x < 290) to the right one (x > 305), low on the page then high
        const jump = glyphs.find((g, i) => i > 0 && g.box.x > 305 && glyphs[i - 1].box.x + glyphs[i - 1].box.width < 290 && g.box.y < glyphs[i - 1].box.y - 200);
        if (!jump) throw new Error('fixture error: no jump from the left column to the right one on ResNet p.1');
        const start = jump.index - 160;
        const count = 400;
        const rects = await rectsOf(0, start, count);
        const sel = selectedGlyphs((await be.getPageGlyphs(doc, 0)).glyphs, start, count);

        expectSane(rects, pages[0], 'real columns');
        expectSeparateColumns(rects, 290, 305, 'real columns');
        expectNoOverlap(rects, 'real columns');
        expectCovers(rects, sel, 'real columns');
      });
    }, SLOW);

    it('a selection that starts and ends in the middle of a line paints from the first glyph to the last, no more', async () => {
      await withPdf(await classifier('learning/arxiv-1512.03385-resnet.pdf'), async ({ be, doc, rectsOf }) => {
        const { start, count } = span(await hit(be, doc, 0, 'difficult to train. We'), await hit(be, doc, 0, 'learning framework to ease'));
        const rects = await rectsOf(0, start, count);
        const sel = selectedGlyphs((await be.getPageGlyphs(doc, 0)).glyphs, start, count);
        expect(sel.lines.length).toBe(2);
        expect(rects).toHaveLength(2);
        expectEdges(rects, sel, 'mid-line');
        expectCovers(rects, sel, 'mid-line');
        // the first rectangle starts well to the right of the text column's left edge; the second stops short of its right edge
        expect(rects[0].x).toBeGreaterThan(100);
        expect(right(rects[1])).toBeLessThan(250);
      });
    }, SLOW);

    it.each([90, 180, 270] as const)('a page with /Rotate %i gives the same rectangles as the upright page: they are in unrotated page space', async (rotate) => {
      const { bytes } = await typesetPdf(PAPER_PARAGRAPHS[1], { wrapAt: 74, fontSize: 11, leading: 16 });
      const key = (r: PdfRect) => [r.x, r.y, r.width, r.height].map((n) => n.toFixed(1)).join(',');
      const upright = await withPdf(bytes, async ({ be, doc, rectsOf }) => rectsOf(0, 0, (await be.getPageText(doc, 0)).length));
      await withPdf(await setPdfRotation(bytes, rotate), async ({ be, doc, rectsOf, pages }) => {
        expect(pages[0], 'precondition: the page is a rotated page').toMatchObject({ rotation: rotate, width: 612, height: 792 });
        const text = await be.getPageText(doc, 0);
        const rects = await rectsOf(0, 0, text.length);
        // PDFium may read a turned page in another order (at /Rotate 90 it starts with the last line), so compare as sets
        expect(rects.map(key).sort(), `/Rotate ${rotate}`).toEqual(upright.map(key).sort());
        const sel = selectedGlyphs((await be.getPageGlyphs(doc, 0)).glyphs, 0, text.length);
        expectSane(rects, pages[0], `/Rotate ${rotate}`);
        expect(rects).toHaveLength(sel.lines.length);
        expectNoOverlap(rects, `/Rotate ${rotate}`);
        expectCovers(rects, sel, `/Rotate ${rotate}`);
      });
    }, SLOW);

    it('text that runs up the margin (the arXiv stamp on ResNet p.1) is one tall, narrow rectangle that covers its glyphs', async () => {
      await withPdf(await classifier('learning/arxiv-1512.03385-resnet.pdf'), async ({ be, doc, rectsOf, pages }) => {
        const stamp = await hit(be, doc, 0, 'arXiv:1512.03385');
        const g: Glyph[] = (await be.getPageGlyphs(doc, 0)).glyphs;
        const first = g[stamp.start];
        expect([90, 270].map((a) => Math.abs(((first.angle - a + 540) % 360) - 180)).some((d) => d > 170), `precondition: the stamp is vertical text, angle ${first.angle}`).toBe(true);
        // the whole stamp line: from its first char to the generated break after it
        let end = stamp.start;
        while (end < g.length && !g[end].generated) end++;
        const count = end - stamp.start;
        const rects = await rectsOf(0, stamp.start, count);
        const sel = selectedGlyphs(g, stamp.start, count);
        expectSane(rects, pages[0], 'margin text');
        expect(rects, 'one rectangle for one line of text').toHaveLength(1);
        expect(rects[0].height, 'taller than wide').toBeGreaterThan(rects[0].width * 4);
        expect(rects[0].x, 'in the left margin').toBeLessThan(40);
        expectCovers(rects, sel, 'margin text');
      });
    }, SLOW);
  });
}
