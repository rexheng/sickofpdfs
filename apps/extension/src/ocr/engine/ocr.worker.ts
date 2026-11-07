// The OCR engine's worker (module worker, started by engine.ts in a viewer tab or in the offscreen page's OCR worker). It loads
// onnxruntime-web (plain wasm, one thread: the build the learning filter already ships, ort/) and the PP-OCRv6 tiny models from
// the extension's own files on the first page, then reads one page at a time.
//
// No network: it imports and fetches addresses under its own origin only (the extension's), and the files are put there at build
// time (scripts/copy-ort-assets.mjs, scripts/fetch-ocr-models.mjs). It logs nothing about a page, and an error it reports names
// the stage that failed, never the text.
//
//   → { id, cmd: 'recognize', bitmap, base }   (the bitmap is transferred)   ← { id, ok, words, ms } | { id, ok: false, error, stopped }
//   → { id, cmd: 'stop' }                      stops page `id` at the next batch
import { DET_MODEL, OCR_DET_MAX_SIDE, OCR_MODELS_DIR, OCR_REC_BATCH, OCR_WIDTH_BUCKET, REC_MODEL } from './models';
import { OcrStopped, PpOcr } from './ppocr';

type Ort = typeof import('onnxruntime-web');

let engine: Promise<PpOcr> | null = null;
const stopped = new Set<number>();

/** The folder must be under this worker's own origin: the models never come from anywhere else. */
function ownFolder(base: string): string {
  const url = new URL(base);
  if (url.origin !== self.location.origin || !url.pathname.endsWith('/')) throw new Error('asset folder is not a folder of this extension');
  return url.href;
}

async function bytesOf(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot read ${url.slice(url.lastIndexOf('/') + 1)} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function load(base: string): Promise<PpOcr> {
  const folder = ownFolder(base);
  const ort = (await import(/* @vite-ignore */ `${folder}ort/ort.wasm.min.mjs`)) as Ort;
  ort.env.logLevel = 'error'; // the models make the runtime warn about unused initialisers on every load
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = `${folder}ort/`;
  const dir = (m: string) => `${folder}${OCR_MODELS_DIR}${m}/`;
  const [detModel, recModel, detYml, recYml] = await Promise.all([
    bytesOf(`${dir(DET_MODEL)}inference.onnx`),
    bytesOf(`${dir(REC_MODEL)}inference.onnx`),
    bytesOf(`${dir(DET_MODEL)}inference.yml`).then((b) => new TextDecoder().decode(b)),
    bytesOf(`${dir(REC_MODEL)}inference.yml`).then((b) => new TextDecoder().decode(b)),
  ]);
  const made = new PpOcr({ ort, detModel, recModel, detYml, recYml, detMaxSide: OCR_DET_MAX_SIDE, recBatch: OCR_REC_BATCH, widthBucket: OCR_WIDTH_BUCKET });
  await made.init();
  return made;
}

function pixels(bitmap: ImageBitmap): { data: Uint8ClampedArray; width: number; height: number } {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d canvas in the OCR worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

// One page at a time, in the order asked (the runtime runs one inference per session at once).
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { id: number; cmd: string; bitmap?: ImageBitmap; base?: string };
  if (m.cmd === 'stop') {
    stopped.add(m.id);
    return;
  }
  if (m.cmd !== 'recognize' || !m.bitmap || typeof m.base !== 'string') return;
  const { id, bitmap, base } = m;
  queue = queue.then(async () => {
    try {
      if (stopped.has(id)) throw new OcrStopped();
      const t0 = performance.now();
      engine ??= load(base);
      const ready = await engine;
      const t1 = performance.now();
      const image = pixels(bitmap);
      const { words, ms } = await ready.recognize(image, () => stopped.has(id));
      self.postMessage({ id, ok: true, words, ms: { ...ms, load: t1 - t0, total: performance.now() - t0 } });
    } catch (error) {
      if (!(error instanceof OcrStopped)) engine = null; // a failed start may be tried again by the next page
      bitmap.close();
      self.postMessage({ id, ok: false, stopped: error instanceof OcrStopped, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error' });
    } finally {
      stopped.delete(id);
    }
  });
};
