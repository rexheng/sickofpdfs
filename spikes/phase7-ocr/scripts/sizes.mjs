// node scripts/sizes.mjs
// Raw and deflated (zip-like, level 9) sizes of everything an OCR candidate would ship: runtime files and models.
// Writes results/sizes.json. Extension-zip size is what counts; Chrome Web Store zips are deflate.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, process.env.SOP_DIST ?? 'dist');
const sz = (p) => {
  const buf = readFileSync(join(dist, p));
  return { file: p, bytes: buf.length, zipBytes: deflateRawSync(buf, { level: 9 }).length };
};
const sum = (list) => ({ bytes: list.reduce((a, x) => a + x.bytes, 0), zipBytes: list.reduce((a, x) => a + x.zipBytes, 0) });
const group = (name, files) => {
  const list = files.map(sz);
  return { name, files: list, ...sum(list) };
};
const pp = (n) => [`models/ppocr/${n}/inference.onnx`, `models/ppocr/${n}/inference.yml`];
const out = [
  group('onnxruntime-web, WASM only (ort.wasm.min.mjs + threaded wasm)', ['ort/ort.wasm.min.mjs', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm']),
  group('onnxruntime-web, WebGPU build (asyncify wasm; also runs on the CPU)', ['ort/ort.webgpu.min.mjs', 'ort/ort-wasm-simd-threaded.asyncify.mjs', 'ort/ort-wasm-simd-threaded.asyncify.wasm']),
  group('Tesseract.js worker + SIMD LSTM core (one self-contained .wasm.js)', ['tess/worker.min.js', 'tess/tesseract-core-simd-lstm.wasm.js']),
  group('Tesseract.js fallback cores (no-SIMD, relaxed-SIMD)', ['tess/tesseract-core-lstm.wasm.js', 'tess/tesseract-core-relaxedsimd-lstm.wasm.js']),
  group('tessdata_fast eng', ['models/tessdata_fast/eng.traineddata']),
  group('tessdata_fast fra', ['models/tessdata_fast/fra.traineddata']),
  group('tessdata_fast deu', ['models/tessdata_fast/deu.traineddata']),
  group('tessdata_best eng (reference, not shippable)', ['models/tessdata_best/eng.traineddata']),
  group('PP-OCRv6 tiny (det + rec)', [...pp('PP-OCRv6_tiny_det'), ...pp('PP-OCRv6_tiny_rec')]),
  group('PP-OCRv6 small (det + rec)', [...pp('PP-OCRv6_small_det'), ...pp('PP-OCRv6_small_rec')]),
  group('PP-OCRv6 medium (det + rec)', [...pp('PP-OCRv6_medium_det'), ...pp('PP-OCRv6_medium_rec')]),
  group('PP-OCRv5 mobile det', pp('PP-OCRv5_mobile_det')),
  group('PP-OCRv5 mobile rec (multi-script)', pp('PP-OCRv5_mobile_rec')),
  group('PP-OCRv5 latin rec', pp('latin_PP-OCRv5_mobile_rec')),
  group('PP-OCRv5 en rec', pp('en_PP-OCRv5_mobile_rec')),
  group('PP-OCRv6 tiny det', pp('PP-OCRv6_tiny_det')),
  group('PP-OCRv6 tiny rec', pp('PP-OCRv6_tiny_rec')),
  group('PP-OCRv6 small det', pp('PP-OCRv6_small_det')),
  group('PP-OCRv6 small rec', pp('PP-OCRv6_small_rec')),
  group('our OCR code (PP-OCR pipeline + worker + bench glue, unminified)', ['assets/ocr.worker-' + (await import('node:fs')).readdirSync(join(dist, 'assets')).find((f) => f.startsWith('ocr.worker-')).slice('ocr.worker-'.length)]),
];
writeFileSync(join(root, 'results/sizes.json'), JSON.stringify(out, null, 1));
const mb = (n) => (n / 2 ** 20).toFixed(2).padStart(7);
for (const g of out) console.log(`${g.name.padEnd(72)} raw ${mb(g.bytes)} MiB   zip ${mb(g.zipBytes)} MiB`);
