// `pnpm fixtures`: builds test-assets/ (gitignored). Each step is a script in this folder that fills or writes
// files under test-assets/; later tasks append their generators to STEPS, in dependency order.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STEPS = ['fetch-classifier.mjs', 'make-paper50.mjs'];

for (const step of STEPS) {
  console.log(`\n== fixtures: ${step}`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(step, import.meta.url))], { stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`fixtures: ${step} failed (${run.error?.message ?? `exit ${run.status ?? run.signal}`})`);
    process.exit(run.status ?? 1);
  }
}
console.log('\nfixtures: test-assets/ is ready');
