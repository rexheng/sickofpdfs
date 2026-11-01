// node scripts/tables.mjs   ->  prints markdown tables from results/scores.json, results/runs/*.json and results/sizes.json
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scores = JSON.parse(readFileSync(join(root, 'results/scores.json'), 'utf8'));
const pc = (x, d = 1) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(d)}%`);
const only = process.argv.slice(2);
// each group is shown at the DPI its pages were scanned at (the sweeps at other DPIs are in their own table)
const NATIVE = { syn: 200, 'syn-prose': 200, deg: 150, 'deg-prose': 150, 'real:eng': 300, 'real:fra': 300, 'real:deu': 300, 'rcpt:eng': 200, 'rcpt:deu': 300 };
const find = (e, g) => scores.rows.find((x) => x.engine === e && x.group === g && x.dpi === NATIVE[g]);

// accuracy: one row per engine, columns = groups
const groups = ['syn', 'syn-prose', 'deg', 'real:eng', 'real:fra', 'real:deu', 'rcpt:eng', 'rcpt:deu'];
const engines = [...new Set(scores.rows.map((r) => r.engine))].filter((e) => !only.length || only.includes(e)).sort();
const cell = (e, g, f) => {
  const r = find(e, g);
  return r ? `${pc(r[f])}` : '–';
};
for (const [title, f] of [['Findability (share of true words of 4+ letters that Ctrl+F finds)', 'findability'], ['Character error rate (lower is better)', 'cer'], ['Word recall (all words, multiset)', 'wordRecall']]) {
  console.log(`\n**${title}**\n`);
  console.log(`| engine | ${groups.join(' | ')} |`);
  console.log(`|---|${groups.map(() => '---').join('|')}|`);
  for (const e of engines) console.log(`| ${e} | ${groups.map((g) => cell(e, g, f)).join(' | ')} |`);
}
console.log('\n**Boxes and accents**\n');
console.log('| engine | syn hit | syn cover | deg hit | deg cover | fra accents (exact / folded) | deu accents (exact / folded) |');
console.log('|---|---|---|---|---|---|---|');
for (const e of engines) {
  const g = (n) => find(e, n);
  const acc = (n) => (g(n) ? `${pc(g(n).accentRecall, 0)} / ${pc(g(n).accentFoldedRecall, 0)}` : '–');
  console.log(`| ${e} | ${pc(g('syn')?.boxHitRate)} | ${pc(g('syn')?.boxCoverage)} | ${pc(g('deg')?.boxHitRate)} | ${pc(g('deg')?.boxCoverage)} | ${acc('real:fra')} | ${acc('real:deu')} |`);
}

// timing runs
console.log('\n**Runs (seconds per page; memory of the extension renderer)**\n');
console.log('| run | pages | wall mean | p50 | p95 | min | CPU s/page | load avg (start) | ext. renderer RSS now / peak MB |');
console.log('|---|---|---|---|---|---|---|---|---|');
const dir = join(root, 'results/runs');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'offscreen-selfcheck.json').sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (!r.rows.length) continue; // init-only runs (WebGPU session check)
  const w = r.rows.map((x) => x.wallMs / 1000).sort((a, b) => a - b);
  const q = (p) => w[Math.min(w.length - 1, Math.floor((p / 100) * w.length))];
  const ext = r.memory.end.renderers.filter((x) => x.extension).sort((a, b) => b.rssMB - a.rssMB)[0];
  console.log(`| ${f.replace('.json', '')} | ${r.rows.length} | ${(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1)} | ${q(50).toFixed(1)} | ${q(95).toFixed(1)} | ${w[0].toFixed(1)} | ${r.cpu ? r.cpu.perPageSeconds.toFixed(1) : '–'} | ${r.load ? r.load.start[0].toFixed(1) : '–'} | ${ext ? `${ext.rssMB} / ${ext.peakMB}` : '–'} |`);
}
