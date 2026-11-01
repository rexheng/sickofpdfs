// Spec-blind: builds the learning filter's real-fixture inputs with the merged engine (PDFium), once, for the unit tests in
// packages/core/src/filter/*.spec-blind.test.ts.
//
// Why a browser test: the engine runs in a Worker and needs a browser. The classifier itself is pure and runs in Node, so
// this file only EXTRACTS. For each of the 44 research fixtures it opens the PDF, reads what a FilterInput holds
// (page count, page sizes, Info metadata, form type, and the text of the first and last 5 pages) and writes
//   test-assets/spec-blind/filter-inputs/<learning|not-learning>/<file>.json        (gitignored; text from licensed PDFs)
// The unit tests read those files. They fail, with the command that makes the files, when a file is missing.
//
// Run (from the repo root, after `pnpm fixtures`):
//   pnpm vitest run --project browser packages/viewer/test/spec-blind/filter-inputs.spec-blind.browser.test.ts
//
// Sampling rule (my reading of "sampleText: string[] /* first and last 5 pages */"): one array entry per page, in page
// order, first five pages then last five; a document of 10 pages or fewer gives every page once.
import { commands } from 'vitest/browser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocHandle, PdfBackend } from '../../src/backend/types';
import { engineAssets } from '../../src/backend/embedpdf/assets';
import { createEmbedPdfBackend } from '../../src/backend/embedpdf/backend';
import { classifier, copyOf, fetchText } from './browser-helpers';

const ASSETS = engineAssets((path) => new URL(`/apps/extension/public/${path}`, globalThis.location.href).href);
const OUT_DIR = 'test-assets/spec-blind/filter-inputs';
const SLOW = 120_000;

interface ManifestItem {
  path: string;
  label: 'learning' | 'not-learning';
  pages: number;
  url: string;
  source_page: string;
  type: string;
  edge_case: boolean;
}

/** Pages to sample: the first 5 and the last 5, each once, in page order. */
function sampledPages(pageCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < pageCount; i++) if (i < 5 || i >= pageCount - 5) out.push(i);
  return out;
}

let backend: PdfBackend;
beforeAll(() => {
  backend = createEmbedPdfBackend(ASSETS);
});
afterAll(() => {
  (backend as { dispose?: () => void }).dispose?.();
});

let items: ManifestItem[] = [];
beforeAll(async () => {
  const manifest = JSON.parse(await fetchText('docs/research/classifier-fixtures/manifest.json')) as { items: ManifestItem[] };
  items = manifest.items;
});

describe('extract filter inputs from the 44 research fixtures with PDFium', () => {
  it('has the 44 fixtures (22 learning, 22 not-learning) in the manifest', () => {
    expect(items.length).toBe(44);
    expect(items.filter((i) => i.label === 'learning').length).toBe(22);
    expect(items.filter((i) => i.label === 'not-learning').length).toBe(22);
  });

  it('writes one input file per fixture', { timeout: SLOW * 44 }, async () => {
    for (const item of items) {
      const bytes = await classifier(item.path);
      const info = await backend.open(copyOf(bytes));
      const doc: DocHandle = info.doc;
      try {
        expect(info.pageCount, `${item.path}: page count`).toBe(item.pages);
        const form = await backend.getFormInfo(doc);
        const pageIndexes = sampledPages(info.pageCount);
        const sampleText: string[] = [];
        for (const p of pageIndexes) sampleText.push(await backend.getPageText(doc, p));
        const record = {
          path: item.path,
          label: item.label,
          sourceUrl: item.url,
          pageCount: info.pageCount,
          pageSizes: info.pages,
          metadata: info.metadata,
          formType: form.formType,
          sampledPageIndexes: pageIndexes,
          sampleText,
        };
        await commands.writeFile(`${OUT_DIR}/${item.path}.json`, JSON.stringify(record));
      } finally {
        await backend.close(doc).catch(() => undefined);
      }
    }
  });
});
