// Hand-writes fixtures/out/font-fixture.pdf: one Letter page whose two fonts are NOT embedded, so
// PDFium must ask the extension's bundled fallback fonts for glyphs.
//   F1  /TrueType /Calibri, WinAnsi text "Résumé naïve" (28 pt): mapped to NotoSans (default font)
//   F2  /Type0, /Encoding /UniJIS-UCS2-H, CIDSystemInfo Adobe-Japan1, text 日本語 (120 pt):
//       mapped through the SHIFTJIS charset to NotoSansHans-Regular.otf
// The CJK line carries most of the page's ink: PDFium's built-in Latin substitute could draw F1
// without any fallback, but nothing can draw F2 without the bundled CJK font.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../fixtures/out/', import.meta.url));

const ucs2Hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
const content = [
  'BT /F1 28 Tf 72 700 Td (R\\351sum\\351 na\\357ve) Tj ET', // é = 0xE9, ï = 0xEF in WinAnsi
  `BT /F2 120 Tf 72 520 Td <${ucs2Hex('日本語')}> Tj ET`,
].join('\n');

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /TrueType /BaseFont /Calibri /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>',
  '<< /Type /FontDescriptor /FontName /Calibri /Flags 32 /FontBBox [-503 -250 1240 750] /ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 632 /StemV 80 >>',
  '<< /Type /Font /Subtype /Type0 /BaseFont /MS-Gothic /Encoding /UniJIS-UCS2-H /DescendantFonts [8 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MS-Gothic /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 9 0 R /DW 1000 >>',
  '<< /Type /FontDescriptor /FontName /MS-Gothic /Flags 4 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 709 /StemV 80 >>',
];

let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

await mkdir(out, { recursive: true });
await writeFile(join(out, 'font-fixture.pdf'), Buffer.from(pdf, 'latin1'));
console.log(`font-fixture.pdf: ${Buffer.byteLength(pdf, 'latin1')} bytes`);
