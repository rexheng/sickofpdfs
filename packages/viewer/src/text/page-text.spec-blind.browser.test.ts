// Spec-blind browser tests for PageTextProvider / createPageTextProvider (S7, packages/viewer/src/text/page-text.ts).
//
// Sources: contracts section 2 ("PageTextProvider: the one way marks, find and Claude read text"; text, glyphs, rects =
// merged line rects "FPDFText_CountRects/GetRect, R44", search; source = 'pdfium' | 'ocr:<engine>@<version>') and the
// plan's S7 ("Its rects call wraps Task 22's getTextRects and caches results per page"; in this repo that call is
// PdfBackend.getTextRangeRects). The provider must hand out exactly what the engine does, only faster the second time, and
// the marks drawn from it must be as clean as the engine's own rectangles (the same R44 scenarios run on it here).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifier, copyOf } from '../../test/spec-blind/browser-helpers';
import { defineRectScenarios } from '../../test/spec-blind/p2-rect-scenarios';
import { engineAssets } from '../backend/embedpdf/assets';
import { createEmbedPdfBackend } from '../backend/embedpdf/backend';
import type { DocHandle, PdfBackend } from '../backend/types';
import { createPageTextProvider } from './page-text';

const ASSETS = engineAssets((path) => new URL(`/apps/extension/public/${path}`, globalThis.location.href).href);
const SLOW = 90_000;

let backend: PdfBackend;
beforeAll(() => {
  backend = createEmbedPdfBackend(ASSETS);
});
afterAll(() => {
  (backend as { dispose?: () => void }).dispose?.();
});

/** The backend with a tally of how often each method is called. */
function counting(be: PdfBackend) {
  const calls = new Map<string, number>();
  const proxy = new Proxy(be, {
    get(target, key, receiver) {
      const v: unknown = Reflect.get(target, key, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.set(String(key), (calls.get(String(key)) ?? 0) + 1);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { be: proxy, count: (name: string) => calls.get(name) ?? 0 };
}

async function withPaper<T>(fn: (x: { doc: DocHandle; be: PdfBackend; count: (n: string) => number }) => T | Promise<T>): Promise<T> {
  const info = await backend.open(copyOf(await classifier('learning/arxiv-1706.03762-attention.pdf')));
  try {
    const c = counting(backend);
    return await fn({ doc: info.doc, be: c.be, count: c.count });
  } finally {
    await backend.close(info.doc).catch(() => undefined);
  }
}

describe('createPageTextProvider hands out what the engine does', () => {
  it('source is pdfium for a PDF with a text layer', async () => {
    await withPaper(({ doc, be }) => {
      const p = createPageTextProvider(be, doc);
      for (const page of [0, 1, 7]) expect(p.source(page)).toBe('pdfium');
    });
  }, SLOW);

  it('text, glyphs and search are the engine\'s own', async () => {
    await withPaper(async ({ doc, be }) => {
      const p = createPageTextProvider(be, doc);
      for (const page of [0, 2, 5]) {
        expect(await p.text(page), `text of page ${page}`).toBe(await backend.getPageText(doc, page));
        expect(JSON.stringify(await p.glyphs(page)), `glyphs of page ${page}`).toBe(JSON.stringify(await backend.getPageGlyphs(doc, page)));
      }
      const o = { matchCase: false, wholeWord: true };
      expect(await p.search(3, 'attention', o)).toEqual(await backend.searchPage(doc, 3, 'attention', o));
      expect((await p.search(3, 'attention', o)).length).toBeGreaterThan(3);
    });
  }, SLOW);

  it('rects are the engine\'s line rectangles for the range, for ranges on several pages', async () => {
    await withPaper(async ({ doc, be }) => {
      const p = createPageTextProvider(be, doc);
      for (const [page, start, count] of [[2, 0, 400], [2, 120, 55], [3, 10, 900], [5, 0, 1]] as const) {
        expect(await p.rects(page, start, count), `page ${page} [${start}, +${count})`).toEqual(await backend.getTextRangeRects(doc, page, start, count));
      }
      expect(await p.rects(2, 100, 0), 'an empty range has no rectangles').toEqual([]);
    });
  }, SLOW);
});

describe('rects are cached', () => {
  it('asking again for the same range does not go back to the engine', async () => {
    await withPaper(async ({ doc, be, count }) => {
      const p = createPageTextProvider(be, doc);
      const first = await p.rects(2, 40, 300);
      const after = count('getTextRangeRects');
      expect(after).toBeGreaterThanOrEqual(1);
      expect(await p.rects(2, 40, 300)).toEqual(first);
      expect(await p.rects(2, 40, 300)).toEqual(first);
      expect(count('getTextRangeRects'), 'repeats are served from the cache').toBe(after);
    });
  }, SLOW);

  it('a cache that is kept per page still tells ranges and pages apart', async () => {
    await withPaper(async ({ doc, be }) => {
      const p = createPageTextProvider(be, doc);
      const ranges = [[2, 0, 120], [2, 300, 200], [2, 0, 500], [3, 0, 120], [2, 0, 120]] as const;
      for (const [page, start, count] of ranges) {
        expect(await p.rects(page, start, count), `page ${page} [${start}, +${count})`).toEqual(await backend.getTextRangeRects(doc, page, start, count));
      }
    });
  }, SLOW);

  it('two providers on two documents do not share rectangles', async () => {
    const a = await backend.open(copyOf(await classifier('learning/arxiv-1706.03762-attention.pdf')));
    const b = await backend.open(copyOf(await classifier('learning/arxiv-1512.03385-resnet.pdf')));
    try {
      const pa = createPageTextProvider(backend, a.doc);
      const pb = createPageTextProvider(backend, b.doc);
      const ra = await pa.rects(0, 0, 200);
      const rb = await pb.rects(0, 0, 200);
      expect(ra).toEqual(await backend.getTextRangeRects(a.doc, 0, 0, 200));
      expect(rb).toEqual(await backend.getTextRangeRects(b.doc, 0, 0, 200));
      expect(JSON.stringify(ra)).not.toBe(JSON.stringify(rb));
    } finally {
      await backend.close(a.doc).catch(() => undefined);
      await backend.close(b.doc).catch(() => undefined);
    }
  }, SLOW);
});

// The same R44 scenarios as for the engine itself: the marks are painted from these rectangles.
defineRectScenarios({
  title: 'the provider\'s rects are clean line rectangles (R44)',
  backend: () => backend,
  rectsOf: (be, doc) => {
    const p = createPageTextProvider(be, doc);
    return (page, start, count) => p.rects(page, start, count);
  },
});
