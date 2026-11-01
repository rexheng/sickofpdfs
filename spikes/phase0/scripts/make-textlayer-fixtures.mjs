// Writes the P0-4 text-layer fixtures: each fixtures/src/<name>.html is printed by Chromium
// (Playwright `page.pdf({ format: 'Letter' })`) to fixtures/out/tl-<name>.pdf, with the bundled
// OFL fonts @fontsource/noto-serif 5.3.0 (standard ligatures fi, fl, ff, ffi) and
// @fontsource/noto-sans-hebrew 5.3.0 inlined as data: URLs. tl-rotated-page.pdf is tl-two-column.pdf
// with /Rotate 90 (pdf-lib `setRotation(degrees(90))`).
// Ground truth: fixtures/src/<name>.txt is committed and written by hand as a reader would copy the
// page (table cells and words separated by spaces, x² as "x2", operators spaced as printed). The
// script fails if the page's visible text (innerText) and the .txt differ in anything but whitespace,
// so the HTML and its truth cannot drift apart. Whitespace is left out of that guard because
// Chromium's innerText puts a line break between MathML tokens ("x\n2"), which no reader would copy.
//   node scripts/make-textlayer-fixtures.mjs
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { degrees, PDFDocument } from 'pdf-lib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'fixtures/src');
const OUT = join(ROOT, 'fixtures/out');
const FIXTURES = ['two-column', 'rotated-table', 'ligatures', 'maths', 'rtl'];
const FONT_CSS = ['@fontsource/noto-serif/400.css', '@fontsource/noto-sans-hebrew/400.css'];
/** Used only when Playwright cannot resolve its own Chromium build (as in tests/fixtures.ts). */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

// The P0-4 spec's normalisation, then with no whitespace at all (see the header).
const norm = (s) => s.normalize('NFKC').replace(/­/g, '').replace(/\s+/g, ' ').trim();
const squash = (s) => norm(s).replace(/\s+/g, '');

/** A fontsource CSS file with every src replaced by its woff2 file as a data: URL. */
async function inlineFontCss(cssPath) {
  const file = fileURLToPath(import.meta.resolve(cssPath));
  const css = await readFile(file, 'utf8');
  const blocks = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const woff2 = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1];
    if (!woff2) throw new Error(`${cssPath}: no woff2 in ${block}`);
    const data = (await readFile(join(dirname(file), 'files', woff2))).toString('base64');
    blocks.push(block.replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${data}) format('woff2');`));
  }
  if (blocks.length === 0) throw new Error(`${cssPath}: no @font-face rules`);
  return blocks.join('\n');
}

const fontCss = (await Promise.all(FONT_CSS.map(inlineFontCss))).join('\n');
const executablePath = !existsSync(chromium.executablePath()) && existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
await mkdir(OUT, { recursive: true });
try {
  const page = await browser.newPage();
  for (const name of FIXTURES) {
    const html = await readFile(join(SRC, `${name}.html`), 'utf8');
    if (!html.includes('</head>')) throw new Error(`${name}.html has no </head>`);
    await page.setContent(html.replace('</head>', `<style>\n${fontCss}\n</style>\n</head>`), { waitUntil: 'load' });
    // Load every face the page's text needs, then confirm none is missing (a fallback font would change the fixture).
    const fonts = await page.evaluate(async () => {
      const text = document.body.innerText;
      const families = ['Noto Serif', 'Noto Sans Hebrew'];
      await Promise.all(families.map((f) => document.fonts.load(`16px "${f}"`, text)));
      await document.fonts.ready;
      const used = getComputedStyle(document.body).fontFamily;
      return { text, used, loaded: [...document.fonts].filter((f) => f.status === 'loaded').length, ok: document.fonts.check(`16px ${used}`, text) };
    });
    if (!fonts.ok || fonts.loaded === 0) throw new Error(`${name}: bundled font not loaded (${JSON.stringify({ used: fonts.used, loaded: fonts.loaded })})`);

    const truthFile = join(SRC, `${name}.txt`);
    const truth = existsSync(truthFile) ? await readFile(truthFile, 'utf8') : null;
    if (truth === null || squash(truth) !== squash(fonts.text)) {
      throw new Error(`${name}: fixtures/src/${name}.txt does not match the page text.\n--- page innerText ---\n${fonts.text}\n--- ${name}.txt ---\n${truth}`);
    }

    const out = join(OUT, `tl-${name}.pdf`);
    await page.pdf({ path: out, format: 'Letter' });
    const pages = (await PDFDocument.load(await readFile(out), { updateMetadata: false })).getPageCount();
    if (pages !== 1) throw new Error(`${name}: printed ${pages} pages, expected 1`);
    console.log(`tl-${name}.pdf: 1 page (${fonts.loaded} font files loaded)`);
  }
} finally {
  await browser.close();
}

const rotated = await PDFDocument.load(await readFile(join(OUT, 'tl-two-column.pdf')), { updateMetadata: false });
rotated.getPage(0).setRotation(degrees(90));
await writeFile(join(OUT, 'tl-rotated-page.pdf'), await rotated.save());
console.log('tl-rotated-page.pdf: tl-two-column.pdf with /Rotate 90');
