// node scripts/hash-fixtures.mjs
// Adds the non-downloaded fixtures (synthetic scans, degraded pages, the owner-style receipts, their sidecars and the two hand
// transcriptions) with size and sha256 to fixtures.manifest.json, next to the real pages that fetch-fixtures.mjs records.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OCR = join(root, '../../test-assets/ocr');
const sha = (p) => new Promise((ok, no) => { const h = createHash('sha256'); createReadStream(p).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', no); });
const list = [
  ['scan-600.pdf', 'spikes/phase0/fixtures/out/scan-600.pdf: 600-page synthetic scan from textbook-grinstead-snell-probability.pdf (make-scan-fixture.mjs: 200 dpi, JPEG q60, skew -0.6..+0.6, noise, gutter); truth = PDFium text of source page i mod 518'],
  ['scan-600.sidecar.json', 'source page and skew of every page of scan-600.pdf (make-scan-fixture.mjs --sidecar-only; verified byte-identical against page 25)'],
  ['source-textbook.pdf', 'the textbook the synthetic scans are drawn from (docs/research/classifier-fixtures, Grinstead & Snell, GNU FDL)'],
  ['degraded-8.pdf', '8 degraded pages: 150 dpi, JPEG q35, skew 2 deg; scan indexes 12,71,130,199,262,331,404,487'],
  ['degraded-8.sidecar.json', 'source page and skew of degraded-8.pdf'],
  ['receipt-starbucks-scan.pdf', 'phone photo of a German Starbucks receipt (iPhone Notes scan), image only, no text layer; hand transcription in truth/receipt-starbucks.txt'],
  ['receipt-wholefoods-scan.pdf', 'ScanSnap receipt scan at 200 ppi. It already carries a text layer (so Chrome would skip OCR); hand transcription in truth/receipt-wholefoods.txt'],
];
const manifest = JSON.parse(await readFile(join(root, 'fixtures.manifest.json'), 'utf8'));
manifest.local = [];
for (const [file, what] of list) {
  const p = join(OCR, file);
  manifest.local.push({ file: `test-assets/ocr/${file}`, bytes: (await stat(p)).size, sha256: await sha(p), what });
}
for (const f of ['truth/receipt-starbucks.txt', 'truth/receipt-wholefoods.txt']) manifest.local.push({ file: `spikes/phase7-ocr/${f}`, bytes: (await stat(join(root, f))).size, sha256: await sha(join(root, f)), what: 'hand transcription by the spike author from the image; a token or two may be misread' });
await writeFile(join(root, 'fixtures.manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`${manifest.local.length} local fixtures hashed`);
