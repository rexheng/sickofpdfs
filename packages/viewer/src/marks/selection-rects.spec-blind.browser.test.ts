// Spec-blind browser tests for the line rectangles that marks are painted from (R44), on the engine itself:
// PdfBackend.getTextRangeRects, as merged. The same scenarios run on the PageTextProvider in
// packages/viewer/src/text/page-text.spec-blind.browser.test.ts, so the marks get the bar the engine already has.
import { afterAll, beforeAll } from 'vitest';
import { engineAssets } from '../backend/embedpdf/assets';
import { createEmbedPdfBackend } from '../backend/embedpdf/backend';
import type { PdfBackend } from '../backend/types';
import { defineRectScenarios } from '../../test/spec-blind/p2-rect-scenarios';

const ASSETS = engineAssets((path) => new URL(`/apps/extension/public/${path}`, globalThis.location.href).href);

let backend: PdfBackend;
beforeAll(() => {
  backend = createEmbedPdfBackend(ASSETS);
});
afterAll(() => {
  (backend as { dispose?: () => void }).dispose?.();
});

defineRectScenarios({
  title: 'getTextRangeRects (the engine) gives clean line rectangles',
  backend: () => backend,
  rectsOf: (be, doc) => (page, start, count) => be.getTextRangeRects(doc, page, start, count),
});
