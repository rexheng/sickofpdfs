// R104's upgrade check: `pnpm upgrade:check -- <previous-unpacked-dir> [<new-build-dir>]`.
// Installs the previous test build, makes a small library, copies the new build over the same folder, presses Reload and checks nothing
// is lost (e2e/upgrade/upgrade.spec.ts). The new build is apps/extension/.output/chrome-mv3 unless a second folder is given; it is
// built first (with SOP_BUILD_NUMBER, if set) when no folder is given. Exit code 0 only if everything passed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const [previous, newDir] = args;
if (!previous || !existsSync(resolve(previous, 'manifest.json'))) {
  console.error('Usage: pnpm upgrade:check -- <previous-unpacked-dir> [<new-build-dir>]\nThe previous build must be unpacked (it has a manifest.json).');
  process.exit(2);
}
const run = (cmd, argv, env = {}) => spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

if (!newDir && run('pnpm', ['build']) !== 0) process.exit(1);
const status = run('pnpm', ['exec', 'playwright', 'test', '-c', 'e2e/upgrade/playwright.config.ts', '--workers=1'], {
  UPGRADE_PREVIOUS_DIR: resolve(previous),
  ...(newDir ? { UPGRADE_NEW_DIR: resolve(newDir) } : {}),
});
console.log(status === 0 ? '\nUPGRADE CHECK PASSED: nothing was lost.' : '\nUPGRADE CHECK FAILED: do not ship this build.');
process.exit(status);
