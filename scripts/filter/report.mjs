// `node scripts/filter/report.mjs`: runs the learning filter over the 44 research fixtures and prints one row per file,
// then the phase gate: zero false saves, how many learning files are saved, asked or missed, and the timing.
//
//   node scripts/filter/report.mjs [--mode with-link|content-only|both] [--source auto|pdfium|poppler] [--no-second-look]
//                                  [--inputs <dir>] [--write-inputs <dir>] [--runs <n>] [--explain <file-name-part>]
//
// Inputs (the FilterInput for each fixture). --source auto tries, in this order, for each fixture:
//   1. <inputs>/<name>.json, default test-assets/classifier-inputs (Phase 3 slice S8 writes these from PDFium's text)
//   2. PDFium's text, read here in Node through the viewer's own SopPdfiumNative: the text the viewer will sample
//   3. poppler (pdfinfo and pdftotext), if PDFium cannot be started
// The sample is the first 5 and the last 5 pages, as in the viewer. If those 10 pages hold under 15 words, up to 10 more
// pages from the middle are read too (the "second look", core's sample.ts); --no-second-look turns that off. The
// fixtures are untrusted data: they are only read.
//
// Modes. "with-link" gives each file its manifest link and name. "content-only" gives no link and a neutral file name,
// the research's honest baseline: text, metadata, page count and page shape only.
//
// Exit code: 1 when any non-learning fixture is saved, or any learning fixture comes out not-learning.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const mode = opt('mode', 'both');
const source = opt('source', 'auto');
const inputsDir = opt('inputs', join(repoRoot, 'test-assets/classifier-inputs'));
const writeInputs = opt('write-inputs', null);
const runs = Number(opt('runs', '30'));
const explain = opt('explain', null);
if (!['with-link', 'content-only', 'both'].includes(mode)) throw new Error('--mode must be with-link, content-only or both');
if (!['auto', 'pdfium', 'poppler'].includes(source)) throw new Error('--source must be auto, pdfium or poppler');

const manifest = JSON.parse(readFileSync(join(repoRoot, 'docs/research/classifier-fixtures/manifest.json'), 'utf8'));
const cacheRoot = join(repoRoot, 'test-assets/classifier');
const pdfPath = (item) => join(cacheRoot, item.path);
const stemOf = (item) => basename(item.path).replace(/\.pdf$/i, '');
const secondLook = !args.includes('--no-second-look');

const server = await createServer({
  root: repoRoot, configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
});
const { classify, detectHardBlocks, sampleIndexes, secondLookIndexes, needsSecondLook } = await server.ssrLoadModule('/packages/core/src/filter/index.ts');

// ---- input source 2: PDFium ----

let pdfium = null;
async function startPdfium() {
  const need = createRequire(join(repoRoot, 'packages/viewer/package.json'));
  const { init } = need('@embedpdf/pdfium');
  const wasm = readFileSync(join(dirname(need.resolve('@embedpdf/pdfium')), 'pdfium.wasm'));
  const { SopPdfiumNative } = await server.ssrLoadModule('/packages/viewer/src/backend/embedpdf/sop-native.ts');
  const module = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), printErr: () => {} });
  return new SopPdfiumNative(module, {});
}

function pdfiumInput(item) {
  const bytes = readFileSync(pdfPath(item));
  const id = `fixture-${stemOf(item)}`;
  const open = pdfium.openDocument(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  try {
    const sampleText = sampleIndexes(open.pageCount).map((i) => pdfium.getPageText(id, i));
    if (secondLook && needsSecondLook(sampleText)) sampleText.push(...secondLookIndexes(open.pageCount).map((i) => pdfium.getPageText(id, i)));
    const { formType } = pdfium.getFormInfo(id);
    return { url: item.url, fileName: basename(item.path), pageCount: open.pageCount, pageSizes: open.pages, metadata: open.metadata, sampleText, viaPage: null, formType };
  } finally {
    pdfium.closeDoc(id);
  }
}

// ---- input source 3: poppler ----

const poppler = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

function popplerInput(item) {
  const path = pdfPath(item);
  const head = poppler('pdfinfo', [path]);
  const field = (name) => (new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(head)?.[1] ?? '').trim() || null;
  const n = Number(field('Pages'));
  const per = poppler('pdfinfo', ['-f', '1', '-l', String(n), path]);
  const pageSizes = [];
  for (const m of per.matchAll(/^Page\s+(\d+) size:\s*([\d.]+) x ([\d.]+) pts/gm)) {
    pageSizes[Number(m[1]) - 1] = { width: Number(m[2]), height: Number(m[3]), rotation: 0 };
  }
  const page = (i) => poppler('pdftotext', ['-f', String(i + 1), '-l', String(i + 1), '-enc', 'UTF-8', path, '-']).split('\f')[0];
  const sampleText = sampleIndexes(n).map(page);
  if (secondLook && needsSecondLook(sampleText)) sampleText.push(...secondLookIndexes(n).map(page));
  const form = field('Form');
  return {
    url: item.url, fileName: basename(item.path), pageCount: n, pageSizes: pageSizes.filter(Boolean),
    metadata: { title: field('Title'), author: field('Author'), subject: field('Subject'), keywords: field('Keywords'), creator: field('Creator'), producer: field('Producer') },
    sampleText, viaPage: null, formType: form === 'XFA' ? 'xfa-full' : form === 'AcroForm' ? 'acroform' : 'none',
  };
}

// ---- gather the inputs ----

if (source !== 'poppler') {
  try {
    pdfium = await startPdfium();
  } catch (err) {
    if (source === 'pdfium') throw err;
    console.log(`(PDFium could not start here: ${err instanceof Error ? err.message : err}; using poppler)`);
  }
}

const items = manifest.items.filter((i) => i.status === 'ok');
const loaded = items.map((item) => {
  const prepared = join(inputsDir, `${stemOf(item)}.json`);
  if (source === 'auto' && existsSync(prepared)) return { item, input: JSON.parse(readFileSync(prepared, 'utf8')), from: 'S8 inputs (PDFium, in the browser)' };
  if (pdfium) return { item, input: pdfiumInput(item), from: 'PDFium text' };
  return { item, input: popplerInput(item), from: 'poppler text' };
});
if (writeInputs) {
  mkdirSync(writeInputs, { recursive: true });
  for (const { item, input } of loaded) writeFileSync(join(writeInputs, `${stemOf(item)}.json`), JSON.stringify(input));
}

// ---- the run ----

const noRules = { fileChoice: null, deny: [], allow: [] };
const asContent = (input) => ({ ...input, url: null, fileName: 'document.pdf', viaPage: null });
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

function outcome(label, verdict) {
  if (label === 'not-learning') return verdict === 'not-learning' ? 'ok' : verdict === 'learning' ? 'FALSE SAVE' : 'asked';
  return verdict === 'learning' ? 'saved' : verdict === 'unsure' ? 'asked' : 'MISSED';
}

function runMode(name, make) {
  console.log(`\n=== ${name} ===`);
  console.log(`${pad('truth', 13)} ${pad('verdict', 13)} ${pad('rule', 11)} ${pad('score', 6)} ${pad('result', 10)} ${pad('file', 50)} reasons`);
  const rows = [];
  for (const { item, input } of loaded) {
    const d = classify(make(input), noRules);
    const res = outcome(item.label, d.verdict);
    rows.push({ item, d, res });
    const score = d.score === undefined ? '' : (d.score >= 0 ? '+' : '') + d.score.toFixed(1);
    console.log(`${pad(item.label + (item.edge_case ? '*' : ''), 13)} ${pad(d.verdict, 13)} ${pad(d.rule ?? '', 11)} ${pad(score, 6)} ${pad(res, 10)} ${pad(basename(item.path), 50)} ${d.reasons.join(' | ')}`);
    if (explain && basename(item.path).includes(explain)) {
      console.log('    signals: ' + (d.signals ?? []).map((s) => `${s.id}:${s.weight > 0 ? '+' : ''}${s.weight}`).join(' '));
    }
  }
  const nl = rows.filter((r) => r.item.label === 'not-learning');
  const lr = rows.filter((r) => r.item.label === 'learning');
  const count = (rs, res) => rs.filter((r) => r.res === res).length;
  const falseSaves = count(nl, 'FALSE SAVE');
  const skipped = count(nl, 'ok');
  const saved = count(lr, 'saved'), asked = count(lr, 'asked'), missed = count(lr, 'MISSED');
  console.log(`\n${name}  (* = edge case in the manifest)`);
  console.log(`  not-learning fixtures: ${nl.length}   false saves: ${falseSaves}   not-learning: ${skipped}   unsure: ${count(nl, 'asked')}`);
  console.log(`  learning fixtures:     ${lr.length}   saved: ${saved}   asked (unsure): ${asked}   missed (not-learning): ${missed}`);
  const scored = (rs) => rs.filter((r) => r.d.score !== undefined).map((r) => r.d.score);
  console.log(`  margins: highest not-learning score ${Math.max(...scored(nl)).toFixed(1)} (saves at 3.0); lowest saved learning score ${Math.min(...scored(lr.filter((r) => r.res === 'saved'))).toFixed(1)}`);
  const gate = falseSaves === 0 && skipped === nl.length && missed === 0 && saved >= lr.length - 1;
  console.log(`  gate (zero false saves; all ${nl.length} not-learning skipped; at most 1 learning not saved; none missed): ${gate ? 'PASS' : 'FAIL'}`);
  for (const r of rows.filter((x) => ['FALSE SAVE', 'MISSED', 'asked'].includes(x.res))) console.log(`    ${r.res}: ${basename(r.item.path)} (${r.d.verdict}, ${r.d.rule})`);
  return { gate, falseSaves, missed };
}

console.log(`inputs: ${[...new Set(loaded.map((l) => l.from))].join(', ')}; ${loaded.length} fixtures`);
const results = [];
if (mode !== 'content-only') results.push(runMode('with link and file name', (i) => i));
if (mode !== 'with-link') results.push(runMode('content only (no link, neutral file name)', asContent));

// ---- hard blocks: kinds only ----

console.log('\n=== hard blocks found in the sampled text (kinds only) ===');
for (const label of ['learning', 'not-learning']) {
  const hits = loaded.filter((l) => l.item.label === label).map((l) => [basename(l.item.path), detectHardBlocks(l.input.sampleText)]).filter(([, k]) => k.length);
  console.log(`  ${label} fixtures with a hard block: ${hits.length}${hits.length ? ' -> ' + hits.map(([f, k]) => `${f} [${k.join(', ')}]`).join('; ') : ''}`);
}
const blocked = loaded.filter((l) => classify(l.input, noRules).rule === 'hard-block');
console.log(`  fixtures blocked (a card, or any two other kinds): ${blocked.length}`);

// ---- hard cases: made-up LaTeX CVs (a fictional person), which must never be saved ----

console.log('\n=== hard case: personal CVs made in LaTeX (made-up text) ===');
const latex = { creator: 'LaTeX with hyperref', producer: 'pdfTeX-1.40.21', title: null, author: null, subject: null, keywords: null };
const cvInput = (name, pageCount, pages) => ({ url: null, fileName: name, pageCount, pageSizes: [{ width: 612, height: 792, rotation: 0 }], metadata: latex, sampleText: pages, viaPage: null, formType: 'none' });
const filler = 'Responsible for analysis and reporting across teams, working with data and tools. ';
const cvs = {
  'CV with References heading': cvInput('cv.pdf', 3, [`Jane Doe\njane.doe@example.com | +44 7700 900123\n12 High Street, London SW1A 1AA\nEducation\nBSc Economics, Example University, 2021-2024\nExperience\nResearch Assistant, 2023-2024. ${filler}\nSkills\nPython, R, Stata\nReferences\nProf. A. Referee, Example University`, `Languages\nEnglish, French. ${filler}`]),
  'CV, minimal (no Experience)': cvInput('resume.pdf', 1, [`Jane Doe\nTel: +44 7700 900123  jane.doe@example.com\nEducation\nBSc Economics, Example University\nSkills\nPython, R, Stata, LaTeX. ${filler}\nReferences\nAvailable on request. ${filler}`]),
  'CV, long publication list': cvInput('cv-academic.pdf', 6, [`Curriculum Vitae\nProf. Alice Example, Example University\nalice@example.edu\nEducation\nPhD Economics, 2008\nPublications\n${Array.from({ length: 25 }, (_, i) => `[${i + 1}] Example, A. and Coauthor, B. (20${10 + (i % 14)}). Paper ${i}. Journal of Things. doi:10.1016/j.jot.20${10 + (i % 14)}.0${i}. arXiv:2101.0${1000 + i}`).join('\n')}\nReferences\nProf. B. Referee`]),
};
for (const [name, input] of Object.entries(cvs)) {
  const d = classify(input, noRules);
  const score = d.score === undefined ? '' : (d.score >= 0 ? '+' : '') + d.score.toFixed(1);
  const positive = (d.signals ?? []).filter((x) => x.weight > 0).reduce((n, x) => n + x.weight, 0);
  console.log(`${pad(name, 32)} ${pad(d.verdict, 13)} ${pad(d.rule ?? '', 11)} score ${pad(score, 6)} (evidence for a reading: +${positive})  ${d.reasons.join(' | ')}`);
  if (d.verdict === 'learning') results.push({ falseSaves: 1, missed: 0 });
}

// ---- timing on the largest sample ----

const sampleChars = (input) => input.sampleText.reduce((n, p) => n + p.length, 0);
const biggest = loaded.reduce((a, b) => (sampleChars(b.input) > sampleChars(a.input) ? b : a));
const times = [];
for (let i = 0; i < runs + 5; i++) {
  const t0 = performance.now();
  classify(biggest.input, noRules);
  const dt = performance.now() - t0;
  if (i >= 5) times.push(dt);
}
times.sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
console.log(`\ntiming: largest sample is ${basename(biggest.item.path)} (${sampleChars(biggest.input)} characters over ${biggest.input.sampleText.length} pages)`);
console.log(`  classify over ${runs} runs after 5 warm-up runs: median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, max ${times.at(-1).toFixed(1)} ms (budget 150 ms)`);
const cold = loaded.map(({ input }) => { const t0 = performance.now(); classify(input, noRules); return performance.now() - t0; });
console.log(`  first call per fixture, all ${cold.length} fixtures: max ${Math.max(...cold).toFixed(1)} ms`);

await server.close();
process.exit(results.some((r) => r.falseSaves > 0 || r.missed > 0) ? 1 : 0);
