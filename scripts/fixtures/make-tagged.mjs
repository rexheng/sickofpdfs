// Writes test-assets/tagged.pdf (ported from the Phase 0 spike, P0-10): Chromium prints a page holding
//   <figure><img alt="Bar chart of test scores" src="data:image/jpeg;base64,…"><figcaption>Figure 1: Scores.</figcaption></figure>
// (with a heading and a paragraph around it) through Playwright `page.pdf({ tagged: true })`, so the PDF has a
// structure tree with a Figure element carrying that /Alt. The script fails if the output has no
// /StructTreeRoot or the alt text is not in it.
//   node scripts/fixtures/make-tagged.mjs (or `pnpm fixtures`)
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import jpeg from 'jpeg-js';
import { PDFDocument, PDFName } from 'pdf-lib';

const OUT = fileURLToPath(new URL('../../test-assets/', import.meta.url));
const ALT = 'Bar chart of test scores';
/** Used only when Playwright cannot resolve its own Chromium build. */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

/** A 400 × 240 px bar chart as a JPEG (deterministic). */
function barChartJpeg() {
  const width = 400;
  const height = 240;
  const data = Buffer.alloc(width * height * 4, 255);
  const bars = [120, 180, 90, 200, 150];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      const k = Math.floor((x - 30) / 72);
      const inBar = k >= 0 && k < bars.length && (x - 30) % 72 < 48 && y > 220 - bars[k] && y <= 220;
      const axis = (x === 28 && y <= 220) || (y === 221 && x >= 28);
      if (inBar) [data[i], data[i + 1], data[i + 2]] = [60, 110, 190];
      else if (axis) [data[i], data[i + 1], data[i + 2]] = [0, 0, 0];
    }
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 90).data).toString('base64');
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tagged figure</title>
<style>body { font: 11pt sans-serif; margin: 1in; } figure { margin: 24px 0; } img { width: 300px; height: 180px; display: block; }</style>
</head><body>
<h1>Test scores</h1>
<p>The chart below shows the mean score of each group in the spring term.</p>
<figure><img alt="${ALT}" src="data:image/jpeg;base64,${barChartJpeg()}"><figcaption>Figure 1: Scores.</figcaption></figure>
<p>Scores rose in every group except the evening class.</p>
</body></html>`;

const executablePath = !existsSync(chromium.executablePath()) && existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
await mkdir(OUT, { recursive: true });
const out = join(OUT, 'tagged.pdf');
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: out, format: 'Letter', tagged: true });
} finally {
  await browser.close();
}

const bytes = await readFile(out);
const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
if (!pdf.catalog.get(PDFName.of('StructTreeRoot'))) throw new Error('tagged.pdf has no /StructTreeRoot: Chromium did not tag it');
if (pdf.getPageCount() !== 1) throw new Error(`tagged.pdf has ${pdf.getPageCount()} pages, expected 1`);
console.log(`tagged.pdf: 1 page, ${bytes.length} bytes, with a structure tree`);
