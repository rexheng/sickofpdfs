// `pnpm -C apps/extension assets` (and the start of `build` / `build:e2e`): copies the PDF engine's files from the
// installed packages into the extension's static folder apps/extension/public/pdf/, which WXT copies to the build's
// pdf/. The viewer reaches them with chrome.runtime.getURL('pdf/…'); nothing is downloaded at run time.
//
// The list is packages/viewer/src/backend/embedpdf/engine-files.json (pdfium.wasm, four NotoSans styles and
// NotoSansHans-Regular.otf). The packages are resolved from @sop/viewer, the package that pins them (exact 2.15.1 and
// 1.0.0), so the extension needs no copies of those dependencies.
//
// It also copies the font that "Save this page to library" (spec R103) sets code in, Noto Sans Mono (CLIP_FONTS below), from
// the @expo-google-fonts package that ships it as a TrueType file. The page's own text uses the NotoSans files above.
//
// The Vitest browser project also runs it before any test (its globalSetup), so the browser tests never depend on an
// earlier build having filled public/pdf/.
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const viewer = join(repo, 'packages/viewer');
const out = join(repo, 'apps/extension/public/pdf');
const require = createRequire(join(viewer, 'package.json'));

/** A file of the package to start from: its entry point, or its package.json when it has no usable entry. */
function resolveEntry(name, resolver) {
  try {
    return resolver.resolve(name);
  } catch {
    return resolver.resolve(`${name}/package.json`);
  }
}

/** The root folder of an installed package: walk up from its entry point to the package.json naming it. */
async function packageRoot(name, resolver = require) {
  let dir = dirname(resolveEntry(name, resolver));
  for (;;) {
    const manifest = join(dir, 'package.json');
    try {
      if (JSON.parse(await readFile(manifest, 'utf8')).name === name) return dir;
    } catch {
      // no package.json here: keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find the folder of ${name}`);
    dir = parent;
  }
}

/** R103: the fonts a saved web page's PDF uses besides the engine's Noto Sans. Resolved from the extension's own dependencies. */
export const CLIP_FONTS = [{ file: 'NotoSansMono-Regular.ttf', package: '@expo-google-fonts/noto-sans-mono', from: '400Regular/NotoSansMono_400Regular.ttf' }];
const extensionRequire = createRequire(join(repo, 'apps/extension/package.json'));

/** Copies every engine file into apps/extension/public/pdf/. Also the Vitest browser project's globalSetup. */
export default async function copyEngineAssets() {
  const list = JSON.parse(await readFile(join(viewer, 'src/backend/embedpdf/engine-files.json'), 'utf8'));
  await mkdir(out, { recursive: true });
  let bytes = 0;
  for (const f of [list.wasm, ...list.fonts, ...CLIP_FONTS.map((c) => ({ ...c, fromExtension: true }))]) {
    const from = join(await packageRoot(f.package, f.fromExtension === true ? extensionRequire : require), f.from);
    const to = join(out, f.file);
    await copyFile(from, to);
    bytes += (await stat(to)).size;
  }
  console.log(`engine assets: ${1 + list.fonts.length + CLIP_FONTS.length} files, ${(bytes / 2 ** 20).toFixed(1)} MiB in apps/extension/public/pdf/`);
}

// Run as a script (`node scripts/copy-engine-assets.mjs`), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) await copyEngineAssets();
