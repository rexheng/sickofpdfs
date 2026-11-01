// Builds test-assets/ocr/chrome-in/: the scan PDFs to feed Chrome's own OCR in the Windows hand run (plan 7.0 W-O2).
// syn-24.pdf holds the 24 synthetic pages (0, 25 ... 575 of scan-600.pdf); the others are copied as they are.
//   node scripts/make-chrome-inputs.mjs
// Then, on a machine with desktop Chrome:   npx chromium-ocr-wrapper "<folder>/chrome-in/*.pdf" -o <folder>/chrome-out/
// and score:                                  node bench/run.mjs readtext chrome-screenai chrome-out   &&   node scripts/score.mjs chrome-screenai
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { SYN_PAGES } from '../bench/fixtures.mjs';

const OCR = join(fileURLToPath(new URL('.', import.meta.url)), '../../../test-assets/ocr');
const out = join(OCR, 'chrome-in');
await mkdir(out, { recursive: true });
const src = await PDFDocument.load(await readFile(join(OCR, 'scan-600.pdf')), { updateMetadata: false });
const doc = await PDFDocument.create({ updateMetadata: false });
for (const p of await doc.copyPages(src, SYN_PAGES)) doc.addPage(p);
await writeFile(join(out, 'syn-24.pdf'), await doc.save());
for (const f of ['degraded-8.pdf', 'receipt-starbucks-scan.pdf', 'receipt-wholefoods-scan.pdf', 'real/en-modern-philosophy.pdf', 'real/en-prince-pauper.pdf', 'real/en-dartmoor.pdf', 'real/fr-bovary.pdf', 'real/de-kafka.pdf'])
  await copyFile(join(OCR, f), join(out, f.replace(/^real\//, '')));
console.log('chrome-in/ ready');
