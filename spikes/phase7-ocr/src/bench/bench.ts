// The bench page (an extension page: chrome-extension://<id>/bench.html?server=http://127.0.0.1:<port>).
// The driver (bench/run.mjs) calls window.__bench.* through Playwright. Two kinds of work:
//   render  PDFs through the merged engine (packages/viewer/src/backend, renderTile) into PNGs + PDFium truth
//   ocr     one engine configuration over rendered pages, recording words and timings
import { createEmbedPdfBackend } from '../../../../packages/viewer/src/backend/embedpdf/backend.ts';
import { engineAssets } from '../../../../packages/viewer/src/backend/embedpdf/assets.ts';
import type { DocHandle, PdfBackend } from '../../../../packages/viewer/src/backend/types.ts';
import type { OcrWord, RgbaImage } from '../ocr/types.ts';
import type { EngineConfig } from './config.ts';
import { TesseractEngine } from './tesseract.ts';

const params = new URLSearchParams(location.search);
const server = params.get('server') ?? '';
const base = chrome.runtime.getURL('');
const log = (m: string) => {
  const el = document.getElementById('log');
  if (el) el.textContent = m;
};

async function put(path: string, body: BodyInit, type = 'application/octet-stream') {
  const res = await fetch(`${server}/save/${path}`, { method: 'PUT', body, headers: { 'content-type': type } });
  if (!res.ok) throw new Error(`save ${path}: HTTP ${res.status}`);
}

// ---------- render ----------
let backend: PdfBackend | null = null;
const docs = new Map<string, { doc: DocHandle; pageCount: number; pages: { width: number; height: number; rotation: number }[] }>();

async function openPdf(name: string) {
  const have = docs.get(name);
  if (have) return have;
  backend ??= createEmbedPdfBackend(engineAssets((p) => chrome.runtime.getURL(p)));
  const t0 = performance.now();
  const bytes = await (await fetch(`${server}/files/${name}`)).arrayBuffer();
  const fetched = performance.now();
  const info = await backend.open(bytes);
  const entry = { doc: info.doc, pageCount: info.pageCount, pages: info.pages };
  docs.set(name, entry);
  console.log(`opened ${name}: ${info.pageCount} pages, fetch ${(fetched - t0).toFixed(0)} ms, open ${(performance.now() - fetched).toFixed(0)} ms`);
  return entry;
}

interface TruthWord {
  text: string;
  box: { x: number; y: number; width: number; height: number };
}

async function renderPages(spec: { pdf: string; pages: number[]; dpis: number[]; keyBase: string }) {
  const d = await openPdf(spec.pdf);
  const out: { key: string; page: number; dpi: number; width: number; height: number; renderMs: number; copyMs: number; pngMs: number; pngBytes: number }[] = [];
  for (const page of spec.pages) {
    for (const dpi of spec.dpis) {
      const t0 = performance.now();
      const bmp = await backend!.renderTile(d.doc, { pageIndex: page, scale: dpi / 72, viewRotation: 0, withAnnotations: false });
      const t1 = performance.now();
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const t2 = performance.now();
      const png = await canvas.convertToBlob({ type: 'image/png' });
      const t3 = performance.now();
      const key = `${spec.keyBase}@${dpi}`;
      await put(`rendered/${key}.png`, png, 'image/png');
      out.push({ key, page, dpi, width: bmp.width, height: bmp.height, renderMs: t1 - t0, copyMs: t2 - t1, pngMs: t3 - t2, pngBytes: png.size });
      bmp.close();
    }
  }
  return out;
}

/** Words of one text page, from PDFium's glyphs: split at spaces and PDFium's generated breaks; box = union of the glyph boxes. */
async function pageWords(doc: DocHandle, page: number) {
  const g = await backend!.getPageGlyphs(doc, page);
  const words: (TruthWord & { line: number })[] = [];
  let cur: { text: string; x0: number; y0: number; x1: number; y1: number } | null = null;
  let line = 0;
  const flush = () => {
    if (cur) words.push({ text: cur.text, box: { x: cur.x0, y: cur.y0, width: cur.x1 - cur.x0, height: cur.y1 - cur.y0 }, line });
    cur = null;
  };
  for (const gl of g.glyphs) {
    if (gl.generated || /\s/.test(gl.text) || gl.text === '\uFFFE' || gl.text === '\uFFFF') {
      flush();
      if (gl.text === '\r' || gl.text === '\n') line++;
      continue;
    }
    const b = gl.box;
    if (b.width <= 0 || b.height <= 0) continue;
    if (!cur) cur = { text: '', x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
    cur.text += gl.text;
    cur.x0 = Math.min(cur.x0, b.x);
    cur.y0 = Math.min(cur.y0, b.y);
    cur.x1 = Math.max(cur.x1, b.x + b.width);
    cur.y1 = Math.max(cur.y1, b.y + b.height);
  }
  flush();
  return words;
}

/** PDFium's text and word boxes of pages of a text PDF: the known truth of the synthetic scans. */
async function truthPages(spec: { pdf: string; pages: number[]; prefix: string }) {
  const d = await openPdf(spec.pdf);
  const result: Record<number, { size: { width: number; height: number }; text: string; words: TruthWord[] }> = {};
  for (const page of spec.pages) {
    const text = await backend!.getPageText(d.doc, page);
    const words = (await pageWords(d.doc, page)).map(({ text, box }) => ({ text, box }));
    result[page] = { size: { width: d.pages[page]!.width, height: d.pages[page]!.height }, text, words };
  }
  await put(`truth/${spec.prefix}.json`, JSON.stringify(result), 'application/json');
  return { pages: Object.keys(result).length, words: Object.values(result).reduce((a, r) => a + r.words.length, 0) };
}

/**
 * The text layer of a PDF that already carries recognised text (what Chrome's "searchified" save produces), read with PDFium and
 * written in the same raw format as an OCR engine's result, with boxes in points (so it is scored as dpi 72).
 */
async function readTextLayer(spec: { pdf: string; items: { key: string; page: number }[]; engineId: string }) {
  const d = await openPdf(spec.pdf);
  let n = 0;
  for (const it of spec.items) {
    const words = (await pageWords(d.doc, it.page)).map((w) => ({ text: w.text, box: w.box, confidence: 1, line: w.line, block: 0 }));
    // `text` is PDFium's own page text (the string Ctrl+F searches); the scorer prefers it to re-joining the words
    const text = await backend!.getPageText(d.doc, it.page);
    await put(`raw/${spec.engineId}/${it.key}@72.json`, JSON.stringify({ engine: { id: spec.engineId, kind: 'text-layer' }, key: it.key, image: d.pages[it.page], wallMs: 0, timings: {}, text, words }), 'application/json');
    n++;
  }
  return { pages: n };
}

// ---------- ocr ----------
interface Adapter {
  recognize(img: RgbaImage): Promise<{ words: OcrWord[]; timings: Record<string, number>; wallMs: number }>;
  dispose(): Promise<void>;
}
let adapter: Adapter | null = null;
let currentCfg: EngineConfig | null = null;

function rpcWorker(w: Worker) {
  let n = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  w.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`worker error: ${e.message}`));
    pending.clear();
  };
  return (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<any>((resolve, reject) => {
      const id = ++n;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, ...msg }, transfer);
    });
}

async function ocrInit(cfg: EngineConfig) {
  await ocrDispose();
  currentCfg = cfg;
  const t0 = performance.now();
  if (cfg.kind === 'tesseract') {
    const eng = new TesseractEngine(cfg, base);
    await eng.init();
    adapter = {
      async recognize(img) {
        const t = performance.now();
        const words = await eng.recognize(img);
        return { words, timings: eng.lastTimings(), wallMs: performance.now() - t };
      },
      dispose: () => eng.dispose(),
    };
    return { facts: eng.info(), ms: { total: performance.now() - t0 }, probe: { crossOriginIsolated, navigatorGpu: 'gpu' in navigator } };
  }
  const worker = new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module', name: 'sop-ocr' });
  const call = rpcWorker(worker);
  const init = await call({ cmd: 'init', cfg, base });
  adapter = {
    async recognize(img) {
      const copy = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength) as ArrayBuffer;
      return call({ cmd: 'recognize', buffer: copy, width: img.width, height: img.height }, [copy]);
    },
    async dispose() {
      await call({ cmd: 'dispose' }).catch(() => {});
      worker.terminate();
    },
  };
  return init;
}

async function ocrDispose() {
  await adapter?.dispose();
  adapter = null;
}

async function loadImage(key: string): Promise<RgbaImage> {
  const blob = await (await fetch(`${server}/files/rendered/${key}.png`)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, width: d.width, height: d.height };
}

interface RunSpec {
  keys: string[];
  /** Save each result under raw/<engine id>/<key>.json (default true) */
  save?: boolean;
  /** Suffix for the saved file, so repeats do not overwrite (e.g. 'run2'). */
  tag?: string;
}

async function ocrRun(spec: RunSpec) {
  if (!adapter || !currentCfg) throw new Error('ocrInit first');
  const rows: { key: string; width: number; height: number; wallMs: number; timings: Record<string, number>; words: number; heap: number | null }[] = [];
  for (const key of spec.keys) {
    const img = await loadImage(key);
    const r = await adapter.recognize(img);
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    if (spec.save !== false) {
      await put(`raw/${currentCfg.id}/${key}${spec.tag ? `.${spec.tag}` : ''}.json`, JSON.stringify({ engine: currentCfg, key, image: { width: img.width, height: img.height }, wallMs: r.wallMs, timings: r.timings, words: r.words }), 'application/json');
    }
    rows.push({ key, width: img.width, height: img.height, wallMs: r.wallMs, timings: r.timings, words: r.words.length, heap });
    log(`${currentCfg.id}: ${rows.length}/${spec.keys.length} ${key} ${r.wallMs.toFixed(0)} ms`);
  }
  return rows;
}

/**
 * Visible page first (plan 7.0): pages `bg` are queued as background work, one page in flight at a time; at `injectAfterMs`
 * a request for `visible` arrives and goes to the front. Returns how long the visible page waited and took.
 */
async function visibleFirst(spec: { bg: string[]; visible: string; injectAfterMs: number }) {
  if (!adapter) throw new Error('ocrInit first');
  const queue = [...spec.bg];
  const t0 = performance.now();
  let injectedAt = -1;
  let doneAt = -1;
  let processed = 0;
  let waitingVisible = false;
  setTimeout(() => {
    injectedAt = performance.now() - t0;
    waitingVisible = true;
  }, spec.injectAfterMs);
  while (doneAt < 0) {
    let key: string | undefined;
    if (waitingVisible) {
      key = spec.visible;
      waitingVisible = false;
    } else key = queue.shift();
    if (!key) break;
    const img = await loadImage(key);
    await adapter.recognize(img);
    processed++;
    if (key === spec.visible) doneAt = performance.now() - t0;
  }
  return { injectedAtMs: injectedAt, doneAtMs: doneAt, visibleLatencyMs: doneAt - injectedAt, backgroundPagesDoneFirst: processed - 1 };
}

const api = {
  async env() {
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      navigatorGpu: 'gpu' in navigator,
      base,
    };
  },
  renderPages,
  truthPages,
  readTextLayer,
  ocrInit,
  ocrRun,
  ocrDispose,
  visibleFirst,
  async closeDocs() {
    for (const d of docs.values()) await backend?.close(d.doc);
    docs.clear();
  },
  async png(spec: { key: string }) {
    const img = await loadImage(spec.key);
    const t = performance.now();
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    await canvas.convertToBlob({ type: 'image/png' });
    return { pngEncodeMs: performance.now() - t };
  },
};
(window as unknown as { __bench: typeof api }).__bench = api;
(window as unknown as { __benchReady: boolean }).__benchReady = true;
log('bench ready');
