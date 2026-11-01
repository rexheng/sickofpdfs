// node bench/run.mjs render
// node bench/run.mjs ocr <config-id> [--sets syn,deg,real,rcpt] [--dpi 200] [--limit N] [--repeat N] [--flags "--a --b"] [--tag x]
// node bench/run.mjs selfcheck
// Needs `pnpm build` (dist/) and, for ocr, `pnpm models`.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { configById } from './configs.mjs';
import { fixtureList } from './fixtures.mjs';
import { launch } from './launch.mjs';
import { OCR_ASSETS, RESULTS, startServer } from './server.mjs';

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: { cycle: { type: 'string' }, vis: { type: 'boolean' }, sets: { type: 'string' }, lang: { type: 'string' }, dpi: { type: 'string' }, limit: { type: 'string' }, repeat: { type: 'string' }, flags: { type: 'string' }, tag: { type: 'string' }, pages: { type: 'string' } },
});
const [cmd, arg] = positionals;
const server = await startServer();
const requestLog = [];
const flags = (o.flags ?? '').split(/\s+/).filter(Boolean);
const b = await launch({ serverOrigin: server.origin, requestLog, args: flags });
const call = (fn, ...a) => b.page.evaluate(([f, args]) => window.__bench[f](...args), [fn, a]);
const pct = (xs, p) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
let exit = 0;
try {
  const items = fixtureList();
  if (cmd === 'render') {
    await mkdir(join(OCR_ASSETS, 'rendered'), { recursive: true });
    const sourcePages = [...new Set(items.filter((i) => i.truth.kind === 'pdfium').map((i) => i.truth.sourcePage))].sort((x, y) => x - y);
    console.log('truth:', JSON.stringify(await call('truthPages', { pdf: 'source-textbook.pdf', pages: sourcePages, prefix: 'source-textbook' })));
    const index = [];
    for (const it of items) {
      const rows = await call('renderPages', { pdf: it.pdf, pages: [it.pdfPage], dpis: it.dpis, keyBase: it.key });
      index.push(...rows.map((r) => ({ ...r, fixture: it.key, set: it.set })));
      console.log(`${it.key}: ${rows.map((r) => `${r.dpi}dpi ${r.width}x${r.height} render ${r.renderMs.toFixed(0)}ms`).join(', ')}`);
    }
    await writeFile(join(OCR_ASSETS, 'rendered/index.json'), JSON.stringify(index, null, 1));
  } else if (cmd === 'ocr') {
    const cfg = configById(arg);
    const sets = (o.sets ?? 'syn,deg,real,rcpt').split(',');
    const native = o.dpi === 'native';
    const dpi = native ? 0 : Number(o.dpi ?? 200);
    const only = o.pages ? new Set(o.pages.split(',')) : null;
    const langs = o.lang ? o.lang.split(',') : null;
    // native: each page at the largest rendered DPI not above its own scan resolution
    const dpiOf = (i) => (native ? Math.max(...i.dpis.filter((d) => d <= i.nativeDpi + 10)) : dpi);
    let sel = items.filter((i) => sets.includes(i.set) && i.dpis.includes(dpiOf(i)) && (!only || only.has(i.key)) && (!langs || langs.includes(i.lang)));
    if (o.limit) sel = sel.slice(0, Number(o.limit));
    let keys = sel.map((i) => `${i.key}@${dpiOf(i)}`);
    // --cycle N: N pages by cycling the selection (the 100-page heap check)
    if (o.cycle) keys = Array.from({ length: Number(o.cycle) }, (_, i) => keys[i % keys.length]);
    const memStart = b.memory();
    const load = () => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number);
    const loadStart = load();
    const init = await call('ocrInit', cfg);
    const memInit = b.memory();
    console.log(`${cfg.id}: init ${JSON.stringify(init.ms)} ${JSON.stringify(init.facts)}`);
    let vis = null;
    if (o.vis) {
      // visible page first: pages queued in the background, then a request for one page arrives and jumps the queue
      vis = [];
      for (const injectAfterMs of [500, 3000, 7000]) vis.push({ injectAfterMs, ...(await call('visibleFirst', { bg: keys.slice(0, 10), visible: `syn-p575@${dpi || 200}`, injectAfterMs })) });
      console.log('visible-first:', JSON.stringify(vis.map((v) => ({ injectedAtMs: Math.round(v.injectedAtMs), visibleLatencyMs: Math.round(v.visibleLatencyMs), bgDoneFirst: v.backgroundPagesDoneFirst }))));
    }
    const repeats = Number(o.repeat ?? 1);
    const rows = [];
    const cpu0 = b.cpuSeconds();
    const wall0 = Date.now();
    const peaks = [];
    const curve = [];
    for (let r = 0; r < repeats; r++) {
      // in chunks of 20 pages with a memory reading after each, so a --cycle run shows growth
      for (let c = 0; c < keys.length; c += 20) {
        const res = await call('ocrRun', { keys: keys.slice(c, c + 20), tag: repeats > 1 || o.cycle ? `run${r}c${c}` : o.tag, save: !o.cycle });
        rows.push(...res.map((x) => ({ ...x, run: r })));
        const m = b.memory();
        curve.push({ pages: rows.length, renderers: m.renderers.filter((x) => x.extension).map((x) => ({ rssMB: x.rssMB, peakMB: x.peakMB })) });
      }
      peaks.push(b.memory());
    }
    const cpuSec = b.cpuSeconds() - cpu0;
    const wallSec = (Date.now() - wall0) / 1000;
    const walls = rows.map((r) => r.wallMs);
    if (rows.length) console.log(`${cfg.id} @${native ? 'native' : dpi}dpi: ${rows.length} pages, mean ${(walls.reduce((a, c) => a + c, 0) / walls.length).toFixed(0)} ms, p50 ${pct(walls, 50).toFixed(0)}, p95 ${pct(walls, 95).toFixed(0)}, max ${Math.max(...walls).toFixed(0)}`);
    const memEnd = b.memory();
    const summary = { cfg, dpi, vis, curve, cpu: { seconds: cpuSec, perPageSeconds: cpuSec / rows.length, wallSeconds: wallSec, perPageWallSeconds: wallSec / rows.length }, load: { start: loadStart, end: load() }, init, memory: { start: memStart, afterInit: memInit, end: memEnd, peaks }, rows, requests: requestLog.filter((r) => !r.url.startsWith('chrome-extension://') && !r.url.startsWith(server.origin)), serverRequests: server.requests.length, problems: b.problems.slice(0, 10), env: await call('env'), when: new Date().toISOString() };
    await mkdir(join(RESULTS, 'runs'), { recursive: true });
    await writeFile(join(RESULTS, 'runs', `${cfg.id}@${native ? 'native' : dpi}${o.tag ? `-${o.tag}` : ''}.json`), JSON.stringify(summary, null, 1));
    if (rows.length) console.log(`cpu: ${cpuSec.toFixed(1)} s total, ${(cpuSec / rows.length).toFixed(2)} s/page (browser tree); wall ${(wallSec / rows.length).toFixed(2)} s/page; load ${loadStart} -> ${load()}`);
    console.log(`memory: browser total ${memEnd.totalRssMB.toFixed(0)} MB, renderers ${JSON.stringify(memEnd.renderers)}, gpu ${memEnd.gpuMB} MB`);
    if (summary.requests.length) console.log('NON-EXTENSION REQUESTS:', JSON.stringify(summary.requests));
    if (b.problems.length) console.log('problems:', b.problems.slice(0, 5));
  } else if (cmd === 'readtext') {
    // node bench/run.mjs readtext <engine-id> <folder under test-assets/ocr holding Chrome's searchified PDFs, named as in chrome-in/>
    const folder = positionals[2];
    const byPdf = new Map();
    for (const it of items) (byPdf.get(it.chromePdf) ?? byPdf.set(it.chromePdf, []).get(it.chromePdf)).push({ key: `${it.key}`, page: it.chromePage });
    for (const [pdf, list] of byPdf) {
      // chromium-ocr-wrapper names its output <input>_searchable.pdf when -o is a folder
      const found = [pdf, pdf.replace(/\.pdf$/, '_searchable.pdf')].find((n) => existsSync(join(OCR_ASSETS, folder, n)));
      if (!found) {
        console.log(`skip ${pdf}: not in ${folder}`);
        continue;
      }
      console.log(pdf, JSON.stringify(await call('readTextLayer', { pdf: `${folder}/${found}`, items: list, engineId: arg })));
    }
  } else if (cmd === 'selfcheck') {
    const reply = await b.page.evaluate(() => chrome.runtime.sendMessage({ cmd: 'selfcheck-start' }));
    console.log('start:', JSON.stringify(reply));
    let result = null;
    for (let i = 0; i < 120 && !result; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      result = (await b.page.evaluate(() => chrome.runtime.sendMessage({ cmd: 'selfcheck-poll' }))).result;
    }
    console.log(JSON.stringify(result, null, 1));
    await mkdir(join(RESULTS, 'runs'), { recursive: true });
    await writeFile(join(RESULTS, 'runs', 'offscreen-selfcheck.json'), JSON.stringify({ result, requests: requestLog.filter((r) => !r.url.startsWith('chrome-extension://')), problems: b.problems }, null, 1));
  } else throw new Error('usage: render | ocr <config> | selfcheck');
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  await b.close();
  await server.close();
}
process.exit(exit);
