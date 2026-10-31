// Rebuilds the results table in docs/spikes/phase0-report.md (between the results markers) from
// results/P0-<n>.json, the files tests/record.ts appends to. One row per check. Within a check,
// the latest entry of each test is used, so re-running a test replaces its earlier measurement.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const spikeRoot = fileURLToPath(new URL('..', import.meta.url));
const reportPath = join(spikeRoot, '../../docs/spikes/phase0-report.md');
const START = '<!-- results:start -->';
const END = '<!-- results:end -->';

const CHECKS = [
  ['P0-1', 'EmbedPDF renders in MV3 with bundled wasm and fonts'],
  ['P0-2', 'Zero network beyond the PDF'],
  ['P0-3', '600-page scan scrolls with no blank page over 150 ms'],
  ['P0-4', 'Text-layer selection suite'],
  ['P0-5', 'Bold as a glyph-outline overlay'],
  ['P0-6', '300 MB tab↔offscreen moves; the 1 GB open limit'],
  ['P0-7', 'Form-field detection'],
  ['P0-8', 'Backup-folder permission from an extension origin'],
  ['P0-9', 'TypeScript 7 with typescript-eslint'],
  ['P0-10', 'Page objects find figures within 20 ms a page'],
];

const statusOf = (pass) => (pass === true ? 'PASS' : pass === 'blocked' ? 'BLOCKED' : 'FAIL');
const cell = (s) => String(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

function latestPerTest(entries) {
  const byTest = new Map();
  entries.forEach((e, i) => byTest.set(e.test ?? `#${i}`, e)); // later entries replace earlier ones
  return [...byTest.values()];
}

// MIXED: some variants pass and some fail (each part of "Measured" then names its own result).
function overall(statuses) {
  const set = new Set(statuses);
  if (set.size === 1) return statuses[0];
  if (set.has('FAIL')) return set.has('PASS') ? 'MIXED' : 'FAIL';
  return 'BLOCKED';
}

async function row([id, name]) {
  const file = join(spikeRoot, 'results', `${id}.json`);
  if (!existsSync(file)) return `| ${id} | ${name} | NOT RUN | | |`;
  const entries = latestPerTest(JSON.parse(await readFile(file, 'utf8')));
  if (entries.length === 0) return `| ${id} | ${name} | NOT RUN | | |`;
  const statuses = entries.map((e) => statusOf(e.pass));
  const status = overall(statuses);
  const labelled = new Set(statuses).size > 1;
  const measured = entries.map((e, i) => `${labelled ? `${statuses[i]}: ` : ''}${e.measured}`).join('; ');
  const notes = [...new Set(entries.map((e) => e.note).filter(Boolean))].join('; ');
  return `| ${id} | ${name} | ${status} | ${cell(measured)} | ${cell(notes)} |`;
}

const table = [
  '| Check | Name | Result | Measured | Notes |',
  '| --- | --- | --- | --- | --- |',
  ...(await Promise.all(CHECKS.map(row))),
].join('\n');

const report = await readFile(reportPath, 'utf8');
const a = report.indexOf(START);
const b = report.indexOf(END);
if (a < 0 || b < a) throw new Error(`${reportPath} lacks the ${START} … ${END} markers`);
await writeFile(reportPath, `${report.slice(0, a + START.length)}\n${table}\n${report.slice(b)}`);
console.log(table);
