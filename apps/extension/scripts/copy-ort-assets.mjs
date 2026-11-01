// `node scripts/copy-ort-assets.mjs` (the start of `build` and `build:e2e`): copies onnxruntime-web's plain WebAssembly
// files from the installed package into apps/extension/public/ort/ (gitignored), which WXT copies into the build as ort/.
// A worker loads them with import(chrome.runtime.getURL('ort/ort.wasm.min.mjs')) and points the runtime at the same folder
// (`env.wasm.wasmPaths`); nothing is downloaded when the extension runs.
//
// This is the one onnxruntime-web build in the extension, shared by the learning filter's tie-breaker (Phase 3) and the
// OCR engine (Phase 7): plain wasm, run on one thread, so the extension pages need no cross-origin isolation. The WebGPU
// build is a different, larger file and is not copied.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const out = fileURLToPath(new URL('../public/ort/', import.meta.url));

/** Copies the three files into apps/extension/public/ort/. */
export default async function copyOrtAssets() {
  const require = createRequire(import.meta.url);
  const dist = dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
  await mkdir(out, { recursive: true });
  let bytes = 0;
  for (const name of FILES) {
    const to = join(out, name);
    await copyFile(join(dist, name), to);
    bytes += (await stat(to)).size;
  }
  console.log(`onnxruntime-web: ${FILES.length} files, ${(bytes / 2 ** 20).toFixed(1)} MiB in apps/extension/public/ort/`);
}

// Run as a script, not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) await copyOrtAssets();
