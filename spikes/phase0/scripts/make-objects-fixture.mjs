// Writes fixtures/out/objects.pdf (pdf-lib, Letter 612 × 792 pt) for P0-10. Positions below are in
// points, top-left origin; pdf-lib's y is bottom-up, so y_pdf = 792 − y_top − height.
//   Page 1 (index 0):
//     - one embedded JPEG at (72, 90, 216 × 144), the only image on the page;
//       its caption "Figure 1: A photo." in 9 pt Helvetica at x 72, text top at y 242 (8 pt below the image);
//     - a vector chart of exactly 48 path objects inside (330, 90, 200 × 140): a filled frame covering the
//       whole box, axes, grid lines, bars, ticks, a data line with markers and a legend; 6 axis-label
//       strings at 6 pt inside the box; its caption "Figure 2: A chart." below it (text top at y 238);
//     - the caption "Table 1: Scores." above a 4-row × 3-column text-only table at (72, 420, 300 × 80);
//     - full-width body paragraphs (10 pt Helvetica) between and below them.
//   Page 2 (index 1): 50,000 tiny filled rectangles (one path object each), written straight into the
//   content stream.
// "Text top" is the baseline minus Helvetica's ascender (718/1000 em, pdf-lib's heightAtSize without the
// descender), so PDFium's char boxes, which use the font's own ascent, land within a point or two of it.
//   node scripts/make-objects-fixture.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

const OUT = fileURLToPath(new URL('../fixtures/out/', import.meta.url));
const PAGE_W = 612;
const PAGE_H = 792;
const CHART = { x: 330, y: 90, width: 200, height: 140 };
const PHOTO = { x: 72, y: 90, width: 216, height: 144 };
const TABLE = { x: 72, y: 420, width: 300, height: 80 };
const TINY_RECTS = 50_000;

/** A 432 × 288 px "photo": a sky-to-ground gradient, a sun and some hills (deterministic). */
function photoJpeg() {
  const width = 432;
  const height = 288;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      const hill = height * 0.62 + 28 * Math.sin(x / 41) + 14 * Math.sin(x / 13 + 1);
      const sun = (x - 320) ** 2 + (y - 70) ** 2 < 34 ** 2;
      let r, g, b;
      if (sun) [r, g, b] = [250, 210, 80];
      else if (y > hill) [r, g, b] = [40 + (y % 17), 120 + ((x * 3) % 40), 50];
      else [r, g, b] = [90 + y / 3, 150 + y / 4, 230];
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 85).data;
}

const doc = await PDFDocument.create();
doc.setTitle('P0-10 objects fixture');
doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
const helvetica = await doc.embedFont(StandardFonts.Helvetica);
const ascent = (size) => helvetica.heightAtSize(size, { descender: false });

const page = doc.addPage([PAGE_W, PAGE_H]);
/** Draws one line of Helvetica whose text top (baseline − ascender) is at `top`. */
const text = (s, x, top, size) => page.drawText(s, { x, y: PAGE_H - top - ascent(size), size, font: helvetica, color: rgb(0, 0, 0) });

// Figure 1: the photo and its caption.
const photo = await doc.embedJpg(photoJpeg());
page.drawImage(photo, { x: PHOTO.x, y: PAGE_H - PHOTO.y - PHOTO.height, width: PHOTO.width, height: PHOTO.height });
text('Figure 1: A photo.', 72, PHOTO.y + PHOTO.height + 8, 9);

// Figure 2: a chart of exactly 48 path objects inside CHART.
let paths = 0;
const rect = (x, y, width, height, color) => {
  page.drawRectangle({ x, y: PAGE_H - y - height, width, height, color });
  paths++;
};
const line = (x1, y1, x2, y2, thickness = 1, color = rgb(0, 0, 0)) => {
  page.drawLine({ start: { x: x1, y: PAGE_H - y1 }, end: { x: x2, y: PAGE_H - y2 }, thickness, color });
  paths++;
};
const plot = { left: 350, right: 525, top: 95, bottom: 215 };
rect(CHART.x, CHART.y, CHART.width, CHART.height, rgb(0.96, 0.96, 0.96)); // the frame: 1
line(plot.left, plot.bottom, plot.right, plot.bottom); // x axis: 1
line(plot.left, plot.top, plot.left, plot.bottom); // y axis: 1
for (let k = 0; k < 5; k++) line(plot.left + 1, 105 + 22 * k, plot.right, 105 + 22 * k, 0.5, rgb(0.8, 0.8, 0.8)); // grid: 5
const heights = [40, 72, 55, 98, 83, 110, 64, 90, 47, 76];
const barX = (k) => 356 + 17 * k;
heights.forEach((h, k) => rect(barX(k), plot.bottom - h, 11, h, rgb(0.25, 0.45, 0.75))); // bars: 10
for (let k = 0; k < 6; k++) line(plot.left - 4, 105 + 22 * k, plot.left, 105 + 22 * k, 0.75); // y ticks: 6 (the last at the axis)
heights.forEach((_, k) => line(barX(k) + 5.5, plot.bottom, barX(k) + 5.5, plot.bottom + 4, 0.75)); // x ticks: 10
const trend = heights.map((h, k) => [barX(k) + 5.5, plot.bottom - h + 12]);
page.drawSvgPath(`M ${trend.map(([x, y]) => `${x} ${y}`).join(' L ')}`, { x: 0, y: PAGE_H, borderColor: rgb(0.85, 0.3, 0.2), borderWidth: 1 }); // data line: 1
paths++;
for (const [x, y] of trend) rect(x - 1.5, y - 1.5, 3, 3, rgb(0.85, 0.3, 0.2)); // markers: 10
rect(468, 99, 52, 22, rgb(1, 1, 1)); // legend box: 1
rect(472, 103, 8, 5, rgb(0.25, 0.45, 0.75)); // legend swatch, bars: 1
line(472, 115, 480, 115, 1, rgb(0.85, 0.3, 0.2)); // legend swatch, line: 1
if (paths !== 48) throw new Error(`the chart has ${paths} path objects, expected 48`);
// Six axis labels at 6 pt, all inside the chart box.
for (const [s, top] of [['100', 102.5], ['50', 146.5], ['0', 212.5]]) text(s, plot.left - 6 - helvetica.widthOfTextAtSize(s, 6), top, 6);
for (const [s, k] of [['A', 0], ['E', 4], ['J', 9]]) text(s, barX(k) + 5.5 - helvetica.widthOfTextAtSize(s, 6) / 2, plot.bottom + 7, 6);
text('Figure 2: A chart.', CHART.x, CHART.y + CHART.height + 8, 9);

// Body text: full-width paragraphs (72 → 540), 10 pt on 12 pt leading.
const words = (
  'The scores in this study were collected over three terms from students who took the same written test. ' +
  'Each answer was marked twice by different readers and the two marks were averaged before analysis. ' +
  'We report the mean and the spread for every group and we compare them with the earlier cohort. ' +
  'Results for the smaller groups should be read with care because a single student can move the mean.'
).split(' ');
function paragraph(top, lines) {
  let w = 0;
  for (let l = 0; l < lines; l++) {
    let s = '';
    while (helvetica.widthOfTextAtSize(`${s} ${words[w % words.length]}`.trim(), 10) <= 468) s = `${s} ${words[w++ % words.length]}`.trim();
    text(s, 72, top + 12 * l, 10);
  }
}
paragraph(272, 9); // 272 → 380, between the figures and the table caption

// Table 1: its caption 8 pt above the table, then 4 rows × 3 cells of 9 pt text filling (72, 420, 300 × 80).
text('Table 1: Scores.', 72, TABLE.y - 8 - 9, 9);
const rows = [
  ['Group', 'Mean score', 'Students'],
  ['Morning', '71.4', '128'],
  ['Afternoon', '68.9', '117'],
  ['Evening', '74.2', '96'],
];
const pitch = (TABLE.height - 9) / (rows.length - 1);
rows.forEach((cells, r) => {
  const top = TABLE.y + pitch * r;
  text(cells[0], TABLE.x, top, 9);
  text(cells[1], TABLE.x + 130, top, 9);
  const last = helvetica.widthOfTextAtSize(cells[2], 9);
  text(cells[2], TABLE.x + TABLE.width - last, top, 9); // right-aligned to the table's right edge
});

paragraph(530, 14); // 530 → 698, below the table

// Page 2: 50,000 tiny rectangles, 250 × 200 on a grid over the text area.
const tiny = doc.addPage([PAGE_W, PAGE_H]);
const cols = 250;
const ops = ['0.2 0.2 0.2 rg'];
for (let k = 0; k < TINY_RECTS; k++) {
  const x = 72 + (k % cols) * (468 / cols);
  const y = 72 + Math.floor(k / cols) * (648 / (TINY_RECTS / cols));
  ops.push(`${x.toFixed(3)} ${y.toFixed(3)} 0.5 0.5 re f`);
}
tiny.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(ops.join('\n'))));

await mkdir(OUT, { recursive: true });
const bytes = await doc.save({ useObjectStreams: false });
await writeFile(join(OUT, 'objects.pdf'), bytes);
console.log(`objects.pdf: 2 pages, ${bytes.length} bytes (page 1: 1 image, ${paths} chart paths; page 2: ${TINY_RECTS} rectangles)`);
