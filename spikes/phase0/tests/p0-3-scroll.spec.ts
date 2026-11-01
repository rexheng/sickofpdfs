import { expect } from '@playwright/test';
import { test } from './fixtures';
import { record } from './record';

// fixtures/out/scan-600.pdf comes from `pnpm -C spikes/phase0 fixtures:scan` (scripts/make-scan-fixture.mjs).
const blanks = (r: any) => `blank p50 ${r.p50BlankMs} / p95 ${r.p95BlankMs} / max ${r.maxBlankMs} ms over ${r.pagesEntered} pages`;

test.use({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5 });
for (const workers of [1, 2] as const) {
  test(`P0-3 workers=${workers}: steady 3000 px/s scroll for 20 s, no page blank > 150 ms`, async ({ spikePage, server }) => {
    const r = await spikePage({ check: 'scroll', workers, file: server.url('scan-600.pdf'), pattern: 'steady', pxPerSec: 3000, seconds: 20 });
    expect(r.pagesEntered).toBeGreaterThan(30); // ruling R23: at fit width (1742 px pitch), 60,000 px reaches about 35 pages, not > 40
    expect(r.maxBlankMs).toBeLessThanOrEqual(150);
    await record('P0-3', { pass: true, measured: `workers=${workers} steady: ${blanks(r)}` });
  });
  test(`P0-3 workers=${workers}: jumps to pages 400, 120, 599 show each page within 150 ms`, async ({ spikePage, server }) => {
    const r = await spikePage({ check: 'scroll', workers, file: server.url('scan-600.pdf'), pattern: 'jump', targets: '400,120,599' });
    expect(r.maxBlankMs).toBeLessThanOrEqual(150);
    await record('P0-3', { pass: true, measured: `workers=${workers} jump: ${blanks(r)}` });
  });
}
