// `node scripts/fixtures/extract-filter-inputs.mjs [--out <dir>] [--only <part of a file name>]`
//
// Builds the learning filter's input for every research fixture from PDFium's own text, so the filter's tests and gates see
// what the viewer sees and not the research `pdftotext` text. For each item of docs/research/classifier-fixtures/manifest.json
// it opens the PDF in real Chromium with the real engine (the viewer's own worker, the same files the extension ships) and
// calls `buildFilterInput` from apps/extension/src/viewer/filter/sample-input.ts: the function the viewer calls. The input is
// written to <out>/<file name without .pdf>.json, default test-assets/classifier-inputs/ (gitignored: it holds text from
// the fixtures). `scripts/filter/report.mjs` reads that folder first.
//
// The link and file name come from the manifest (the link the research fetched the file from, and the name Chrome would
// give it), `viaPage` is null. The "content only" runs of the filter drop both, so one file serves both modes.
//
// Needs: `pnpm fixtures` (or at least scripts/fixtures/fetch-classifier.mjs) for the PDFs in test-assets/classifier/.
// The engine files in apps/extension/public/pdf/ are filled here. A throwaway Vite server serves the repo and one
// Playwright page runs the engine; nothing is installed and nothing leaves this computer.
//
// It prints one line per file (pages, sampled pages, the time `buildFilterInput` took) and a summary. It exits 1 when a
// fixture is missing or fails.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import copyEngineAssets from '../../apps/extension/scripts/copy-engine-assets.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = opt('out', join(repoRoot, 'test-assets/classifier-inputs'));
const only = opt('only', null);

/** Chromium that loads in this repo's environments: Playwright's own, else the preinstalled one (as e2e/support/launch.ts). */
function chromiumPath() {
  if (existsSync(chromium.executablePath())) return undefined;
  const preinstalled = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
  return existsSync(preinstalled) ? preinstalled : undefined;
}

const manifest = JSON.parse(await readFile(join(repoRoot, 'docs/research/classifier-fixtures/manifest.json'), 'utf8'));
const items = manifest.items.filter((i) => i.status === 'ok' && (only === null || i.path.includes(only)));
if (items.length === 0) throw new Error(`no fixture matches --only ${only}`);
const missing = items.filter((i) => !existsSync(join(repoRoot, 'test-assets/classifier', i.path)));
if (missing.length > 0) {
  console.error(`missing fixtures (run \`pnpm fixtures\`): ${missing.map((i) => i.path).join(', ')}`);
  process.exit(1);
}

await copyEngineAssets();
await mkdir(outDir, { recursive: true });

const server = await createServer({
  root: repoRoot,
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null, fs: { allow: [repoRoot] } },
  appType: 'custom',
  // Pre-bundle only what the page imports; the default scan would read every HTML file in the repo, spikes included.
  optimizeDeps: { entries: ['packages/viewer/src/backend/embedpdf/backend.ts', 'apps/extension/src/viewer/filter/sample-input.ts'] },
  plugins: [
    {
      name: 'blank-page',
      configureServer(s) {
        s.middlewares.use('/__blank.html', (_req, res) => {
          res.setHeader('content-type', 'text/html');
          res.end('<!doctype html><title>filter inputs</title>');
        });
      },
    },
  ],
});
await server.listen();
const origin = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
if (!origin) throw new Error('the Vite server did not start');

const executablePath = chromiumPath();
const browser = await chromium.launch({ channel: 'chromium', headless: true, ...(executablePath ? { executablePath } : {}) });
const failures = [];
const rows = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${origin}/__blank.html`);

  // Runs in the page. One engine for the whole run; each file is opened, sampled and closed.
  const extract = async ({ pdf, url, fileName }) => {
    const [{ createEmbedPdfBackend }, { engineAssets }, { buildFilterInput }] = await Promise.all([
      import('/packages/viewer/src/backend/embedpdf/backend.ts'),
      import('/packages/viewer/src/backend/embedpdf/assets.ts'),
      import('/apps/extension/src/viewer/filter/sample-input.ts'),
    ]);
    window.__backend ??= createEmbedPdfBackend(engineAssets((path) => new URL(`/apps/extension/public/${path}`, location.href).href));
    const backend = window.__backend;
    const bytes = await (await fetch(pdf)).arrayBuffer();
    const doc = await backend.open(bytes);
    try {
      const started = performance.now();
      const input = await buildFilterInput(backend, doc, { url, fileName, viaPage: null });
      return { input, ms: performance.now() - started };
    } finally {
      await backend.close(doc.doc);
    }
  };

  for (const item of items) {
    const stem = basename(item.path).replace(/\.pdf$/i, '');
    try {
      const { input, ms } = await page.evaluate(extract, {
        pdf: `/test-assets/classifier/${item.path}`,
        url: item.url,
        fileName: basename(item.path),
      });
      if (input.pageCount !== item.pages) throw new Error(`the engine counts ${input.pageCount} pages, the manifest ${item.pages}`);
      await writeFile(join(outDir, `${stem}.json`), JSON.stringify(input));
      rows.push({ stem, pages: input.pageCount, sampled: input.sampleText.length, words: input.sampleText.join(' ').split(/\s+/).filter(Boolean).length, form: input.formType ?? '-', ms });
    } catch (err) {
      failures.push(`${item.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`${pad('file', 52)} ${pad('pages', 6)} ${pad('sampled', 8)} ${pad('words', 7)} ${pad('form', 15)} ms`);
for (const r of rows) console.log(`${pad(r.stem, 52)} ${pad(r.pages, 6)} ${pad(r.sampled, 8)} ${pad(r.words, 7)} ${pad(r.form, 15)} ${r.ms.toFixed(0)}`);
if (rows.length > 0) {
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(`\nbuildFilterInput: median ${at(0.5).toFixed(0)} ms, p95 ${at(0.95).toFixed(0)} ms, max ${sorted[sorted.length - 1].toFixed(0)} ms over ${rows.length} files`);
}
console.log(`filter inputs: ${rows.length}/${items.length} written to ${outDir}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
