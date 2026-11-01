import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './fixtures';
import { record } from './record';

// The brief's tests, with their assertions unchanged. Additions: each test writes its measurements with
// record(), and the zoom tests save the gate-review screenshots before asserting, so a failing run still leaves
// them: results/bold-zoom<z>.png, a close-up of the bold passage, and the whole page in bold (a diagnostic).
// Fixture: `fixtures` (the attention paper).
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const shown = (path: string) => relative(repoRoot, path);
const n3 = (n: number) => Math.round(n * 1000) / 1000;
const forms = (f: Record<string, number>) =>
  Object.entries(f)
    .filter(([, count]) => count > 0)
    .map(([form, count]) => `${form} ${count}`)
    .join(', ');

test('P0-5: the nine glyph-path functions exist on the wrapped module', async ({ spikePage, server }) => {
  const r = await spikePage({ check: 'bold', file: server.url('classifier/learning/arxiv-1706.03762-attention.pdf'), probeOnly: 1 });
  await record('P0-5', {
    pass: r.missingFunctions.length === 0,
    measured: `${r.checked.length - r.missingFunctions.length}/${r.checked.length} PDFium functions that getGlyphOutlines calls are in the wasm and the wrapper`,
    note: r.missingFunctions.length ? `missing: ${r.missingFunctions.join(', ')}` : undefined,
  });
  expect(r.missingFunctions).toEqual([]);
});
for (const zoom of [1, 2]) {
  test(`P0-5 @${zoom * 100}%: 20 words in bold overlay < 50 ms p95, covering ≥ 95% of glyph ink`, async ({ spikePage, spikeScreenshot, server }) => {
    const r = await spikePage({ check: 'bold', file: server.url('classifier/learning/arxiv-1706.03762-attention.pdf'), page: 0, words: 20, zoom, reps: 10 });
    const shots = [
      await spikeScreenshot(`bold-zoom${zoom}.png`, { selector: '#page' }), // the 20 words in bold
      await spikeScreenshot(`bold-zoom${zoom}-detail.png`, { clip: r.detailClip }), // their lines, close up
      await spikeScreenshot(`bold-zoom${zoom}-page.png`, { selector: '#page-all' }), // every glyph on the page in bold
    ];
    await record('P0-5', {
      pass: r.p95Ms < 50 && r.inkCoverage >= 0.95 && r.spillFraction <= 0.10,
      measured:
        `@${zoom * 100}%: ${r.words} words (${r.outlines} glyphs) p95 ${r.p95Ms} ms (first ${r.firstMs}, p50 ${r.p50Ms}), ` +
        `ink coverage ${n3(r.inkCoverage)}, spill ${n3(r.spillFraction)}; glyph argument: ${forms(r.forms.forms)}; ` +
        `whole page ${r.page.outlines} glyphs in ${r.page.ms} ms, coverage ${n3(r.page.inkCoverage)}, spill ${n3(r.page.spillFraction)}, ` +
        `${forms(r.page.forms.forms)}, ${r.page.forms.failed.length} undrawn`,
      note: `@${zoom * 100}% screenshots: ${shots.map(shown).join(', ')}`,
    });
    expect(r.p95Ms).toBeLessThan(50); // request → <path> elements in the DOM
    expect(r.inkCoverage).toBeGreaterThanOrEqual(0.95); // glyph-ink pixels (luminance < 128) inside the overlay fill
    expect(r.spillFraction).toBeLessThanOrEqual(0.10); // overlay pixels further than 2 px from any ink
  });
}
