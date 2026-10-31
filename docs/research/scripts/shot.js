// usage: node shot.js <url> <out.png> [width] [height] [scale] [waitms]
const { chromium } = require('playwright');
(async () => {
  const [url, out, w='1440', h='900', s='2', wait='6000'] = process.argv.slice(2);
  const browser = await chromium.launch({ proxy: { server: 'http://127.0.0.1:44837' } });
  const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +s, locale: 'en-US',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('status', resp && resp.status(), page.url());
  await page.waitForTimeout(+wait);
  await page.screenshot({ path: out });
  console.log('title', await page.title());
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
