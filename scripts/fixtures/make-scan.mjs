// Writes a synthetic scanned book: every page is one greyscale JPEG drawn over a Letter page, with no text objects.
// Pages cycle through the source PDF (rendered by PDFium in Node), each with a small skew, noise and a darker gutter
// strip, as a flatbed scan of a bound book would have. The Phase 0 spike's make-scan-fixture.mjs, same CLI and output:
//   node scripts/fixtures/make-scan.mjs --source <pdf> --pages 600 --dpi 200 --quality 60 --out test-assets/scan-600.pdf
// Deterministic: the same arguments give the same bytes. Prints the page count and byte size.
//
// PDFium comes from @embedpdf/pdfium (a root devDependency, exact 2.15.1); EmbedPDF's PdfiumNative wrapper is loaded
// from the copy @sop/viewer pins, so this script and the viewer use one engine build.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { init } from '@embedpdf/pdfium';
import jpeg from 'jpeg-js';
import { PDFDocument } from 'pdf-lib';

const LETTER = [612, 792];
const NOISE_AMPLITUDE = 8;
const GUTTER_SHARE = 0.02;
const GUTTER_DARKEST = 0.7; // brightness factor at the binding edge, rising to 1 across the strip

const { values: arg } = parseArgs({
  options: {
    source: { type: 'string' },
    pages: { type: 'string' },
    dpi: { type: 'string' },
    quality: { type: 'string' },
    out: { type: 'string' },
  },
});
for (const name of ['source', 'pages', 'dpi', 'quality', 'out']) {
  if (!arg[name]) throw new Error(`missing --${name} (usage: --source <pdf> --pages <n> --dpi <n> --quality <1-100> --out <pdf>)`);
}
const pages = Number(arg.pages);
const dpi = Number(arg.dpi);
const quality = Number(arg.quality);

const { PdfiumNative } = await import(pathToFileURL(await enginesEntry()).href);
const wasmBinary = await readFile(fileURLToPath(import.meta.resolve('@embedpdf/pdfium/pdfium.wasm')));
const native = new PdfiumNative(await init({ wasmBinary }));
const content = await readFile(resolve(arg.source));
const src = await native.openDocumentBuffer({ id: 'source', content: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) }).toPromise();

const doc = await PDFDocument.create({ updateMetadata: false });
for (let i = 0; i < pages; i++) {
  const page = src.pages[i % src.pageCount];
  const raw = await native.renderPageRaw(src, page, { scaleFactor: dpi / 72 }).toPromise();
  const skewDeg = (((i * 7919) % 13) - 6) / 10; // −0.6°..+0.6°
  const rgba = scanPixels(raw, { skewDeg, seed: i, gutterLeft: i % 2 === 0 });
  const image = await doc.embedJpg(jpeg.encode({ data: rgba, width: raw.width, height: raw.height }, quality).data);
  doc.addPage(LETTER).drawImage(image, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
}
await native.closeDocument(src).toPromise();

const out = resolve(arg.out);
await mkdir(dirname(out), { recursive: true });
const bytes = await doc.save();
await writeFile(out, bytes);
console.log(`${arg.out}: ${doc.getPageCount()} pages, ${bytes.length} bytes`);

/** @embedpdf/engines/pdfium (ESM), resolved from packages/viewer, which depends on it. */
async function enginesEntry() {
  const require = createRequire(fileURLToPath(new URL('../../packages/viewer/package.json', import.meta.url)));
  let dir = dirname(require.resolve('@embedpdf/engines'));
  for (;;) {
    try {
      if (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name === '@embedpdf/engines') break;
    } catch {
      // no package.json here: keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('cannot find @embedpdf/engines');
    dir = parent;
  }
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  return join(dir, manifest.exports['./pdfium'].import);
}

/**
 * luminance → nearest-neighbour rotation by skewDeg about the centre (white outside) → noise of
 * ±NOISE_AMPLITUDE from a PRNG seeded with `seed` → a darker strip on the binding side. Returns
 * opaque RGBA with R = G = B.
 */
function scanPixels({ data, width: w, height: h }, { skewDeg, seed, gutterLeft }) {
  const grey = new Uint8Array(w * h);
  for (let p = 0, q = 0; p < grey.length; p++, q += 4) grey[p] = (data[q] * 77 + data[q + 1] * 150 + data[q + 2] * 29) >> 8;

  const rad = (skewDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const gutter = Math.max(1, Math.round(w * GUTTER_SHARE));
  const random = mulberry32(seed);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0, o = 0; y < h; y++) {
    // Source position of (x, y) under the inverse rotation, stepped along the row.
    let sx = cos * (0 - cx) + sin * (y - cy) + cx;
    let sy = -sin * (0 - cx) + cos * (y - cy) + cy;
    for (let x = 0; x < w; x++, o += 4, sx += cos, sy -= sin) {
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      let v = ix >= 0 && ix < w && iy >= 0 && iy < h ? grey[iy * w + ix] : 255;
      v += Math.round((random() * 2 - 1) * NOISE_AMPLITUDE);
      const fromBinding = gutterLeft ? x : w - 1 - x;
      if (fromBinding < gutter) v *= GUTTER_DARKEST + ((1 - GUTTER_DARKEST) * fromBinding) / gutter;
      v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
