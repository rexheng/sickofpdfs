// `pnpm release:zip [--out <folder>]` writes sickofpdfs-<version>.zip (version from apps/extension/package.json, "Release 1").
// 1. Production build (`pnpm build`, which ends with the no-CDN, scripting and notices checks), with the manifest's version_name set.
//    The build number of a test build (SOP_BUILD_NUMBER) is cleared, so a release can never carry a test build's number.
// 2. Zips apps/extension/.output/chrome-mv3 (HOW-TO-UPDATE.txt and THIRD_PARTY_NOTICES.txt are in its root).
// 3. Runs scripts/release/verify-zip.mjs on the zip. A zip that fails is deleted.
// Default out folder: <repo>/dist (gitignored). The extension's private key is not needed and is never read: an unpacked
// extension gets its id from the public key in the manifest.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_NAME = 'Release 1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const outAt = args.indexOf('--out');
const out = resolve(outAt === -1 ? resolve(root, 'dist') : args[outAt + 1] ?? '');
const version = JSON.parse(readFileSync(resolve(root, 'apps/extension/package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`apps/extension/package.json version "${version}" is not like 1.0.0`);
  process.exit(1);
}

const env = { ...process.env, SOP_VERSION_NAME: RELEASE_NAME };
delete env.SOP_BUILD_NUMBER;
if (spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', env }).status !== 0) process.exit(1);

mkdirSync(out, { recursive: true });
const build = resolve(root, 'apps/extension/.output/chrome-mv3');
const zip = resolve(out, `sickofpdfs-${version}.zip`);
if (existsSync(zip)) rmSync(zip);
// -X: no extra file attributes; -D: no folder entries. The zip's top level is the extension itself.
if (spawnSync('zip', ['-r', '-q', '-X', '-D', zip, '.'], { cwd: build, stdio: 'inherit' }).status !== 0) {
  console.error('Could not make the zip (is `zip` installed?).');
  process.exit(1);
}
if (spawnSync('node', ['scripts/release/verify-zip.mjs', zip], { cwd: root, stdio: 'inherit' }).status !== 0) {
  rmSync(zip, { force: true });
  console.error('The zip failed verify-zip and was deleted.');
  process.exit(1);
}
console.log(`Wrote ${zip}`);
