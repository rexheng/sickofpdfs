// After `vite build`: adds everything the extension loads at run time to dist/ as plain files (the shape apps/extension's
// copy-ocr-assets.mjs will have): manifest + service worker, the PDF engine's files, onnxruntime-web's wasm/mjs, Tesseract.js's
// worker and core, and the models. Models are copied from models/ (fetch-models.mjs); only the ones named in MODELS are copied.
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = join(root, '../..');
const dist = join(root, process.env.SOP_DIST ?? 'dist');
const req = createRequire(join(root, 'package.json'));

const cp = async (from, to) => {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  return (await stat(to)).size;
};
import { realpathSync } from 'node:fs';
const pkgDir = (name) => realpathSync(join(root, 'node_modules', name));

let bytes = 0;
bytes += await cp(join(root, 'extension/manifest.json'), join(dist, 'manifest.json'));
bytes += await cp(join(root, 'extension/background.js'), join(dist, 'background.js'));

// PDF engine files (same list the extension build uses)
const viewer = join(repo, 'packages/viewer');
const vreq = createRequire(join(viewer, 'package.json'));
const list = JSON.parse(await readFile(join(viewer, 'src/backend/embedpdf/engine-files.json'), 'utf8'));
/** The root folder of an installed package: walk up from its entry point to the package.json naming it. */
const pkgRoot = (name) => {
  let dir = dirname(vreq.resolve(name));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch {
      // no package.json here: keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find the folder of ${name}`);
    dir = parent;
  }
};
for (const f of [list.wasm, ...list.fonts]) bytes += await cp(join(pkgRoot(f.package), f.from), join(dist, 'pdf', f.file));

// onnxruntime-web: the two flavours (plain wasm, and webgpu: in 1.31 the WebGPU entry loads the asyncify build, not the jsep one) as the package ships them
const ort = join(pkgDir('onnxruntime-web'), 'dist');
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'])
  bytes += await cp(join(ort, f), join(dist, 'ort', f));

// Tesseract.js: its worker script and the SIMD LSTM-only core (one self-contained .wasm.js), plus the plain fallback
const tess = pkgDir('tesseract.js');
bytes += await cp(join(tess, 'dist/worker.min.js'), join(dist, 'tess/worker.min.js'));
const core = join(dirname(tess), 'tesseract.js-core');
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) bytes += await cp(join(core, f), join(dist, 'tess', f));

// models
for (const sub of await readdir(join(root, 'models'))) {
  for (const f of await readdir(join(root, 'models', sub), { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const rel = join(f.parentPath.slice(join(root, 'models').length + 1), f.name);
    bytes += await cp(join(f.parentPath, f.name), join(dist, 'models', rel));
  }
}
console.log(`dist assets: ${(bytes / 2 ** 20).toFixed(1)} MiB copied`);
