import { expect } from '@playwright/test';
import { test } from './fixtures';
import { record } from './record';

// v2-blob: stock @embedpdf/engines createPdfiumWorkerEngine (PDFium and encoder workers from blob: URLs).
// v2-file: our own engine worker loaded from a chrome-extension:// file URL.
for (const engine of ['v2-blob', 'v2-file'] as const) {
  test(`P0-1 ${engine}: paper-50 page 1 renders inside the extension page with bundled wasm and fonts`, async ({ spikePage, server }) => {
    const r = await spikePage({ check: 'render', engine, file: server.url('paper-50.pdf'), fonts: server.url('font-fixture.pdf') });
    expect(r.error).toBeNull();
    expect(r.cspViolations).toEqual([]);
    expect(r.pageCount).toBe(50);
    expect(r.inkFraction).toBeGreaterThan(0.02);              // share of non-white pixels on page 1
    expect(r.fontRequests.length).toBeGreaterThan(0);
    expect(r.fontRequests.every((u: string) => u.startsWith('chrome-extension://'))).toBe(true);
    expect(r.fontFixtureInkFraction).toBeGreaterThan(0.005);  // Calibri + Japanese text drawn from the bundled fallbacks
    await record('P0-1', { pass: true, measured: `${engine} first page ${r.firstPageMs} ms` });
  });
}
