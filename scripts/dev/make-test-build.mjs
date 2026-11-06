// Makes a test build zip: `pnpm test-build -- <N> [--previous <previous-unpacked-dir>] [--out <folder>]`.
// 1. Builds with SOP_BUILD_NUMBER=<N>, so the manifest says "Test build N" (version 0.1.N) and Home says "Updated to test build N".
//    The build ends with its checks; the R103 one runs again here on the folder that is zipped: only the toolbar menu's click path
//    (the popup and the save-page tab) may hold chrome.scripting (apps/extension/scripts/check-scripting.mjs). A build that fails
//    it is not zipped.
// 2. With --previous (always pass it once a test build has been shipped): runs the upgrade check (R104) from that build to this one.
//    A build that loses anything is not zipped.
// 3. Zips apps/extension/.output/chrome-mv3 (HOW-TO-UPDATE.txt is in its root) to <out>/sickofpdfs-test-build-<N>.zip (default out: the repo root).
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const n = args[0];
if (!n || !/^[1-9]\d{0,4}$/.test(n)) {
  console.error('Usage: pnpm test-build -- <N> [--previous <previous-unpacked-dir>] [--out <folder>]');
  process.exit(2);
}
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, stdio: 'inherit', env: { ...process.env, SOP_BUILD_NUMBER: n }, ...opts }).status ?? 1;
const build = resolve(root, 'apps/extension/.output/chrome-mv3');

if (run('pnpm', ['build']) !== 0) process.exit(1);
if (run('node', ['apps/extension/scripts/check-scripting.mjs', build]) !== 0) process.exit(1);
const previous = flag('--previous');
if (previous) {
  if (run('node', ['scripts/dev/upgrade-check.mjs', previous, build]) !== 0) process.exit(1);
} else {
  console.warn('WARNING: no --previous given, so the upgrade check was NOT run. Do not ship this zip to the owner.');
}
const zip = resolve(flag('--out') ?? root, `sickofpdfs-test-build-${n}.zip`);
if (existsSync(zip)) rmSync(zip);
const made = spawnSync('zip', ['-r', '-q', zip, '.'], { cwd: build, stdio: 'inherit' }).status === 0 || spawnSync('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", ".")', zip], { cwd: build, stdio: 'inherit' }).status === 0;
if (!made) {
  console.error('Could not make the zip (no zip or python3).');
  process.exit(1);
}
console.log(`Wrote ${zip}`);
