// Fetches the REAL scanned pages with proofread text (plan 7.0 fixtures) into test-assets/ocr/real/ (gitignored) and
// builds one scan-style PDF per book from the page images. Source: Wikisource proofread pages (text) and the scans on
// Wikimedia Commons (images), all public domain. Writes fixtures.manifest.json (committed): book, page, licence, sha256.
//   node scripts/fetch-fixtures.mjs            fetch what is missing (polite: ~1 request a second, retries on 429)
// The pages come from the index page's DjVu or PDF at 2000 px wide, which is ~300 dpi for a page 6.7 in wide; each PDF page
// is sized so that 300 dpi renders it at the downloaded pixels.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, '../../test-assets/ocr/real');
const UA = 'sickofpdfs-ocr-spike/0.1 (OCR accuracy research; low volume)';
const WIDTH = 2000;

/** id, language, wiki host, namespace of the proofread pages, Commons file, how many pages, where to start looking */
const BOOKS = [
  { id: 'en-modern-philosophy', lang: 'eng', host: 'en.wikisource.org', ns: 'Page', file: 'A Brief History of Modern Philosophy.djvu', want: 4, from: 60 },
  { id: 'en-prince-pauper', lang: 'eng', host: 'en.wikisource.org', ns: 'Page', file: '1882. The Prince and The Pauper. A Tale for Young People of All Ages.djvu', want: 3, from: 70 },
  { id: 'en-dartmoor', lang: 'eng', host: 'en.wikisource.org', ns: 'Page', file: 'A Book of Dartmoor.djvu', want: 3, from: 80 },
  { id: 'fr-bovary', lang: 'fra', host: 'fr.wikisource.org', ns: 'Page', file: 'Flaubert - Madame Bovary, Conard, 1910.djvu', want: 3, from: 60 },
  { id: 'de-kafka', lang: 'deu', host: 'de.wikisource.org', ns: 'Seite', file: 'Kafka In der Strafkolonie (1919).pdf', want: 3, from: 12 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function polite(url, opts = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await sleep(wait);
    last = Date.now();
    const res = await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers ?? {}) } });
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(30000, (Number(res.headers.get('retry-after')) || 2) * 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  }
  throw new Error(`${url}: gave up after rate limits`);
}
const api = async (host, params) => (await polite(`https://${host}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`)).json();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Wikisource page wikitext -> the plain text a person reads on the page (header and footer included). */
function toPlain(expanded) {
  let t = expanded
    .replace(/<pagequality[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<\/?(noinclude|includeonly|onlyinclude)>/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\|[\s\S]*?\|\}/g, '') // wiki tables (page-header navigation boxes), never printed text
    .replace(/\[\[(?:Kategorie|Category|Catégorie|Datei|Bild|File|Image|Fichier):[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\{\{[^}]*\}\}/g, '');
  return t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== '')).join('\n').trim();
}

const manifest = JSON.parse(await readFile(join(root, 'fixtures.manifest.json'), 'utf8').catch(() => '{"real":[]}'));
const done = new Set(manifest.real.map((r) => `${r.book}:${r.scanPage}`));
await mkdir(OUT, { recursive: true });

for (const b of BOOKS) {
  const info = (await api('commons.wikimedia.org', { action: 'query', prop: 'imageinfo', titles: `File:${b.file}`, iiprop: 'size|extmetadata', iiextmetadatafilter: 'LicenseShortName|Credit' })).query.pages[0].imageinfo?.[0];
  if (!info) throw new Error(`${b.file}: not on Commons`);
  const licence = info.extmetadata?.LicenseShortName?.value ?? 'unknown';
  const have = manifest.real.filter((r) => r.book === b.id);
  let found = have.length;
  console.log(`${b.id}: ${info.width}x${info.height}, ${info.pagecount} pages, licence ${licence}, have ${found}/${b.want}`);
  for (let n = b.from; found < b.want && n < Math.min(info.pagecount, b.from + 90); n += 2) {
    if (done.has(`${b.id}:${n}`)) continue;
    const title = `${b.ns}:${b.file}/${n}`;
    const q = await api(b.host, { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title });
    const rev = q.query.pages[0].revisions?.[0]?.slots?.main?.content;
    if (!rev) continue;
    const level = Number(/<pagequality level="(\d)"/.exec(rev)?.[1] ?? 0);
    if (level < 3) continue; // proofread (3) or validated (4) only
    if (/\[\[(File|Image|Fichier|Datei):/i.test(rev) || /\{\{(illustration|ill|image)/i.test(rev)) continue; // text pages only
    const exp = (await api(b.host, { action: 'expandtemplates', text: rev, prop: 'wikitext' })).expandtemplates.wikitext;
    const text = toPlain(exp);
    if (text.length < 1200) continue;
    const thumb = (await api('commons.wikimedia.org', { action: 'query', prop: 'imageinfo', titles: `File:${b.file}`, iiprop: 'url', iiurlwidth: String(WIDTH), iiurlparam: `page${n}-${WIDTH}px` })).query.pages[0].imageinfo[0].thumburl;
    const img = Buffer.from(await (await polite(thumb)).arrayBuffer());
    const isJpeg = img[0] === 0xff && img[1] === 0xd8;
    const name = `${b.id}-p${n}`;
    await writeFile(join(OUT, `${name}.${isJpeg ? 'jpg' : 'png'}`), img);
    await writeFile(join(OUT, `${name}.txt`), text + '\n');
    manifest.real.push({ book: b.id, lang: b.lang, host: b.host, indexFile: b.file, scanPage: n, pageTitle: title, quality: level, licence, imageSha256: sha(img), textSha256: sha(Buffer.from(text + '\n')), chars: text.length, image: `${name}.${isJpeg ? 'jpg' : 'png'}`, source: thumb });
    found++;
    console.log(`  page ${n}: quality ${level}, ${text.length} chars, ${(img.length / 1024).toFixed(0)} KiB`);
  }
}

// one PDF per book: each page is its scan, one image, no text (what a scanning app writes)
for (const b of BOOKS) {
  const pages = manifest.real.filter((r) => r.book === b.id).sort((x, y) => x.scanPage - y.scanPage);
  if (!pages.length) continue;
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const p of pages) {
    const bytes = await readFile(join(OUT, p.image));
    const image = p.image.endsWith('.jpg') ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const pt = 72 / 300;
    doc.addPage([image.width * pt, image.height * pt]).drawImage(image, { x: 0, y: 0, width: image.width * pt, height: image.height * pt });
    p.pdfPage = doc.getPageCount() - 1;
    p.pdf = `${b.id}.pdf`;
    p.pixels = [image.width, image.height];
  }
  const out = await doc.save();
  await writeFile(join(OUT, `${b.id}.pdf`), out);
  console.log(`${b.id}.pdf: ${pages.length} pages, ${(out.length / 1024).toFixed(0)} KiB`);
}
manifest.note = 'Real scans with proofread text. Text: Wikisource (CC BY-SA 4.0, derived from public-domain works). Scans: Wikimedia Commons files marked public domain.';
await writeFile(join(root, 'fixtures.manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`manifest: ${manifest.real.length} real pages`);
