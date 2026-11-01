// Writes test-assets/mixed.pdf (pdf-lib): five pages of different sizes and rotations, each reading "Page N" in 48 pt
// Helvetica at its top-left corner as displayed. The page list must show every one upright, in a box of its shape.
//   1. Letter portrait, 612 × 792
//   2. A4 landscape, 842 × 595
//   3. Letter with /Rotate 90 (612 × 792 in the file, shown 792 × 612). The label is drawn turned 90° near the
//      unrotated bottom-left (x 60, y 24), which /Rotate 90 shows upright at the top-left.
//   4. A 16:9 slide, 960 × 540
//   5. A5 portrait, 420 × 595
//   node scripts/fixtures/make-mixed.mjs (or `pnpm fixtures`)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const OUT = fileURLToPath(new URL('../../test-assets/', import.meta.url));
const SIZE = 48;
/** From the page's top edge to the label's baseline: a 24 pt margin plus Helvetica's ascender (0.718 em). */
const BASELINE_FROM_TOP = 24 + SIZE * 0.718;

const doc = await PDFDocument.create({ updateMetadata: false });
const font = await doc.embedFont(StandardFonts.Helvetica);
const label = (n) => ({ text: `Page ${n}`, opts: { size: SIZE, font, color: rgb(0, 0, 0) } });

/** An upright page of `w` × `h` points with its label at the top-left. */
function addUpright(n, w, h) {
  const page = doc.addPage([w, h]);
  const { text, opts } = label(n);
  page.drawText(text, { ...opts, x: 60, y: h - BASELINE_FROM_TOP });
}

/** Letter with /Rotate 90, its label turned so that it reads left to right once the page is turned. */
function addRotated(n) {
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(90));
  const { text, opts } = label(n);
  page.drawText(text, { ...opts, x: 60, y: 24, rotate: degrees(90) });
}

addUpright(1, 612, 792);
addUpright(2, 842, 595);
addRotated(3);
addUpright(4, 960, 540);
addUpright(5, 420, 595);

await mkdir(OUT, { recursive: true });
const bytes = await doc.save();
await writeFile(join(OUT, 'mixed.pdf'), bytes);
console.log(`mixed.pdf: ${doc.getPageCount()} pages, ${bytes.length} bytes`);
