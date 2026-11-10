// Renders the app's launcher icons from the extension's icon design (apps/extension/scripts/make-icons.mjs): Material Symbol
// `menu_book`, white, on the #0b57d0 tile. Android's adaptive icon gets the white book alone (the tile colour is
// res/values/ic_launcher_background.xml); older Androids get the whole round and square tiles. The PNGs are committed; run this
// only to change them:
//
//   node apps/mobile/scripts/make-icons.mjs
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const TILE = '#0b57d0';
const RES = fileURLToPath(new URL('../android/app/src/main/res/', import.meta.url));
const FONT = createRequire(fileURLToPath(new URL('../../extension/package.json', import.meta.url))).resolve('material-symbols/material-symbols-outlined.woff2');
const ORIGIN = 'http://icons.invalid';
/** Launcher icon sizes (48 dp) and adaptive foreground sizes (108 dp) per density. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const html = `<!doctype html>
<style>
  @font-face { font-family: 'Material Symbols Outlined'; src: url(${ORIGIN}/font.woff2) format('woff2'); font-weight: 100 700; }
  html, body { margin: 0; background: transparent; }
  #tile { display: flex; align-items: center; justify-content: center; color: #fff; overflow: hidden;
    font-family: 'Material Symbols Outlined'; font-variation-settings: 'FILL' 1; line-height: 1; font-feature-settings: 'liga'; }
</style>
<div id="tile">menu_book</div>`;

const browser = await chromium.launch();
const page = await browser.newPage();
const font = await readFile(FONT);
await page.route(`${ORIGIN}/**`, (r) => (r.request().url().endsWith('/font.woff2') ? r.fulfill({ body: font, contentType: 'font/woff2' }) : r.fulfill({ body: html, contentType: 'text/html' })));
await page.goto(`${ORIGIN}/`);
await page.evaluate(() => document.fonts.ready);

async function render(file, px, { background, radius, glyph }) {
  await page.setViewportSize({ width: px, height: px });
  await page.evaluate(
    ({ px, background, radius, glyph }) => {
      const t = document.getElementById('tile');
      Object.assign(t.style, { width: `${px}px`, height: `${px}px`, background, borderRadius: radius, fontSize: `${glyph}px` });
    },
    { px, background, radius, glyph },
  );
  await page.locator('#tile').screenshot({ path: file, omitBackground: true });
}

for (const [name, d] of Object.entries(DENSITIES)) {
  const dir = `${RES}mipmap-${name}/`;
  await mkdir(dir, { recursive: true });
  const icon = Math.round(48 * d);
  await render(`${dir}ic_launcher.png`, icon, { background: TILE, radius: '22%', glyph: Math.round(icon * 0.6) });
  await render(`${dir}ic_launcher_round.png`, icon, { background: TILE, radius: '50%', glyph: Math.round(icon * 0.58) });
  // Adaptive foreground: 108 dp, the book inside the 66 dp safe circle.
  const fg = Math.round(108 * d);
  await render(`${dir}ic_launcher_foreground.png`, fg, { background: 'transparent', radius: '0', glyph: Math.round(fg * 0.4) });
}
await browser.close();
