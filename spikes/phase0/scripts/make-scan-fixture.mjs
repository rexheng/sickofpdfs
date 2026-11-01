// Writes a synthetic scanned book: every page is one greyscale JPEG drawn over a Letter page, with
// no text objects. Pages cycle through the source PDF (rendered by PDFium in Node), each with a
// small skew, noise and a darker gutter strip, as a flatbed scan of a bound book would have.
//   node scripts/make-scan-fixture.mjs --source <pdf> --pages 600 --dpi 200 --quality 60 --out fixtures/out/scan-600.pdf
// Deterministic: the same arguments give the same bytes. Prints the page count and byte size.
// Phase 7.0 additions (they change nothing when not given):
//   --sidecar <json>   also write what each scan page is: [{ page, scanIndex, sourcePage, skewDeg, dpi, quality }]
//                      (the text of the source page is the known truth for the page)
//   --pick a,b,c       draw only these scan indexes (as the page's index i in the 0..pages-1 cycle), in this order
//   --skew <deg>       use this skew for every page instead of the −0.6°..+0.6° cycle
//   --sidecar-only     write only the sidecar (no images, no PDF); --out is not needed
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PdfiumNative } from '@embedpdf/engines/pdfium';
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
    sidecar: { type: 'string' },
    pick: { type: 'string' },
    skew: { type: 'string' },
    'sidecar-only': { type: 'boolean' },
  },
});
for (const name of ['source', 'pages', 'dpi', 'quality', ...(arg['sidecar-only'] ? [] : ['out'])]) {
  if (!arg[name]) throw new Error(`missing --${name} (usage: --source <pdf> --pages <n> --dpi <n> --quality <1-100> --out <pdf>)`);
}
const picks = arg.pick ? arg.pick.split(',').map(Number) : null;
const pages = picks ? picks.length : Number(arg.pages);
const fixedSkew = arg.skew === undefined ? null : Number(arg.skew);
const dpi = Number(arg.dpi);
const quality = Number(arg.quality);

const wasmBinary = await readFile(fileURLToPath(import.meta.resolve('@embedpdf/pdfium/pdfium.wasm')));
const native = new PdfiumNative(await init({ wasmBinary }));
const content = await readFile(resolve(arg.source));
const src = await native.openDocumentBuffer({ id: 'source', content: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) }).toPromise();

const doc = await PDFDocument.create({ updateMetadata: false });
const sidecar = [];
for (let k = 0; k < pages; k++) {
  const i = picks ? picks[k] : k; // the scan index: it seeds the noise and picks the source page and the default skew
  const page = src.pages[i % src.pageCount];
  const skewDeg = fixedSkew ?? (((i * 7919) % 13) - 6) / 10; // −0.6°..+0.6°
  sidecar.push({ page: k, scanIndex: i, sourcePage: i % src.pageCount, skewDeg, dpi, quality });
  if (arg['sidecar-only']) continue;
  const raw = await native.renderPageRaw(src, page, { scaleFactor: dpi / 72 }).toPromise();
  const rgba = scanPixels(raw, { skewDeg, seed: i, gutterLeft: i % 2 === 0 });
  const image = await doc.embedJpg(jpeg.encode({ data: rgba, width: raw.width, height: raw.height }, quality).data);
  doc.addPage(LETTER).drawImage(image, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
}
await native.closeDocument(src).toPromise();

if (arg.sidecar) {
  await mkdir(dirname(resolve(arg.sidecar)), { recursive: true });
  await writeFile(resolve(arg.sidecar), JSON.stringify({ source: arg.source, sourcePageCount: src.pageCount, pages: sidecar }, null, 1) + '\n');
  console.log(`${arg.sidecar}: ${sidecar.length} pages`);
}
if (!arg['sidecar-only']) {
  const out = resolve(arg.out);
  await mkdir(dirname(out), { recursive: true });
  const bytes = await doc.save();
  await writeFile(out, bytes);
  console.log(`${arg.out}: ${doc.getPageCount()} pages, ${bytes.length} bytes`);
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
