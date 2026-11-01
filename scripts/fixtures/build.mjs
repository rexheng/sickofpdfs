// `pnpm fixtures`: builds test-assets/ (gitignored). Each step is a script in this folder that fills or writes
// files under test-assets/; later tasks append their generators to STEPS, in dependency order.
//
// A step with `out` is skipped when that file already exists: the scan synthesiser takes about 25 s per 120 pages and
// its output is deterministic. Delete the file to build it again. scan-600.pdf (about 180 MB, 4 minutes) is built
// only for the speed gate (SOP_GATE=1).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../../test-assets/', import.meta.url));
const SCAN_SOURCE = `${assets}classifier/learning/textbook-grinstead-snell-probability.pdf`;
const scan = (pages) => ({
  script: 'make-scan.mjs',
  args: ['--source', SCAN_SOURCE, '--pages', String(pages), '--dpi', '200', '--quality', '60', '--out', `${assets}scan-${pages}.pdf`],
  out: `${assets}scan-${pages}.pdf`,
});

const STEPS = [
  { script: 'fetch-classifier.mjs' },
  { script: 'make-paper50.mjs' },
  { script: 'make-objects.mjs' },
  { script: 'make-tagged.mjs' },
  { script: 'make-mixed.mjs' },
  scan(120),
  ...(process.env.SOP_GATE === '1' ? [scan(600)] : []),
];

for (const step of STEPS) {
  const label = [step.script, ...(step.args ? [`→ ${step.out.slice(assets.length)}`] : [])].join(' ');
  if (step.out && existsSync(step.out)) {
    console.log(`\n== fixtures: ${label} (exists, skipped)`);
    continue;
  }
  console.log(`\n== fixtures: ${label}`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(step.script, import.meta.url)), ...(step.args ?? [])], { stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`fixtures: ${step.script} failed (${run.error?.message ?? `exit ${run.status ?? run.signal}`})`);
    process.exit(run.status ?? 1);
  }
}
console.log('\nfixtures: test-assets/ is ready');
