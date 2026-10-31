// P0-1 render check: spike.html?check=render&engine=v2-blob|v2-file&file=<pdf url>[&fonts=<pdf url>]
// Opens `file`, renders page 1 at scale 1.5 into a canvas and measures its ink; does the same for
// the `fonts` fixture (non-embedded fonts); reports CSP violations, worker URLs and font requests.
// The helpers below are exported for later checks.
import { createFileWorkerEngine, createStockBlobEngine, WORKER_CSP_EVENT, type SpikeEngine } from '../engine/client';

const STEP_TIMEOUT_MS = 20_000;
const SCALE = 1.5;
/** A pixel is ink when any channel is below this (white is 255; anti-aliasing counts as ink). */
const INK_BELOW = 250;

export function createEngine(name: string, opts: { workers?: 1 | 2 } = {}): Promise<SpikeEngine> {
  if (name === 'v2-blob') return createStockBlobEngine();
  if (name === 'v2-file') return createFileWorkerEngine(opts);
  throw new Error(`unknown engine "${name}"`);
}

/** Records CSP violations from now on: the document's, and those our engine workers forward. */
export function collectCspViolations(): string[] {
  const list: string[] = [];
  document.addEventListener('securitypolicyviolation', (e) =>
    list.push(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile || '?'}:${e.lineNumber}`),
  );
  window.addEventListener(WORKER_CSP_EVENT, (e) => list.push(`in worker: ${(e as CustomEvent<string>).detail}`));
  return list;
}

/** Records the URL scheme of every Worker the page creates from now on, and their error events. */
export function watchWorkers(): { schemes: string[]; errors: string[] } {
  const seen = { schemes: [] as string[], errors: [] as string[] };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      seen.schemes.push(new URL(String(url), location.href).protocol);
      this.addEventListener('error', (e) => seen.errors.push(`${String(url).slice(0, 60)}: ${e.message || 'error event without a message'}`));
    }
  };
  return seen;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Draws the bitmap into a new canvas on the page, under a caption. */
export function showBitmap(bitmap: ImageBitmap, caption: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  const label = document.createElement('p');
  label.textContent = caption;
  document.getElementById('app')!.append(label, canvas);
  return canvas;
}

/** Share of the canvas's pixels that are not white. */
export function inkFraction(canvas: HTMLCanvasElement): number {
  const { data } = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! < INK_BELOW || data[i + 1]! < INK_BELOW || data[i + 2]! < INK_BELOW) ink++;
  }
  return ink / (canvas.width * canvas.height);
}

const ms = (from: number, to = performance.now()) => Math.round(to - from);

export async function run(params: URLSearchParams) {
  const engineName = params.get('engine') ?? 'v2-file';
  const file = params.get('file');
  const fonts = params.get('fonts');
  const cspViolations = collectCspViolations();
  const workers = watchWorkers();
  const r = {
    engine: engineName,
    error: null as string | null,
    cspViolations,
    workerSchemes: workers.schemes,
    workerErrors: workers.errors,
    pageCount: null as number | null,
    page1: null as { widthPt: number; heightPt: number; bitmapWidth: number; bitmapHeight: number } | null,
    inkFraction: null as number | null,
    /** From check start (engine creation included) to page 1 drawn on the canvas. */
    firstPageMs: null as number | null,
    startMs: null as number | null,
    openMs: null as number | null,
    renderMs: null as number | null,
    fontFixtureInkFraction: null as number | null,
    fontRequests: [] as string[],
    fontRequestsSource: engineName === 'v2-blob' ? 'XHR probe in the stock blob worker' : 'SpikeNative.fontRequests()',
  };

  const t0 = performance.now();
  try {
    if (!file) throw new Error('missing ?file=');
    const engine = await withTimeout(createEngine(engineName), STEP_TIMEOUT_MS, `${engineName} engine start`);
    const tStarted = performance.now();
    const doc = await withTimeout(engine.open(file), STEP_TIMEOUT_MS, 'open');
    const tOpened = performance.now();
    const bitmap = await withTimeout(engine.render(doc.docId, 0, SCALE), STEP_TIMEOUT_MS, 'render page 1');
    const canvas = showBitmap(bitmap, `${engineName}: ${file} page 1 at ${SCALE}×`);
    r.firstPageMs = ms(t0);
    r.startMs = ms(t0, tStarted);
    r.openMs = ms(tStarted, tOpened);
    r.renderMs = ms(tOpened);
    r.pageCount = doc.pageCount;
    r.page1 = { widthPt: doc.pages[0]!.width, heightPt: doc.pages[0]!.height, bitmapWidth: bitmap.width, bitmapHeight: bitmap.height };
    r.inkFraction = inkFraction(canvas);
    await engine.close(doc.docId);

    if (fonts) {
      const fdoc = await withTimeout(engine.open(fonts), STEP_TIMEOUT_MS, 'open font fixture');
      const fbitmap = await withTimeout(engine.render(fdoc.docId, 0, SCALE), STEP_TIMEOUT_MS, 'render font fixture');
      r.fontFixtureInkFraction = inkFraction(showBitmap(fbitmap, `${engineName}: ${fonts} page 1 at ${SCALE}×`));
      await engine.close(fdoc.docId);
    }
    r.fontRequests = await withTimeout(engine.call<string[]>('fontRequests'), STEP_TIMEOUT_MS, 'fontRequests');
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  await new Promise((resolve) => setTimeout(resolve, 50)); // let queued securitypolicyviolation events land
  return r;
}
