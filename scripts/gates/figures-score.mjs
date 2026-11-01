// `pnpm golden:figures`: Gate 2 figure check. Scores the merged figure detector (Phase 2 S12, packages/viewer/src/figures)
// against the independent reference set (S10, e2e/reference/figures: 30 open-licence papers with hand-drawn boxes).
//
//   node scripts/gates/figures-score.mjs [--papers <id,id,...>] [--list] [--json <file>] [--no-fetch] [--timing-runs <n>]
//
// What it does, in order:
//   1. Fetches any missing PDF into test-assets/figures/ (git-ignored) with curl, from the manifest's URL, and checks the
//      SHA-256 of every file against the manifest. A mismatch FAILS HARD (exit 2, before anything is scored); the file is
//      never relabelled, and a download that does not match is deleted. The PDFs are untrusted data: they are only read,
//      by the engine.
//   2. Opens each PDF in the viewer's own PDFium (SopPdfiumNative, in this Node process: the same wasm and the same
//      object, text-run and structure-tree code the worker runs, minus the worker round trip) and finds the figures on every
//      page, twice:
//        - the "score" run, which is the gate number: listPageObjects, getTextRuns, getStructTree and analysePage
//          (findFigures' body, the call FigureService makes) with the time budgets raised to 30 s, so the result depends on
//          the detector's rules and not on how busy this machine is. A page is flagged if a size cap (not a clock) still
//          cut it short.
//        - the "as shipped" run: the production FigureService (createFigureService) with its own budgets (objects 15 ms,
//          text runs 15 ms, findFigures 20 ms) and retries. On a loaded machine a page can blow a budget and give nothing,
//          so this one moves with the load. It is printed as one extra line, with the number of pages that differ.
//   3. Scores with the README's rule (e2e/reference/figures/README.md "How to score"):
//        - a detection matches a label on the same page when IoU >= the labels file's iou_threshold (0.7); matching is
//          one to one, best IoU first;
//        - precision: of the figures the detector would OUTLINE (isOutlined, OUTLINE_RULE), the share that match a label;
//        - recall: of the labels with captionOnPage: true, the share that are matched by a detection. Two readings are
//          printed: by any detection (the README's wording) and by outlined detections only (what the reader sees);
//        - figures and tables are reported separately as well as together. Algorithm listings count as figures (S12 adds
//          "Algorithm" captions).
//   4. Times the detector page by page with the production budgets, stage by stage, on warm pages (the median of
//      --timing-runs, default 3, per page). This is an in-process Linux smoke number, not the reference-laptop perf gate.
//
// --list prints every missed label and every false outline. The full per-page result (detections, matches, timings) goes
// to test-assets/figures/last-run.json (or --json) for overlay drawing and debugging.
//
// Exit code: 0 when precision and recall both meet the plan's bar, 1 when either misses it, 2 when a hash, the manifest or
// the label file is wrong, or when getPageChars on a scored page is not one unit per char (its length differs from
// FPDFText_CountChars: the rawText rule of commit d2dc051). Timing is printed against the plan's 20 ms but is not part of the exit code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const refDir = join(repoRoot, 'e2e/reference/figures');

/** The plan's bar (docs/superpowers/plans/2026-11-01-phase2-marks-comments.md, Gate 2 figures; research 06 §3.7). */
const PRECISION_BAR = 0.95;
const RECALL_BAR = 0.75;
const TIME_BAR_MS = 20; // text runs + findFigures, p95, on the reference laptop
/** The score run's budgets: far above what a page needs (the slowest in the set takes about 2 s), so a busy machine does not change the answer. */
const RELAXED_MS = 30_000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const only = opt('papers', null)?.split(',');
const listAll = flag('list');
const allowFetch = !flag('no-fetch');
const timingRuns = Math.max(1, Number(opt('timing-runs', '3')));

const manifest = JSON.parse(readFileSync(join(refDir, 'manifest.json'), 'utf8'));
const labelFile = JSON.parse(readFileSync(join(refDir, 'labels.json'), 'utf8'));
const cacheDir = join(repoRoot, manifest.cache_dir);
const IOU_MIN = labelFile.iou_threshold;
const outPath = opt('json', join(cacheDir, 'last-run.json'));

const stemOf = (item) => item.file.replace(/\.pdf$/i, '');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n).slice(-n);
const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const fail = (code, lines) => {
  for (const l of lines) console.error(l);
  process.exit(code);
};

// ---- 1. the set, and its hashes -----------------------------------------------------------------------------------

const problems = [];
const labelsOf = new Map(labelFile.papers.map((p) => [p.id, p]));
const items = manifest.items.filter((i) => !only || only.includes(stemOf(i)));
if (only) for (const id of only) if (!manifest.items.some((i) => stemOf(i) === id)) problems.push(`--papers: no such paper ${id}`);
if (manifest.items.length !== labelFile.papers.length) problems.push(`manifest has ${manifest.items.length} papers, labels.json has ${labelFile.papers.length}`);
for (const item of items) {
  if (item.status !== 'ok') problems.push(`${item.file}: manifest status is ${item.status}`);
  const p = labelsOf.get(stemOf(item));
  if (!p) problems.push(`${item.file}: no entry in labels.json`);
  else if (p.pages !== item.pages) problems.push(`${item.file}: labels.json says ${p.pages} pages, manifest ${item.pages}`);
}
if (problems.length) fail(2, ['The reference set is inconsistent:', ...problems.map((p) => `  ${p}`)]);

mkdirSync(cacheDir, { recursive: true });
const mismatches = [];
for (const item of items) {
  const path = join(cacheDir, item.path);
  if (!existsSync(path)) {
    if (!allowFetch) {
      mismatches.push(`${item.file}: missing (--no-fetch)`);
      continue;
    }
    const part = `${path}.part`;
    process.stderr.write(`fetching ${item.file} ...\n`);
    try {
      execFileSync('curl', ['-sSL', '--fail', '--retry', '3', '--max-filesize', String(manifest.max_bytes), '-o', part, item.url], { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch (err) {
      rmSync(part, { force: true });
      mismatches.push(`${item.file}: download from ${item.url} failed (${err instanceof Error ? err.message.split('\n')[0] : err})`);
      continue;
    }
    if (sha256(part) !== item.sha256) {
      mismatches.push(`${item.file}: SHA-256 of the download is ${sha256(part)}, manifest says ${item.sha256} (download deleted)`);
      rmSync(part, { force: true });
      continue;
    }
    renameSync(part, path);
  }
  const got = sha256(path);
  if (got !== item.sha256) mismatches.push(`${item.file}: SHA-256 is ${got}, manifest says ${item.sha256} (file kept for inspection: ${path})`);
  else if (statSync(path).size !== item.bytes) mismatches.push(`${item.file}: ${statSync(path).size} bytes, manifest says ${item.bytes}`);
}
if (mismatches.length) fail(2, ["HASH CHECK FAILED. Nothing was scored. The labels are for the manifest's exact bytes; do not relabel.", ...mismatches.map((m) => `  ${m}`)]);
console.log(`hashes: ${items.length} PDFs match the manifest's SHA-256`);

// ---- 2. the engine and the detector -------------------------------------------------------------------------------

const server = await createServer({
  root: repoRoot, configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
});
const need = createRequire(join(repoRoot, 'packages/viewer/package.json'));
const { init } = need('@embedpdf/pdfium');
const wasm = readFileSync(join(dirname(need.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
const { SopPdfiumNative } = await server.ssrLoadModule('/packages/viewer/src/backend/embedpdf/sop-native.ts');
const { createFigureService, isOutlined, OUTLINE_RULE, TEXT_RUNS_BUDGET_MS } = await server.ssrLoadModule('/packages/viewer/src/figures/figure-service.ts');
const { analysePage, DETECTOR_VERSION, FIND_FIGURES_BUDGET_MS } = await server.ssrLoadModule('/packages/viewer/src/figures/find-figures.ts');
const module = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), printErr: () => {} });
const native = new SopPdfiumNative(module, {});

// The backend the service wants, over the in-process engine (a DocHandle is the document's id string).
const backend = {
  listPageObjects: async (doc, i, o) => native.listPageObjects(doc, i, o),
  getTextRuns: async (doc, i, o) => native.getTextRuns(doc, i, o),
  getStructTree: async (doc, i) => native.getStructTree(doc, i),
  hashImageObject: (doc, i, k) => native.hashImageObject(doc, i, k),
  renderTile: () => Promise.reject(new Error('renderTile is not needed to find figures')),
};

const iou = (a, b) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
};
/**
 * FPDFText_CountChars of a page, asked of PDFium directly on the engine's own text page (a private helper, reached from
 * this script on purpose), so the check below does not take getPageChars' word for its own length.
 */
const countChars = (doc, pageIndex) => native.withTextPage(doc, pageIndex, (textPage) => module.pdfium.wasmExports.FPDFText_CountChars(textPage));
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/** One page through the detector's inputs and analysePage, with the given budgets; ms per stage. */
function detectDirect(id, pageSize, i, budgets) {
  const t0 = performance.now();
  const list = native.listPageObjects(id, i, { recurseForms: true, budgetMs: budgets.objects });
  const t1 = performance.now();
  const runs = native.getTextRuns(id, i, { budgetMs: budgets.runs });
  const t2 = performance.now();
  const struct = native.getStructTree(id, i);
  const t3 = performance.now();
  const analysis = analysePage({ page: pageSize, objects: list.objects, truncated: list.truncated, runs: runs.runs, runsTruncated: runs.truncated, struct }, { budgetMs: budgets.find });
  const t4 = performance.now();
  return {
    analysis,
    objectsTruncated: list.truncated,
    runsTruncated: runs.truncated === true,
    ms: { objects: t1 - t0, runs: t2 - t1, struct: t3 - t2, find: t4 - t3, runsAndFind: t2 - t1 + (t4 - t3), total: t4 - t0 },
  };
}

const results = [];
for (const item of items) {
  const id = `ref-${stemOf(item)}`;
  const bytes = readFileSync(join(cacheDir, item.path));
  const open = native.openDocument(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (open.pageCount !== item.pages) fail(2, [`${item.file}: the engine reads ${open.pageCount} pages, the manifest says ${item.pages}`]);
  // rawText's rule (commit d2dc051): one UTF-16 unit per PDFium char, a dropped char as U+FFFF. Text runs, captions and
  // anchoring all index into it, so a page where it is off is a data problem, not a detector score.
  const unaligned = [];
  for (let i = 0; i < open.pageCount; i++) {
    const chars = native.getPageChars(id, i).length;
    const counted = countChars(id, i);
    if (chars !== counted) unaligned.push(`  p${i + 1}: getPageChars has ${chars} units, FPDFText_CountChars says ${counted}`);
  }
  if (unaligned.length) fail(2, [`${item.file}: page chars are not one unit per char (rawText, d2dc051):`, ...unaligned]);
  const pages = [];
  // Run 1, as shipped: the production service, budgets and retries as they are.
  const service = createFigureService({ backend, doc: id, pages: open.pages, dHash64: () => '', idle: (task) => (setTimeout(task, 0), () => {}) });
  for (let i = 0; i < open.pageCount; i++) pages.push({ pageIndex: i, shipped: await service.figures(i) });
  service.dispose();
  // Run 2, the score: raised budgets. Cut short only by a size cap, if at all.
  for (const page of pages) {
    const r = detectDirect(id, open.pages[page.pageIndex], page.pageIndex, { objects: RELAXED_MS, runs: RELAXED_MS, find: RELAXED_MS });
    page.figures = r.analysis.figures;
    page.capCut = !r.analysis.complete; // a size cap, or text runs cut short (the 30 s clock did not run out)
    page.capCutDetail = { timedOut: r.analysis.timedOut, objectsTruncated: r.objectsTruncated, runsTruncated: r.runsTruncated };
  }
  // Run 3, the timing: production budgets, stage by stage, median of --timing-runs per page.
  for (const page of pages) {
    const reps = Array.from({ length: timingRuns }, () => detectDirect(id, open.pages[page.pageIndex], page.pageIndex, { objects: 15, runs: TEXT_RUNS_BUDGET_MS, find: FIND_FIGURES_BUDGET_MS }));
    page.ms = Object.fromEntries(Object.keys(reps[0].ms).map((k) => [k, median(reps.map((r) => r.ms[k]))]));
    page.budgetHits = reps.filter((r) => !r.analysis.complete).length; // repeats (of timingRuns) in which a budget or cap cut the page
  }
  native.closeDoc(id);
  results.push({ item, pageCount: open.pageCount, pages });
}
await server.close();

// ---- 3. scoring ---------------------------------------------------------------------------------------------------

/** One-to-one matching on a page, best IoU first. Returns [detectionIndex, labelIndex, iou][]. */
function match(dets, labels) {
  const pairs = [];
  dets.forEach((d, di) => labels.forEach((l, li) => {
    const v = iou(d.rect, l.rect);
    if (v >= IOU_MIN) pairs.push([di, li, v]);
  }));
  pairs.sort((a, b) => b[2] - a[2]);
  const usedD = new Set();
  const usedL = new Set();
  const out = [];
  for (const [di, li, v] of pairs) {
    if (usedD.has(di) || usedL.has(li)) continue;
    usedD.add(di);
    usedL.add(li);
    out.push([di, li, v]);
  }
  return out;
}

const isTableDet = (f) => f.kind === 'table';
const isTableLabel = (l) => l.kind === 'table';
/** The other value of OUTLINE_RULE (figure-service.ts), for comparison. */
const captionLinked = (f) => f.captionRect !== null;

const tally = () => ({ out: 0, det: 0, tp: 0, cap: 0, hit: 0, hitOut: 0 });
const add = (ts, k) => ts.forEach((t) => { t[k] += 1; });

/** Scores `pick(page)` (a page's PageFigure list) over the whole set. */
function score(pick) {
  const total = { all: tally(), figure: tally(), table: tally() };
  const alt = { out: 0, tp: 0, hitOut: 0 }; // under OUTLINE_RULE 'caption-linked'
  const perPaper = [];
  const misses = [];
  const falseOutlines = [];
  const kindMismatch = [];
  for (const r of results) {
    const labels = labelsOf.get(stemOf(r.item)).labels;
    const mine = { all: tally(), figure: tally(), table: tally() };
    for (const page of r.pages) {
      const L = labels.filter((l) => l.pageIndex === page.pageIndex);
      const dets = pick(page);
      const outlined = dets.filter(isOutlined);
      const mOut = match(outlined, L);
      const mAll = match(dets, L);
      const mAlt = match(dets.filter(captionLinked), L);
      const where = { paper: stemOf(r.item), page: page.pageIndex + 1 };
      // Precision: the outlined detections against all labels.
      const matchedOut = new Map(mOut.map(([di, li, v]) => [di, [li, v]]));
      outlined.forEach((d, di) => {
        const group = isTableDet(d) ? 'table' : 'figure';
        const groups = [mine.all, mine[group], total.all, total[group]];
        add(groups, 'out');
        const m = matchedOut.get(di);
        if (m) {
          add(groups, 'tp');
          if (isTableDet(d) !== isTableLabel(L[m[0]])) kindMismatch.push(`${where.paper} p${where.page}: detection ${d.kind} "${d.label}" matched label ${L[m[0]].kind} "${L[m[0]].label}"`);
        } else {
          const best = L.reduce((x, l) => Math.max(x, iou(d.rect, l.rect)), 0);
          falseOutlines.push({ ...where, kind: d.kind, label: d.label, confidence: d.confidence, rect: d.rect, bestIou: best });
        }
      });
      for (const d of dets) add([mine.all, mine[isTableDet(d) ? 'table' : 'figure'], total.all, total[isTableDet(d) ? 'table' : 'figure']], 'det');
      // Recall: the labels with a caption on their page, by any detection and by the outlined ones.
      const hitAll = new Set(mAll.map(([, li]) => li));
      const hitOut = new Set(mOut.map(([, li]) => li));
      const hitAlt = new Set(mAlt.map(([, li]) => li));
      alt.out += dets.filter(captionLinked).length;
      alt.tp += mAlt.length;
      L.forEach((l, li) => {
        if (!l.captionOnPage) return;
        const group = isTableLabel(l) ? 'table' : 'figure';
        const groups = [mine.all, mine[group], total.all, total[group]];
        add(groups, 'cap');
        if (hitAlt.has(li)) alt.hitOut += 1;
        if (hitAll.has(li)) add(groups, 'hit');
        if (hitOut.has(li)) add(groups, 'hitOut');
        if (!hitAll.has(li)) {
          const best = dets.reduce((x, d) => Math.max(x, iou(d.rect, l.rect)), 0);
          const near = best > 0 ? dets.find((d) => iou(d.rect, l.rect) === best) : null;
          misses.push({ ...where, kind: l.kind, label: l.label, rect: l.rect, bestIou: best, nearest: near ? `${near.kind}/${near.confidence} "${near.label ?? '-'}"` : 'none' });
        } else if (!hitOut.has(li)) {
          misses.push({ ...where, kind: l.kind, label: l.label, rect: l.rect, bestIou: 0, nearest: 'found, but not outlined' });
        }
      });
    }
    perPaper.push({ id: stemOf(r.item), pages: r.pageCount, ...mine });
  }
  return { total, alt, perPaper, misses, falseOutlines, kindMismatch };
}

const main = score((p) => p.figures);
const shipped = score((p) => p.shipped);
const { total, perPaper } = main;

const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0);
const pagesAll = results.flatMap((r) => r.pages);
const stat = (key) => {
  const v = pagesAll.map((p) => p.ms[key]).sort((a, b) => a - b);
  return { p50: q(v, 0.5), p95: q(v, 0.95), max: v[v.length - 1] ?? 0 };
};

// ---- 4. report ----------------------------------------------------------------------------------------------------

console.log(`\ndetector ${DETECTOR_VERSION}   OUTLINE_RULE '${OUTLINE_RULE}'   IoU >= ${IOU_MIN}   ${results.length} papers, ${pagesAll.length} pages`);
console.log(`\n${pad('paper', 30)} ${padL('pp', 3)} ${padL('cap', 4)} ${padL('det', 4)} ${padL('out', 4)} ${padL('TP', 4)} ${padL('precision', 9)} ${padL('recall', 8)} ${padL('rec(out)', 9)} ${padL('ms/pg p50', 9)} ${padL('p95', 6)} ${padL('max', 6)}`);
for (const p of perPaper) {
  const t = p.all;
  const ms = results.find((r) => stemOf(r.item) === p.id).pages.map((x) => x.ms.total).sort((a, b) => a - b);
  console.log(`${pad(p.id, 30)} ${padL(p.pages, 3)} ${padL(t.cap, 4)} ${padL(t.det, 4)} ${padL(t.out, 4)} ${padL(t.tp, 4)} ${padL(t.out === 0 ? (t.cap === 0 ? 'ok (none)' : 'n/a') : pct(t.tp, t.out), 9)} ${padL(pct(t.hit, t.cap), 8)} ${padL(pct(t.hitOut, t.cap), 9)} ${padL(q(ms, 0.5).toFixed(1), 9)} ${padL(q(ms, 0.95).toFixed(1), 6)} ${padL((ms[ms.length - 1] ?? 0).toFixed(1), 6)}`);
}
console.log(`\n${pad('overall', 12)} ${padL('outlined', 8)} ${padL('TP', 5)} ${padL('precision', 10)} | ${padL('captioned', 9)} ${padL('found', 6)} ${padL('recall', 8)} ${padL('outlined', 8)} ${padL('recall(out)', 11)}`);
for (const [name, t] of [['all', total.all], ['figures', total.figure], ['tables', total.table]]) {
  console.log(`${pad(name, 12)} ${padL(t.out, 8)} ${padL(t.tp, 5)} ${padL(pct(t.tp, t.out), 10)} | ${padL(t.cap, 9)} ${padL(t.hit, 6)} ${padL(pct(t.hit, t.cap), 8)} ${padL(t.hitOut, 8)} ${padL(pct(t.hitOut, t.cap), 11)}`);
}
console.log(`(micro-averaged over the whole set; ${total.all.det} detections, ${total.all.out} of them outlined)`);
for (const r of results.filter((x) => labelsOf.get(stemOf(x.item)).labels.length === 0)) {
  const n = r.pages.reduce((k, p) => k + p.figures.length, 0);
  console.log(`no-figure paper ${stemOf(r.item)}: ${n} detections (${r.pages.reduce((k, p) => k + p.figures.filter(isOutlined).length, 0)} outlined); every one would be a false alarm`);
}
console.log(`\nunder the other OUTLINE_RULE ('caption-linked'): outlined ${main.alt.out}, precision ${pct(main.alt.tp, main.alt.out)}, recall(out) ${pct(main.alt.hitOut, total.all.cap)}`);
const st = shipped.total.all;
const differ = pagesAll.filter((p) => p.shipped.length !== p.figures.length || p.shipped.some((fig, k) => !sameRect(fig.rect, p.figures[k].rect))).length;
console.log(`as shipped (production FigureService and budgets, this machine's load): outlined ${st.out}, precision ${pct(st.tp, st.out)}, recall ${pct(st.hit, st.cap)}; ${differ} pages differ from the score run`);
if (main.kindMismatch.length) console.log(`\nmatched with the other kind (${main.kindMismatch.length}):\n  ${main.kindMismatch.join('\n  ')}`);

const fmt = (v) => v.toFixed(2).padStart(7);
const rf = stat('runsAndFind');
console.log(`\ntiming per page, ms, production budgets (in-process Linux smoke on a shared machine; the 20 ms bar is p95 on the reference laptop)`);
console.log(`${pad('', 26)} ${padL('p50', 7)} ${padL('p95', 7)} ${padL('max', 7)}`);
for (const [name, key] of [['objects (budget 15)', 'objects'], ['text runs (budget 15)', 'runs'], ['structure tree', 'struct'], ['findFigures (budget 20)', 'find'], ['text runs + findFigures', 'runsAndFind'], ['all stages', 'total']]) {
  const s = stat(key);
  console.log(`${pad(name, 26)} ${fmt(s.p50)} ${fmt(s.p95)} ${fmt(s.max)}`);
}
const cutOnce = pagesAll.filter((p) => p.budgetHits > 0);
const cutAlways = pagesAll.filter((p) => p.budgetHits === timingRuns);
const capCut = pagesAll.filter((p) => p.capCut);
console.log(`pages where a budget or cap cut the production run short: ${cutOnce.length} of ${pagesAll.length} in at least one of ${timingRuns} runs, ${cutAlways.length} in every run`);
console.log(`pages cut short even with 30 s budgets (a size cap or truncated text): ${capCut.length}${capCut.length ? ` (${capCut.map((p) => JSON.stringify(p.capCutDetail)).join(' ')})` : ''}`);

if (listAll) {
  const missed = main.misses.filter((m) => m.nearest !== 'found, but not outlined');
  console.log(`\nMISSED captioned labels (${missed.length}; plus ${main.misses.length - missed.length} found but not outlined):`);
  for (const m of main.misses) console.log(`  ${pad(m.paper, 28)} p${padL(m.page, 2)} ${pad(m.kind, 6)} ${pad(m.label, 22)} best IoU ${m.bestIou.toFixed(2)}  nearest: ${m.nearest}`);
  console.log(`\nFALSE OUTLINES (${main.falseOutlines.length}):`);
  for (const d of main.falseOutlines) console.log(`  ${pad(d.paper, 28)} p${padL(d.page, 2)} ${pad(d.kind, 7)} ${pad(d.confidence, 6)} ${pad(d.label ?? '(uncaptioned)', 22)} best IoU with any label ${d.bestIou.toFixed(2)}`);
}

writeFileSync(outPath, JSON.stringify({
  detectorVersion: DETECTOR_VERSION, outlineRule: OUTLINE_RULE, iouMin: IOU_MIN,
  total, shippedTotal: shipped.total, perPaper, misses: main.misses, falseOutlines: main.falseOutlines,
  pages: results.map((r) => ({
    paper: stemOf(r.item),
    pages: r.pages.map((p) => ({
      pageIndex: p.pageIndex, ms: p.ms, capCut: p.capCut,
      detections: p.figures.map((d) => ({ kind: d.kind, rect: d.rect, label: d.label, confidence: d.confidence, captionRect: d.captionRect, outlined: isOutlined(d) })),
    })),
  })),
}, null, 1));
console.log(`\nfull result: ${outPath}`);

const precisionOk = total.all.out > 0 && total.all.tp / total.all.out >= PRECISION_BAR;
const recallOk = total.all.cap > 0 && total.all.hit / total.all.cap >= RECALL_BAR;
console.log(`\nGATE 2 (figures): precision ${pct(total.all.tp, total.all.out)} (bar ${PRECISION_BAR * 100}%) ${precisionOk ? 'PASS' : 'FAIL'}; recall ${pct(total.all.hit, total.all.cap)} (bar ${RECALL_BAR * 100}%) ${recallOk ? 'PASS' : 'FAIL'}; timing p95 ${rf.p95.toFixed(1)} ms (bar ${TIME_BAR_MS} ms, smoke only)`);
process.exit(precisionOk && recallOk ? 0 : 1);
