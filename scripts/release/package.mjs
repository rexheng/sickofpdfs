// `pnpm release:zip [--out <folder>]` writes sickofpdfs-<version>.zip (version from apps/extension/package.json, "Release 1").
// `pnpm release:zip --store` writes sickofpdfs-<version>-store.zip, the one to upload to the Chrome Web Store (CHROMEWEBSTORE.md):
// the same build without the manifest's `key` (the store refuses a manifest that has one) and without HOW-TO-UPDATE.txt (store
// installs update by themselves). On the very first upload only, the owner adds key.pem to the zip's top level, so the store keeps
// the extension's fixed id (CHROMEWEBSTORE.md, "First upload"). This script never reads or adds the private key.
// 1. Production build (`pnpm build`, which ends with the no-CDN, scripting and notices checks), with the manifest's version_name set.
//    The build number of a test build (SOP_BUILD_NUMBER) is cleared, so a release can never carry a test build's number.
// 2. Zips apps/extension/.output/chrome-mv3 (HOW-TO-UPDATE.txt and THIRD_PARTY_NOTICES.txt are in its root).
// 3. Runs scripts/release/verify-zip.mjs on the zip. A zip that fails is deleted.
// Default out folder: <repo>/dist (gitignored). The extension's private key is not needed and is never read: an unpacked
// extension gets its id from the public key in the manifest.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_NAME = 'Release 1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const store = args.includes('--store');
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
const built = resolve(root, 'apps/extension/.output/chrome-mv3');
const zip = resolve(out, store ? `sickofpdfs-${version}-store.zip` : `sickofpdfs-${version}.zip`);
if (existsSync(zip)) rmSync(zip);
// The store zip is made from a copy, so the build folder (which Load unpacked and the upgrade check use) keeps its key.
const staging = store ? mkdtempSync(join(tmpdir(), 'sop-store-')) : null;
const build = staging ?? built;
try {
  if (staging !== null) {
    cpSync(built, staging, { recursive: true });
    const manifestPath = join(staging, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.key;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(join(staging, 'HOW-TO-UPDATE.txt'), { force: true });
  }
  // -X: no extra file attributes; -D: no folder entries. The zip's top level is the extension itself. Source maps and system
  // files never go in.
  const zipped = spawnSync('zip', ['-r', '-q', '-X', '-D', zip, '.', '-x', '*.map', '*.DS_Store', '*Thumbs.db'], { cwd: build, stdio: 'inherit' });
  if (zipped.status !== 0) {
    console.error('Could not make the zip (is `zip` installed?).');
    process.exit(1);
  }
} finally {
  if (staging !== null) rmSync(staging, { recursive: true, force: true });
}
if (spawnSync('node', ['scripts/release/verify-zip.mjs', zip, ...(store ? ['--store'] : [])], { cwd: root, stdio: 'inherit' }).status !== 0) {
  rmSync(zip, { force: true });
  console.error('The zip failed verify-zip and was deleted.');
  process.exit(1);
}
console.log(`Wrote ${zip}`);
