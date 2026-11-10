// Records the real footage for the launch video (apps/video). It drives the real test build of the extension in full Chromium, as
// the walkthroughs do, through the same harness and network gate (e2e/support/test.ts): @Claude answers come from the recorded
// double (e2e/support/claude-replay.ts), and nothing else may leave the browser. The phone clip is the app's own web build
// (apps/mobile) in Pixel 7 emulation, and the site clip is the public site.
//
//   pnpm -C apps/extension build:e2e && pnpm -C apps/mobile build:web
//   pnpm -C apps/video record            # writes apps/video/public/clips/*.mp4 and manifest.json (not committed)
//
// SOP_VIDEO_ONLY=site,phone records only those parts (the extension parts depend on each other and run together).
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Page } from '@playwright/test';
import { buildViewerUrl } from '../../extension/src/shared/viewer-url';
import { claudeReplay, loadScenario, type ScenarioStep } from '../../../e2e/support/claude-replay';
import { forceVerdict } from '../../../e2e/support/filter-verdict';
import { TEST_ASSETS } from '../../../e2e/support/server';
import { expect, hooks, test } from '../../../e2e/support/test';
import { findOnPage } from '../../../e2e/support/tl-blind.spec-blind';
import { setUpClaude } from '../../../e2e/walkthroughs/support/claude';
import { libraryUrl, waitViewerReady } from '../../../e2e/walkthroughs/support/library-p3.spec-blind';
import { replyBox, waitSaved } from '../../../e2e/walkthroughs/support/marks.spec-blind';
import { glide, installPointer, startClip } from './capture';

/** The window: 1600 × 900 CSS px at 1.2 device pixels each, so every frame is 1920 × 1080. */
const VIEW = { width: 1600, height: 900 };
const SCALE = 1.2;
test.use({ viewport: VIEW, deviceScaleFactor: SCALE, networkGate: 'claude' });

const ONLY = (process.env.SOP_VIDEO_ONLY ?? '').split(',').filter(Boolean);
const wants = (part: string) => ONLY.length === 0 || ONLY.includes(part);

const SITE = 'https://sickofpdfs-site.rexheng-policy.workers.dev';

/**
 * The readings, served under /courses/<code>/ so the library finds their course codes in the link, as it would for a course
 * page's links. The files are the test set's own papers and slides.
 */
const READINGS: Record<string, string> = {
  '/courses/NLP201/attention-is-all-you-need.pdf': 'classifier/learning/arxiv-1706.03762-attention.pdf',
  '/courses/NLP201/sutskever-thesis.pdf': 'classifier/learning/thesis-sutskever-phd.pdf',
  '/courses/CS231n/lecture-2.pdf': 'classifier/learning/slides-cs231n-2024-lecture2.pdf',
  '/courses/CS231n/resnet.pdf': 'classifier/learning/arxiv-1512.03385-resnet.pdf',
  '/courses/CS50/lecture-0.pdf': 'classifier/learning/slides-cs50-2023-lecture0.pdf',
  '/courses/14.01/handout-10.pdf': 'classifier/learning/handout-mit-14.01-f23-handout10.pdf',
  '/courses/14.01/problem-set-4.pdf': 'classifier/learning/problem-set-mit-14.01-f23-pset4-solutions.pdf',
  '/papers/alphafold.pdf': 'classifier/learning/nature-s41586-021-03819-2-alphafold.pdf',
  '/papers/plos-data-sharing.pdf': 'classifier/learning/plosone-10.1371-journal.pone.0000308.pdf',
  '/papers/scanned-chapter.pdf': 'scan-120.pdf',
};
const PAPER = '/courses/NLP201/attention-is-all-you-need.pdf';

/** A plain course page with the week's reading on it: where the paper is opened from. */
const COURSE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NLP201 · Week 4</title>
<style>
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f1f1f; background: #fff; }
  main { max-width: 760px; margin: 96px auto; padding: 0 24px; }
  p.k { color: #5f6368; margin: 0; font-size: 14px; letter-spacing: .02em; }
  h1 { font-size: 34px; font-weight: 500; margin: 6px 0 28px; }
  li { margin: 10px 0; font-size: 18px; } a { color: #0b57d0; }
</style></head><body><main>
<p class="k">NLP201 · Week 4</p>
<h1>Attention and Transformers</h1>
<p>Read this before Tuesday's class.</p>
<ul>
  <li><a id="paper" href="${PAPER}">Attention Is All You Need (PDF)</a></li>
  <li>Lecture slides: posted after class</li>
</ul>
</main></body></html>`;

const SENTENCE_HL = { from: 'The dominant sequence transduction models', to: 'an encoder and a decoder.' };
const SENTENCE_BOLD = { from: 'We propose a new simple network architecture', to: 'entirely.' };
const SENTENCE_NOTE = { from: 'Experiments on two machine translation tasks', to: 'less time to train.' };

/** What the recorded double streams back for the question in the video: an answer about this paper's own words. */
function answerSteps(): ScenarioStep[] {
  const base = loadScenario('ask-passage').steps![0];
  const sentences = [
    'The authors say their model, the Transformer, does better on translation and trains much faster. ',
    'It can be trained in parallel because it uses attention alone, without recurrence. ',
    'Their English-to-German result was a new best score at the time.',
  ];
  const events = (base.events ?? []).filter((e) => {
    const d = e.data as { type: string; index?: number; delta?: { type: string } };
    return d.type !== 'content_block_delta' && !(d.type === 'content_block_start' && (d.index ?? 0) > 0) && !(d.type === 'content_block_stop' && (d.index ?? 0) > 0);
  });
  const at = events.findIndex((e) => (e.data as { type: string }).type === 'content_block_stop');
  const deltas: { data: unknown }[] = [];
  sentences.forEach((s, i) => {
    for (const piece of s.match(/\S+\s*/g) ?? []) deltas.push({ data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
    if (i === 0) deltas.push({ data: { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { $cite: { doc: 'Relevant passages', block: 0 } } } } });
  });
  events.splice(at, 0, ...deltas);
  return [{ events, delayMs: 55 }];
}

const sleep = (page: Page, ms: number) => page.waitForTimeout(ms);
let mouse = { x: VIEW.width / 2, y: VIEW.height / 2 };

async function moveTo(page: Page, to: { x: number; y: number }, ms = 650): Promise<void> {
  await glide(page, mouse, to, ms);
  mouse = to;
}

async function clickAt(page: Page, to: { x: number; y: number }, ms = 650): Promise<void> {
  await moveTo(page, to, ms);
  await sleep(page, 120);
  await page.mouse.click(to.x, to.y);
}

async function centreOf(page: Page, locator: ReturnType<Page['locator']>): Promise<{ x: number; y: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('nothing to aim at');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The screen point of a glyph's centre (the test build's hooks). */
async function glyphAt(page: Page, pageIndex: number, i: number): Promise<{ x: number; y: number }> {
  const p = await hooks(page).eval((h, q) => h.glyphCenter(q[0], q[1]), [pageIndex, i] as [number, number]);
  if (!p) throw new Error(`no glyph ${i} on page ${pageIndex + 1}`);
  return p;
}

/** Drags over a passage slowly, as a reader would: from just before its first letter to just after its last. */
async function selectSlowly(page: Page, pageIndex: number, p: { from: string; to: string }, ms = 1300): Promise<void> {
  const first = await findOnPage(page, pageIndex, p.from);
  const last = await findOnPage(page, pageIndex, p.to);
  const a = await glyphAt(page, pageIndex, first.start);
  const b = await glyphAt(page, pageIndex, last.start + last.count - 1);
  await moveTo(page, { x: a.x - 3, y: a.y }, 700);
  await sleep(page, 150);
  await page.mouse.down();
  await moveTo(page, { x: b.x + 3, y: b.y }, ms);
  await page.mouse.up();
  await sleep(page, 350);
}

/** Scrolls the viewer's page list by `dy` CSS px, smoothly, over `ms`. */
async function scrollPages(page: Page, dy: number, ms: number, selector = '[role=document]'): Promise<void> {
  await page.evaluate(
    ({ dy, ms, selector }) =>
      new Promise<void>((done) => {
        const el = document.querySelector<HTMLElement>(selector) ?? document.scrollingElement!;
        const from = el.scrollTop;
        const t0 = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / ms);
          const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
          el.scrollTop = from + dy * e;
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    { dy, ms, selector },
  );
}

/** A small static server for a built folder (the phone app's web build). */
function serveFolder(root: string): Promise<{ origin: string; close: () => void }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.onnx': 'application/octet-stream' };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      const st = statSync(file);
      res.writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream',
        'content-length': st.size,
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'cross-origin',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() })));
}

test('launch video footage: the extension', async ({ context, server }) => {
  test.skip(!['extension', 'takeover', 'marks', 'claude', 'library', 'reorder', 'scan'].some(wants), 'not asked for');
  // Every paper here is a learning PDF, so it is saved as the owner reads, as the filter would decide.
  await forceVerdict(context, 'learning');
  server.mount('/courses/', (_req, res, path) => Promise.resolve(serveReading(res, path)));
  server.mount('/papers/', (_req, res, path) => Promise.resolve(serveReading(res, path)));
  function serveReading(res: import('node:http').ServerResponse, path: string): void {
    if (path === '/courses/NLP201/') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(COURSE_PAGE);
    const file = READINGS[path];
    if (!file) return void res.writeHead(404).end();
    const full = join(TEST_ASSETS, file);
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': statSync(full).size });
    createReadStream(full).pipe(res);
  }

  // ---- Before the cameras: the owner has read a few things this term (the library has something to show) ----
  for (const path of Object.keys(READINGS).filter((p) => p !== PAPER && !p.includes('scanned'))) {
    const tab = await context.newPage();
    await tab.goto(server.url(path)).catch(() => {});
    await expect.poll(() => tab.url(), { timeout: 30_000 }).toMatch(/^chrome-extension:/);
    await waitViewerReady(tab, 60_000);
    await waitSaved(tab, 60_000);
    await tab.close();
  }

  // ---- 1. Open a paper: it opens here, not in Chrome's viewer ----
  const page = await context.newPage();
  await page.goto(server.url('/courses/NLP201/'));
  await installPointer(page);
  await page.mouse.move(mouse.x, mouse.y);
  let clip = await startClip(page, 'takeover', SCALE);
  await sleep(page, 900);
  const link = page.locator('#paper');
  clip.mark('click');
  await clickAt(page, await centreOf(page, link), 900);
  await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/^chrome-extension:/);
  clip.mark('opened');
  await waitViewerReady(page, 60_000);
  await installPointer(page);
  await sleep(page, 2500);
  clip.mark('end');
  await clip.stop();

  // Close the side rail for the marks: the page gets the room.
  if (await hooks(page).eval((h) => h.viewer.snapshot().railOpen)) {
    await page.keyboard.press('F4');
    await sleep(page, 600);
  }
  await hooks(page).eval((h) => h.viewer.scrollTo(0));
  await page.waitForSelector('[data-page-index="0"] [data-start]', { state: 'attached', timeout: 30_000 });
  await sleep(page, 800);

  // ---- 2. Select, then H for a highlight and Ctrl+B for bold ----
  clip = await startClip(page, 'marks', SCALE);
  await sleep(page, 500);
  await selectSlowly(page, 0, SENTENCE_HL);
  clip.mark('selected');
  await sleep(page, 500);
  clip.mark('key-h');
  await page.keyboard.press('h');
  await sleep(page, 1300);
  await selectSlowly(page, 0, SENTENCE_BOLD);
  await sleep(page, 400);
  clip.mark('key-b');
  await page.keyboard.press('Control+b');
  await sleep(page, 900);
  await moveTo(page, { x: VIEW.width - 200, y: VIEW.height - 120 }, 700);
  await sleep(page, 1200);
  clip.mark('end');
  await clip.stop();

  // ---- 3. A comment, then 4. @Claude ----
  const replay = claudeReplay(server);
  await replay.attach(page);
  await setUpClaude(page);
  replay.use({ steps: answerSteps() });

  clip = await startClip(page, 'comment', SCALE);
  await sleep(page, 400);
  await selectSlowly(page, 0, SENTENCE_NOTE);
  clip.mark('selected');
  await page.mouse.click(mouse.x, mouse.y, { button: 'right' });
  await sleep(page, 700);
  const commentItem = page.getByRole('menu').getByRole('menuitem', { name: /comment/i }).first();
  await clickAt(page, await centreOf(page, commentItem), 600);
  clip.mark('box');
  await sleep(page, 500);
  await page.keyboard.type('Key result: faster to train, better scores.', { delay: 55 });
  await sleep(page, 400);
  await page.keyboard.press('Enter');
  clip.mark('posted');
  await sleep(page, 1600);
  clip.mark('end');
  await clip.stop();

  clip = await startClip(page, 'claude', SCALE);
  await sleep(page, 300);
  const reply = replyBox(page).first();
  if (!(await reply.isVisible())) {
    const card = page.getByRole('article', { name: /^note by/i }).filter({ hasText: 'Key result' }).first();
    await clickAt(page, await centreOf(page, card), 600);
  }
  await clickAt(page, await centreOf(page, replyBox(page).first()), 600);
  await sleep(page, 300);
  clip.mark('typing');
  await page.keyboard.type('@Claude what does this mean, simply?', { delay: 55 });
  await sleep(page, 300);
  await page.keyboard.press('Enter');
  clip.mark('asked');
  const send = page.getByRole('dialog').filter({ hasText: /to anthropic\?/i });
  if (await send.isVisible({ timeout: 2500 }).catch(() => false)) {
    clip.mark('dialog');
    await sleep(page, 900);
    await clickAt(page, await centreOf(page, send.getByRole('button', { name: 'Send' })), 600);
  }
  await expect(page.locator('[data-claude-status]').filter({ hasText: /new best score/i }).first()).toBeVisible({ timeout: 60_000 });
  clip.mark('answered');
  await moveTo(page, { x: VIEW.width / 2 - 200, y: VIEW.height - 100 }, 800);
  await sleep(page, 2200);
  clip.mark('end');
  await clip.stop();

  // ---- 5. Drag a page to reorder it ----
  await page.keyboard.press('Escape');
  if (!(await hooks(page).eval((h) => h.viewer.snapshot().railOpen))) {
    await page.keyboard.press('F4');
    await sleep(page, 800);
  }
  const thumbs = page.getByRole('navigation', { name: 'Thumbnails' });
  if (!(await thumbs.isVisible().catch(() => false))) {
    const tab = page.getByRole('tab', { name: /pages|thumbnails/i }).first();
    if (await tab.isVisible().catch(() => false)) await tab.click();
  }
  await expect(thumbs).toBeVisible();
  await sleep(page, 1200);
  clip = await startClip(page, 'reorder', SCALE);
  await sleep(page, 500);
  const t3 = await centreOf(page, thumbs.locator('[data-thumb-index="2"]'));
  const t1box = (await thumbs.locator('[data-thumb-index="1"]').boundingBox())!;
  await moveTo(page, t3, 800);
  await sleep(page, 200);
  clip.mark('grab');
  await page.mouse.down();
  await moveTo(page, { x: t3.x + 6, y: t3.y - 12 }, 200);
  await moveTo(page, { x: t1box.x + t1box.width / 2, y: t1box.y + 8 }, 1300);
  await sleep(page, 500);
  await page.mouse.up();
  clip.mark('dropped');
  await sleep(page, 2200);
  clip.mark('end');
  await clip.stop();

  // ---- 6. The library, then Courses ----
  const lib = await context.newPage();
  await lib.goto(libraryUrl('library'));
  await expect(lib.getByRole('navigation', { name: 'Library' })).toBeVisible({ timeout: 20_000 });
  await installPointer(lib);
  await sleep(lib, 2500);
  clip = await startClip(lib, 'library', SCALE);
  await lib.mouse.move(mouse.x, mouse.y);
  await sleep(lib, 1800);
  clip.mark('courses');
  await clickAt(lib, await centreOf(lib, lib.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Courses', exact: true })), 900);
  await sleep(lib, 1200);
  await moveTo(lib, { x: VIEW.width / 2 + 100, y: VIEW.height / 2 + 60 }, 900);
  await sleep(lib, 2200);
  clip.mark('end');
  await clip.stop();

  // ---- 7. A scan: its words are read, then made bold ----
  const scan = await context.newPage();
  await scan.goto(server.url('/papers/scanned-chapter.pdf')).catch(() => {});
  await expect.poll(() => scan.url(), { timeout: 30_000 }).toMatch(/^chrome-extension:/);
  clip = await startClip(scan, 'scan', SCALE);
  await waitViewerReady(scan, 60_000);
  await installPointer(scan);
  await scan.mouse.move(mouse.x, mouse.y);
  clip.mark('opened');
  // A page of running text: its text layer appears once its words are read (on this computer).
  await sleep(scan, 1500);
  await hooks(scan).eval((h) => h.viewer.scrollTo(5));
  await scan.waitForSelector('[data-page-index="5"] [data-start]', { state: 'attached', timeout: 240_000 });
  clip.mark('read');
  await sleep(scan, 1500);
  // A full line in the middle of the window (the reader's spans may be words or whole lines).
  const line = await scan.evaluate(() => {
    const lines = new Map<number, DOMRect[]>();
    for (const s of document.querySelectorAll<HTMLElement>('[data-page-index="5"] [data-start]')) {
      const r = s.getBoundingClientRect();
      if (r.width < 2 || r.top < 260 || r.bottom > 700 || !(s.textContent ?? '').trim()) continue;
      const key = Math.round((r.top + r.height / 2) / 6);
      lines.set(key, [...(lines.get(key) ?? []), r]);
    }
    const best = [...lines.values()].map((rs) => ({ x0: Math.min(...rs.map((r) => r.left)), x1: Math.max(...rs.map((r) => r.right)), y: rs[0].top + rs[0].height / 2 })).sort((p, q) => q.x1 - q.x0 - (p.x1 - p.x0))[0];
    if (!best) throw new Error(`no line of text on the scan's page 6 in view (${document.querySelectorAll('[data-page-index="5"] [data-start]').length} spans)`);
    return best;
  });
  await moveTo(scan, { x: line.x0 + 1, y: line.y }, 800);
  await scan.mouse.down();
  await moveTo(scan, { x: line.x1 - 1, y: line.y }, 1200);
  await scan.mouse.up();
  clip.mark('selected');
  await sleep(scan, 500);
  clip.mark('key-b');
  await scan.keyboard.press('Control+b');
  await sleep(scan, 800);
  await moveTo(scan, { x: line.x1 + 160, y: line.y + 140 }, 700);
  await sleep(scan, 1600);
  clip.mark('end');
  await clip.stop();
});

test('launch video footage: the phone app', async () => {
  test.skip(!wants('phone'), 'not asked for');
  const dist = fileURLToPath(new URL('../../mobile/dist/', import.meta.url));
  const app = await serveFolder(dist.replace(/\/$/, ''));
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    const pdf = `${app.origin}/__video/attention.pdf`;
    // The paper is served from the same origin as the app (as "Open with" hands the app a file).
    await page.route('**/__video/attention.pdf', (route) => route.fulfill({ path: join(TEST_ASSETS, READINGS[PAPER]), contentType: 'application/pdf' }));
    await page.goto(buildViewerUrl({ source: pdf, back: null, page: null }, `${app.origin}/viewer.html`));
    await page.waitForFunction(() => document.querySelector('[data-page-index="0"] canvas, [data-page-index="0"] img') !== null, undefined, { timeout: 60_000 });
    await page.waitForTimeout(2500);
    const clip = await startClip(page, 'phone', 2.625);
    await page.waitForTimeout(1200);
    await scrollPages(page, 900, 2600);
    await page.waitForTimeout(900);
    await scrollPages(page, -500, 1600);
    await page.waitForTimeout(1500);
    clip.mark('end');
    await clip.stop();
  } finally {
    await browser.close();
    app.close();
  }
});

test('launch video footage: the site', async () => {
  test.skip(!wants('site'), 'not asked for');
  // The public site, through this machine's proxy. No extension is loaded in this browser.
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const browser = await chromium.launch({ channel: 'chromium', headless: true, ...(proxy ? { proxy: { server: proxy } } : {}) });
  try {
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE });
    const page = await ctx.newPage();
    await page.goto(SITE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const clip = await startClip(page, 'site', SCALE);
    await page.waitForTimeout(1800);
    await scrollPages(page, 500, 2600, 'html');
    await page.waitForTimeout(1600);
    clip.mark('end');
    await clip.stop();
  } finally {
    await browser.close();
  }
});
