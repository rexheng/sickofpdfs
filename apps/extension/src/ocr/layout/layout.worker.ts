// The layout model's worker (module worker, started by layout-model.ts in the viewer tab). It loads onnxruntime-web (the one plain
// wasm build in ort/) and PP-DocLayout-S from the extension's own files on the first page, then finds one page's boxes at a time.
//
// No network: it imports and fetches addresses under its own origin only. It logs nothing about a page; an error names the stage.
//   → { id, cmd: 'detect', bitmap, base }   (the bitmap is transferred)   ← { id, ok, boxes, ms } | { id, ok: false, error }
import { decodeLayout } from './decode';
import { LAYOUT_INPUT, LAYOUT_MODEL_DIR, LAYOUT_MODEL_FILE } from './models';
import { layoutInput } from './preprocess';

type Ort = typeof import('onnxruntime-web');
interface Loaded {
  ort: Ort;
  session: import('onnxruntime-web').InferenceSession;
}

let loaded: Promise<Loaded> | null = null;

function ownFolder(base: string): string {
  const url = new URL(base);
  if (url.origin !== self.location.origin || !url.pathname.endsWith('/')) throw new Error('asset folder is not a folder of this extension');
  return url.href;
}

async function load(base: string): Promise<Loaded> {
  const folder = ownFolder(base);
  const ort = (await import(/* @vite-ignore */ `${folder}ort/ort.wasm.min.mjs`)) as Ort;
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = `${folder}ort/`;
  const res = await fetch(`${folder}models/ocr/${LAYOUT_MODEL_DIR}/${LAYOUT_MODEL_FILE}`);
  if (!res.ok) throw new Error(`cannot read the layout model (HTTP ${res.status})`);
  const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { logSeverityLevel: 3 }); // errors only (as ppocr.ts)
  return { ort, session };
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { id: number; cmd: string; bitmap?: ImageBitmap; base?: string };
  if (m.cmd !== 'detect' || !m.bitmap || typeof m.base !== 'string') return;
  const { id, bitmap, base } = m;
  queue = queue.then(async () => {
    try {
      const t0 = performance.now();
      loaded ??= load(base);
      const { ort, session } = await loaded;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d canvas in the layout worker');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { image, scaleFactor } = layoutInput(px);
      const out = await session.run({
        image: new ort.Tensor('float32', image, [1, 3, LAYOUT_INPUT, LAYOUT_INPUT]),
        scale_factor: new ort.Tensor('float32', scaleFactor, [1, 2]),
      });
      const [rows, count] = session.outputNames.map((n) => out[n]);
      const boxes = decodeLayout(rows.data as Float32Array, Number(count.data[0]), px.width, px.height);
      self.postMessage({ id, ok: true, boxes, ms: performance.now() - t0 });
    } catch (error) {
      loaded = null; // a failed start may be tried again by the next page
      bitmap.close();
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error' });
    }
  });
};
