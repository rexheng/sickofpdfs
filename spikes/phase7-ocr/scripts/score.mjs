// node scripts/score.mjs [engine-id ...]
// Scores results/raw/<engine>/<key>@<dpi>.json against the truth and writes results/scores.json (one row per engine, set, dpi).
//   truth of syn-/deg- pages: PDFium text and word boxes of the source page (test-assets/ocr/truth/source-textbook.json)
//   truth of real pages and receipts: the proofread (or hand-transcribed) text file; no boxes, so no box scores
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureList } from '../bench/fixtures.mjs';
import { normalize, pool, ratios, scoreBoxes, scoreText, toScanSpace, wordsToText } from '../src/scorer.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const OCR = join(root, '../../test-assets/ocr');
const RAW = join(root, 'results/raw');
const items = new Map(fixtureList().map((i) => [i.key, i]));
const source = JSON.parse(readFileSync(join(OCR, 'truth/source-textbook.json'), 'utf8'));

const isProse = (t) => {
  const n = normalize(t);
  const odd = Array.from(n).filter((c) => !/[\p{L}\p{N} .,;:'"()!?-]/u.test(c)).length;
  return n.length >= 1500 && odd / n.length < 0.01;
};
const want = process.argv.slice(2);
const engines = readdirSync(RAW).filter((e) => !want.length || want.includes(e));
const rows = [];
const perPage = [];
for (const engine of engines) {
  const groups = new Map(); // `${set}@${dpi}` -> [counts]
  for (const f of readdirSync(join(RAW, engine)).filter((f) => f.endsWith('.json') && !/\.run\d+\.json$/.test(f))) {
    const m = /^(.*)@(\d+)\.json$/.exec(f);
    if (!m) continue;
    const item = items.get(m[1]);
    if (!item) continue;
    const dpi = Number(m[2]);
    const raw = JSON.parse(readFileSync(join(RAW, engine, f), 'utf8'));
    // MINCONF=0.5 drops recognised words below that confidence before scoring (junk from figures and texture)
    if (process.env.MINCONF) raw.words = raw.words.filter((w) => w.confidence >= Number(process.env.MINCONF));
    const px2pt = 72 / dpi;
    const hyp = raw.words.map((w) => ({ text: w.text, box: { x: w.box.x * px2pt, y: w.box.y * px2pt, width: w.box.width * px2pt, height: w.box.height * px2pt } }));
    let truthText;
    let boxes = null;
    if (item.truth.kind === 'pdfium') {
      const t = source[item.truth.sourcePage];
      truthText = t.text;
      boxes = scoreBoxes(toScanSpace(t.words, t.size, item.truth.skewDeg), hyp);
    } else truthText = readFileSync(item.truth.file, 'utf8');
    const text = scoreText(truthText, raw.text ?? wordsToText(raw.words));
    const counts = { ...text, ...(boxes ?? {}) };
    const key = `${item.set}${item.set === 'real' || item.set === 'rcpt' ? `:${item.lang}` : ''}@${dpi}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(counts);
    // The textbook's figure, plot and formula pages have little running text, and PDFium's text order for them is not reading
    // order. `syn-prose` / `deg-prose` pool only pages of 1500+ characters in which under 1% of the characters are not plain
    // letters, digits, spaces or common punctuation: the pages a person would call text.
    if (item.truth.kind === 'pdfium' && isProse(truthText)) {
      const pk = `${item.set}-prose@${dpi}`;
      if (!groups.has(pk)) groups.set(pk, []);
      groups.get(pk).push(counts);
    }
    perPage.push({ engine, key: m[1], dpi, set: item.set, lang: item.lang, ...ratios(counts), words: raw.words.length, wallMs: raw.wallMs });
  }
  for (const [key, list] of groups) {
    const [setLang, dpi] = key.split('@');
    const total = pool(list);
    rows.push({ engine, group: setLang, dpi: Number(dpi), pages: list.length, ...ratios(total), counts: total });
  }
}
writeFileSync(join(root, 'results/scores.json'), JSON.stringify({ rows, perPage }, null, 1));
const pc = (x) => (x === null || x === undefined ? '   -  ' : `${(x * 100).toFixed(1).padStart(5)}%`);
for (const r of rows.sort((a, b) => a.group.localeCompare(b.group) || a.dpi - b.dpi || a.engine.localeCompare(b.engine)))
  console.log(`${r.group.padEnd(10)} ${String(r.dpi).padStart(3)}dpi ${r.engine.padEnd(34)} n=${String(r.pages).padStart(2)}  CER ${pc(r.cer)}  find ${pc(r.findability)}  recall ${pc(r.wordRecall)}  acc ${pc(r.accentRecall)}/${pc(r.accentFoldedRecall)}  hit ${pc(r.boxHitRate)}  cover ${pc(r.boxCoverage)}`);
