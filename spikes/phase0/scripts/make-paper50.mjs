// Writes fixtures/out/paper-50.pdf: pages 1–50 of learning/nber-w29000.pdf, copied with pdf-lib.
// Run after fetch-fixtures.mjs.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const out = fileURLToPath(new URL('../fixtures/out/', import.meta.url));
const src = await PDFDocument.load(await readFile(join(out, 'classifier/learning/nber-w29000.pdf')), { updateMetadata: false });
if (src.getPageCount() < 50) throw new Error(`nber-w29000.pdf has only ${src.getPageCount()} pages`);

const doc = await PDFDocument.create({ updateMetadata: false });
for (const page of await doc.copyPages(src, [...Array(50).keys()])) doc.addPage(page);
await mkdir(out, { recursive: true });
const bytes = await doc.save();
await writeFile(join(out, 'paper-50.pdf'), bytes);
console.log(`paper-50.pdf: ${doc.getPageCount()} pages, ${bytes.length} bytes`);
