// Renders the extension icons: Material Symbol `menu_book` (white, FILL 1) on a #0b57d0 rounded tile, at 16, 32, 48
// and 128 px, into public/icon/. The PNGs are committed; run this only to change them:
//
//   node apps/extension/scripts/make-icons.mjs
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SIZES = [16, 32, 48, 128];
const TILE = '#0b57d0';
const OUT = fileURLToPath(new URL('../public/icon/', import.meta.url));
const FONT = createRequire(import.meta.url).resolve('material-symbols/material-symbols-outlined.woff2');
const ORIGIN = 'http://icons.invalid';

const page_html = `<!doctype html>
<style>
  @font-face { font-family: 'Material Symbols Outlined'; src: url(${ORIGIN}/font.woff2) format('woff2'); font-weight: 100 700; }
  html, body { margin: 0; background: transparent; }
  #tile {
    display: flex; align-items: center; justify-content: center;
    background: ${TILE}; color: #fff;
    font-family: 'Material Symbols Outlined'; font-weight: 400; font-style: normal; line-height: 1;
    font-feature-settings: 'liga'; -webkit-font-feature-settings: 'liga';
    letter-spacing: normal; text-transform: none; white-space: nowrap; overflow: hidden;
  }
</style>
<div id="tile">menu_book</div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // The font and the page are served from memory, so no file:// font restrictions and no network.
  await page.route(`${ORIGIN}/**`, (route) =>
    new URL(route.request().url()).pathname === '/font.woff2'
      ? readFile(FONT).then((body) => route.fulfill({ body, contentType: 'font/woff2' }))
      : route.fulfill({ body: page_html, contentType: 'text/html' }),
  );
  await page.goto(`${ORIGIN}/`);
  await mkdir(OUT, { recursive: true });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.evaluate(
      ([s, tile]) => {
        const el = document.getElementById('tile');
        Object.assign(el.style, {
          width: `${s}px`,
          height: `${s}px`,
          borderRadius: `${Math.round(s * 0.22)}px`,
          fontSize: `${Math.round(s * 0.72)}px`,
          // FILL 1; the optical-size axis runs 20 to 48
          fontVariationSettings: `'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' ${Math.min(48, Math.max(20, Math.round(s * 0.72)))}`,
          background: tile,
        });
        return document.fonts.ready;
      },
      [size, TILE],
    );
    await page.evaluate(() => document.fonts.load("1em 'Material Symbols Outlined'", 'menu_book'));
    await writeFile(`${OUT}${size}.png`, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    console.log(`wrote public/icon/${size}.png`);
  }
} finally {
  await browser.close();
}
