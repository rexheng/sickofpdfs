import { createPdfiumWorkerEngine } from '@embedpdf/engines/pdfium';
import type { PdfDocumentObject } from '@embedpdf/models';
import { bundledFontUrls } from './fonts';
import type { SpikeDoc, SpikeRect } from './spike-native';

export type { SpikeDoc, SpikeRect };

declare const chrome: { runtime: { getURL(path: string): string } };

export interface SpikeEngine {
  open(url: string, password?: string): Promise<SpikeDoc>;
  render(docId: string, pageIndex: number, scale: number, rect?: SpikeRect): Promise<ImageBitmap>;
  call<T>(method: string, ...args: unknown[]): Promise<T>; // any SpikeNative method by name
  close(docId: string): Promise<void>;
}

/** Fired on `window` for each CSP violation inside an engine worker (they never reach the document). */
export const WORKER_CSP_EVENT = 'spike:worker-csp';

const WORKER_START_TIMEOUT_MS = 20_000;
const wasmUrl = () => chrome.runtime.getURL('pdf/pdfium.wasm');
const fontBaseUrl = () => chrome.runtime.getURL('pdf');

async function fetchPdf(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.arrayBuffer();
}

class EngineWorker {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  private constructor(private readonly worker: Worker) {
    worker.addEventListener('message', ({ data }) => {
      if (data?.type === 'csp') window.dispatchEvent(new CustomEvent(WORKER_CSP_EVENT, { detail: data.violation }));
      const call = typeof data?.id === 'number' ? this.pending.get(data.id) : undefined;
      if (!call) return;
      this.pending.delete(data.id);
      if (data.ok) call.resolve(data.value);
      else call.reject(new Error(data.error));
    });
  }

  /** Loads src/engine/engine.worker.ts from its chrome-extension:// file URL and waits for PDFium. */
  static start(): Promise<EngineWorker> {
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'sop-engine' });
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail(`engine worker gave no answer within ${WORKER_START_TIMEOUT_MS} ms`), WORKER_START_TIMEOUT_MS);
      worker.addEventListener('error', (e) => fail(`engine worker failed to load: ${e.message || 'no message'}`));
      const onInit = ({ data }: MessageEvent) => {
        if (data?.type === 'init-error') fail(`engine worker init failed: ${data.error}`);
        if (data?.type !== 'ready') return;
        clearTimeout(timer);
        worker.removeEventListener('message', onInit);
        resolve(new EngineWorker(worker));
      };
      worker.addEventListener('message', onInit);
      worker.postMessage({ type: 'init', wasmUrl: wasmUrl(), fontBaseUrl: fontBaseUrl() });
    });
  }

  call<T>(method: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args }, transfer);
    });
  }
}

/**
 * Our engine worker(s) from a file URL. With `workers: 2` every document is opened in both
 * workers and pages are rendered by parity (even pages on the first worker, odd on the second).
 * `call` goes to the first worker.
 */
export async function createFileWorkerEngine(opts: { workers?: 1 | 2 } = {}): Promise<SpikeEngine> {
  const workers = await Promise.all(Array.from({ length: opts.workers ?? 1 }, () => EngineWorker.start()));
  let opened = 0;
  return {
    async open(url, password) {
      const bytes = await fetchPdf(url);
      const docId = `doc-${++opened}`;
      // Each worker takes its own copy by transfer; the last one takes the original.
      const docs = await Promise.all(
        workers.map((w, i) => {
          const buffer = i === workers.length - 1 ? bytes : bytes.slice(0);
          return w.call<SpikeDoc>('openBuffer', [docId, buffer, password], [buffer]);
        }),
      );
      return docs[0]!;
    },
    render: (docId, pageIndex, scale, rect) =>
      workers[pageIndex % workers.length]!.call<ImageBitmap>('renderRaw', [docId, pageIndex, scale, rect]),
    call: <T>(method: string, ...args: unknown[]) => workers[0]!.call<T>(method, args),
    async close(docId) {
      await Promise.all(workers.map((w) => w.call('closeDoc', [docId])));
    },
  };
}

/**
 * Runs `create` while every JavaScript Blob turned into an object URL gets a prelude that reports
 * each XMLHttpRequest URL on a BroadcastChannel. The stock engine's workers are blob: workers we
 * cannot otherwise observe, and its font loader is a synchronous XHR that neither the page nor the
 * extension's service worker sees. The prelude only reports; every request still runs unchanged.
 */
function withXhrProbe<T>(create: () => T): { value: T; urls: string[] } {
  const channel = new BroadcastChannel(`spike-xhr-probe-${crypto.randomUUID()}`);
  const urls: string[] = [];
  channel.onmessage = (e: MessageEvent<string>) => urls.push(e.data);
  const prelude =
    `{ const c = new BroadcastChannel(${JSON.stringify(channel.name)}), open = XMLHttpRequest.prototype.open;` +
    ` XMLHttpRequest.prototype.open = function (m, u, ...rest) { c.postMessage(String(u)); return open.call(this, m, u, ...rest); }; }\n`;
  const nativeCreate = URL.createObjectURL;
  URL.createObjectURL = (obj: Blob | MediaSource) =>
    obj instanceof Blob && obj.type === 'application/javascript'
      ? nativeCreate(new Blob([prelude, obj], { type: obj.type }))
      : nativeCreate(obj);
  try {
    return { value: create(), urls };
  } finally {
    URL.createObjectURL = nativeCreate;
  }
}

/**
 * The stock @embedpdf/engines worker engine: its PDFium worker and its two PNG-encoder workers are
 * created from blob: URLs. Fonts are given as URLs only (a loader function cannot be posted to the
 * worker). `call('fontRequests')` returns the font URLs the PDFium worker requested (withXhrProbe);
 * other `call` methods go to the PdfEngine method of that name.
 */
export async function createStockBlobEngine(): Promise<SpikeEngine> {
  const probe = withXhrProbe(() => createPdfiumWorkerEngine(wasmUrl(), { fontFallback: bundledFontUrls(fontBaseUrl()) }));
  const engine = probe.value;
  const docs = new Map<string, PdfDocumentObject>();
  let opened = 0;
  const doc = (docId: string) => {
    const d = docs.get(docId);
    if (!d) throw new Error(`document ${docId} is not open`);
    return d;
  };
  return {
    async open(url, password) {
      const content = await fetchPdf(url);
      const d = await engine.openDocumentBuffer({ id: `doc-${++opened}`, content }, { password }).toPromise();
      docs.set(d.id, d);
      return { docId: d.id, pageCount: d.pageCount, pages: d.pages.map((p) => ({ width: p.size.width, height: p.size.height })) };
    },
    async render(docId, pageIndex, scale, rect) {
      const d = doc(docId);
      const page = d.pages[pageIndex];
      if (!page) throw new Error(`page ${pageIndex} out of range`);
      const blob = rect
        ? await engine.renderPageRect(d, page, { origin: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } }, { scaleFactor: scale }).toPromise()
        : await engine.renderPage(d, page, { scaleFactor: scale }).toPromise();
      return createImageBitmap(blob);
    },
    async call<T>(method: string, ...args: unknown[]): Promise<T> {
      if (method === 'fontRequests') {
        await new Promise((resolve) => setTimeout(resolve, 50)); // BroadcastChannel delivery is a separate task
        return probe.urls.filter((u) => /\.(ttf|otf)$/.test(u)) as T;
      }
      const fn = (engine as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') throw new Error(`PdfEngine has no method "${method}"`);
      return (fn.apply(engine, args) as { toPromise(): Promise<T> }).toPromise();
    },
    async close(docId) {
      await engine.closeDocument(doc(docId)).toPromise();
      docs.delete(docId);
    },
  };
}
