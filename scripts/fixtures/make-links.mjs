// Writes test-assets/links.pdf (Task 24): 5 Letter pages, each labelled "Page N", with link annotations.
// Rects are given as (x, y, width × height) in points from the page's top-left corner, as the viewer's PdfRect is.
//   page index 0: a GoTo link to page index 2 at (72, 72, 200 × 24),
//                 a URI link to https://example.org/ at (72, 120, 200 × 24),
//                 a javascript:alert(1) URI link at (72, 168, 200 × 24) (it must stay inert);
//   page index 2: a GoTo link to page index 4 at (72, 72, 200 × 24);
//   page index 4: a GoTo link to page index 1 at (72, 72, 200 × 24).
// Each link box holds a line of text saying where it goes.
//   node scripts/fixtures/make-links.mjs (or `pnpm fixtures`)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, rgb, StandardFonts } from 'pdf-lib';

const OUT = fileURLToPath(new URL('../../test-assets/', import.meta.url));
const W = 612;
const H = 792;
const BOX = { width: 200, height: 24 };

const doc = await PDFDocument.create({ updateMetadata: false });
doc.setTitle('Links test', { showInWindowTitleBar: false });
const font = await doc.embedFont(StandardFonts.Helvetica);
const pages = [];
for (let i = 0; i < 5; i++) {
  const page = doc.addPage([W, H]);
  page.drawText(`Page ${i + 1}`, { x: 72, y: H - 320, size: 48, font, color: rgb(0, 0, 0) });
  pages.push(page);
}

/** A link box at (x, y) from the top-left, with its text, doing `action`. */
function link(pageIndex, y, text, action) {
  const page = pages[pageIndex];
  const x = 72;
  const bottom = H - y - BOX.height;
  page.drawText(text, { x: x + 4, y: bottom + 7, size: 12, font, color: rgb(0.04, 0.34, 0.82) });
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, bottom, x + BOX.width, bottom + BOX.height],
    Border: [0, 0, 0],
    A: action,
  });
  const ref = doc.context.register(annot);
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

const goTo = (target) => doc.context.obj({ S: 'GoTo', D: [pages[target].ref, PDFName.of('Fit')] });
const uri = (address) => doc.context.obj({ S: 'URI', URI: PDFString.of(address) });

link(0, 72, 'Go to page 3', goTo(2));
link(0, 120, 'https://example.org/', uri('https://example.org/'));
link(0, 168, 'A javascript: link (does nothing)', uri('javascript:alert(1)'));
link(2, 72, 'Go to page 5', goTo(4));
link(4, 72, 'Go to page 2', goTo(1));

await mkdir(OUT, { recursive: true });
const bytes = await doc.save();
await writeFile(join(OUT, 'links.pdf'), bytes);
console.log(`links.pdf: ${doc.getPageCount()} pages, ${bytes.length} bytes`);
