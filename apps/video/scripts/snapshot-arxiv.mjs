// Takes a local snapshot of the arXiv abstract page for "Attention Is All You Need", so the video's opening can be recorded
// again and again without the network. It loads the live page once (through this machine's proxy), keeps the page as the
// browser drew it, with its scripts taken out, and saves every stylesheet, image and font it used next to it.
//
//   node scripts/snapshot-arxiv.mjs            # writes apps/video/fixtures/arxiv/ (not committed: it is arXiv's page)
//   node scripts/snapshot-arxiv.mjs --check    # draws the live page and the snapshot side by side, to compare them
//
// The recorder serves the snapshot at /abs/1706.03762, and the page's "View PDF" link points at /pdf/1706.03762 on the
// same local server, which serves the paper from test-assets.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const LIVE = 'https://arxiv.org/abs/1706.03762';
export const SNAPSHOT_DIR = fileURLToPath(new URL('../fixtures/arxiv/', import.meta.url));
const VIEW = { width: 1600, height: 900 };
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const launch = () => chromium.launch({ channel: 'chromium', headless: true, ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}) });

const EXT = { 'text/css': '.css', 'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/x-icon': '.ico', 'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf' };
const localName = (url, type) => `/arxiv-snapshot/${createHash('sha1').update(url).digest('hex').slice(0, 12)}${EXT[type] ?? (extname(new URL(url).pathname) || '.bin')}`;

async function snapshot() {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1.2 });
    /** Every stylesheet, image and font the page loaded: url → { type, body }. */
    const got = new Map();
    page.on('response', async (r) => {
      const type = (r.headers()['content-type'] ?? '').split(';')[0].trim();
      const kind = r.request().resourceType();
      if (!['stylesheet', 'image', 'font'].includes(kind) || r.status() !== 200) return;
      const body = await r.body().catch(() => null);
      if (body) got.set(r.url(), { type, body });
    });
    await page.goto(LIVE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // The page as drawn: scripts out (what they drew stays), every link and image made absolute so it can be mapped below.
    const html = await page.evaluate(() => {
      for (const s of document.querySelectorAll('script, link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="preload"], link[rel~="modulepreload"], iframe')) s.remove();
      for (const l of document.querySelectorAll('link[href]')) l.setAttribute('href', l.href);
      for (const i of document.querySelectorAll('img[src]')) i.setAttribute('src', i.src);
      for (const i of document.querySelectorAll('img[srcset], source[srcset]')) i.removeAttribute('srcset');
      for (const a of document.querySelectorAll('a[href]')) a.setAttribute('href', a.href);
      // The paper's own link goes to the local copy.
      for (const a of document.querySelectorAll('a[href]')) if (/\/pdf\/1706\.03762(v\d+)?$/.test(a.getAttribute('href'))) a.setAttribute('href', '/pdf/1706.03762');
      return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
    });
    rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
    mkdirSync(join(SNAPSHOT_DIR, 'arxiv-snapshot'), { recursive: true });
    const names = new Map([...got].map(([url, r]) => [url, localName(url, r.type)]));
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '(?:&|&amp;)');
    let out = html;
    for (const [url, name] of names) out = out.replace(new RegExp(esc(url), 'g'), name);
    // Anything still pointing off this machine in a stylesheet link or image is dropped, so the snapshot never reaches out.
    out = out.replace(/<link\b[^>]*href="https?:[^"]*"[^>]*>/g, '').replace(/(<img\b[^>]*\s)src="https?:[^"]*"/g, '$1src=""');
    writeFileSync(join(SNAPSHOT_DIR, 'abs.html'), out);
    for (const [url, r] of got) {
      let body = r.body;
      if (r.type === 'text/css') {
        // Fonts and images a stylesheet names, relative to the stylesheet.
        const css = body.toString('utf8').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
          if (ref.startsWith('data:')) return m;
          const abs = new URL(ref, url).href;
          return names.has(abs) ? `url("${names.get(abs)}")` : 'url("")';
        });
        body = Buffer.from(css.replace(/@import\s+url\(""\)[^;]*;/g, ''));
      }
      writeFileSync(join(SNAPSHOT_DIR, names.get(url)), body);
    }
    writeFileSync(join(SNAPSHOT_DIR, 'meta.json'), JSON.stringify({ source: LIVE, taken: new Date().toISOString(), files: Object.fromEntries(names) }, null, 2));
    console.log(`snapshot of ${LIVE}: ${got.size} files in ${SNAPSHOT_DIR}`);
  } finally {
    await browser.close();
  }
}

/** Serves the snapshot as the recorder does. */
export function serveSnapshot(res, path) {
  if (path === '/abs/1706.03762') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(join(SNAPSHOT_DIR, 'abs.html')));
    return true;
  }
  if (path.startsWith('/arxiv-snapshot/') && !path.includes('..')) {
    const file = join(SNAPSHOT_DIR, path);
    if (!existsSync(file)) return void res.writeHead(404).end(), true;
    const type = Object.entries(EXT).find(([, e]) => e === extname(file))?.[0] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size });
    createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

async function check(outFile) {
  const server = createServer((req, res) => {
    if (!serveSnapshot(res, new URL(req.url ?? '/', 'http://x').pathname)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}/abs/1706.03762`;
  const browser = await launch();
  try {
    const shots = [];
    for (const url of [LIVE, local]) {
      const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
      const external = [];
      page.on('request', (r) => {
        if (url === local && !r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('data:')) external.push(r.url());
      });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);
      shots.push(await page.screenshot());
      if (url === local) console.log(external.length ? `the snapshot reached out to: ${external.join(', ')}` : 'the snapshot made no requests off this machine');
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 1600, height: 1820 } });
    await page.setContent(`<body style="margin:0;background:#888">${shots.map((b) => `<img style="display:block;margin-bottom:20px" src="data:image/png;base64,${b.toString('base64')}">`).join('')}</body>`);
    await page.screenshot({ path: outFile, fullPage: true });
    console.log(`live (top) and snapshot (bottom): ${outFile}`);
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--check');
  if (at >= 0) await check(process.argv[at + 1] ?? join(SNAPSHOT_DIR, 'check.png'));
  else await snapshot();
}
