// The fixture list: what the bake-off renders and scores. Keys are `<set>-p<n>` (+ `@<dpi>` for a rendered image).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const OCR = resolve(here, '../../test-assets/ocr');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

export const SYN_PAGES = Array.from({ length: 24 }, (_, i) => i * 25); // 0, 25, ... 575 (plan 7.0)

export function fixtureList() {
  const items = [];
  const syn = read(join(OCR, 'scan-600.sidecar.json'));
  for (const i of SYN_PAGES) items.push({ set: 'syn', key: `syn-p${i}`, lang: 'eng', pdf: 'scan-600.pdf', pdfPage: i, chromePdf: 'syn-24.pdf', chromePage: i / 25, dpis: [100, 150, 200], truth: { kind: 'pdfium', sourcePage: syn.pages[i].sourcePage, skewDeg: syn.pages[i].skewDeg }, nativeDpi: 200 });
  const deg = read(join(OCR, 'degraded-8.sidecar.json'));
  deg.pages.forEach((p, k) => items.push({ set: 'deg', key: `deg-p${k}`, lang: 'eng', pdf: 'degraded-8.pdf', pdfPage: k, dpis: [100, 150], truth: { kind: 'pdfium', sourcePage: p.sourcePage, skewDeg: p.skewDeg }, nativeDpi: 150 }));
  const real = read(join(here, 'fixtures.manifest.json')).real;
  for (const r of real) items.push({ set: 'real', key: `${r.book}-p${r.scanPage}`, lang: r.lang, pdf: `real/${r.pdf}`, pdfPage: r.pdfPage, dpis: [150, 200, 300], truth: { kind: 'text', file: join(OCR, 'real', r.image.replace(/\.(jpg|png)$/, '.txt')) }, nativeDpi: 300, book: r.book });
  items.push({ set: 'rcpt', key: 'rcpt-starbucks', lang: 'deu', pdf: 'receipt-starbucks-scan.pdf', pdfPage: 0, dpis: [150, 200, 300], truth: { kind: 'text', file: join(here, 'truth/receipt-starbucks.txt') }, nativeDpi: 307 });
  items.push({ set: 'rcpt', key: 'rcpt-wholefoods', lang: 'eng', pdf: 'receipt-wholefoods-scan.pdf', pdfPage: 0, dpis: [150, 200], truth: { kind: 'text', file: join(here, 'truth/receipt-wholefoods.txt') }, nativeDpi: 200 });
  for (const it of items) it.chromePdf ??= it.pdf.replace(/^real\//, ''), (it.chromePage ??= it.pdfPage);
  return items;
}
