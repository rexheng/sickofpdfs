// `pnpm typecheck`: type-checks the whole repo and reports every failing project, not just the first one.
// Runs the root project, the e2e project, then every workspace package's own `typecheck` script (pnpm -r --no-bail, so
// one failing package does not hide the errors of the ones after it). Exit 0 when all of them passed, 1 when any failed.
import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'root', args: ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json'] },
  { name: 'e2e', args: ['exec', 'tsc', '--noEmit', '-p', 'e2e/tsconfig.json'] },
  { name: 'packages', args: ['-r', '--no-bail', '--if-present', 'run', 'typecheck'] },
];

const failed = [];
for (const { name, args } of steps) {
  const r = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (r.status !== 0) failed.push(name);
}

if (failed.length) {
  console.error(`\ntypecheck: failed in ${failed.join(', ')}`);
  process.exit(1);
}
