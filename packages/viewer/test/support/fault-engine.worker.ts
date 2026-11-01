// Test support, not a test: the real engine worker (engine.worker.ts) plus messages that make it fail on purpose, so
// tests can check how PdfBackend handles a crashed, hung or out-of-memory engine. Use it through the backend's
// `createWorker` option and keep the Worker objects to post the faults to:
//
//   const workers: Worker[] = [];
//   const be = createEmbedPdfBackend(assets, { hangTimeoutMs: 500, createWorker: () => {
//     const w = new Worker(new URL('<path to>/test/support/fault-engine.worker.ts', import.meta.url), { type: 'module' });
//     workers.push(w);
//     return w;
//   } });
//   workers[0].postMessage({ type: 'fault', kind: 'hang' });
//
// Faults ({ type: 'fault', kind }):
//   crash  throws an uncaught error in the worker (the page sees the Worker's `error` event);
//   hang   spins forever, so the next call never gets an answer (the watchdog's case);
//   oom    fills the wasm heap up to its limit, so PDFium's next allocation fails and it aborts (a real out-of-memory).
// { type: 'resources' } answers { type: 'resources', entries: { name, initiatorType }[] }: the worker's own resource
// timing entries (the page cannot see the worker's requests).
import '../../src/backend/embedpdf/engine.worker';

/** The wasm exports, caught as Emscripten instantiates pdfium.wasm (it does so on the `init` message, after this runs). */
let wasm: { malloc(bytes: number): number } | null = null;
const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (...args: unknown[]) => Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance>;
(WebAssembly as { instantiate: unknown }).instantiate = async (...args: unknown[]) => {
  const result = await instantiate(...args);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  wasm = instance.exports as unknown as { malloc(bytes: number): number };
  return result;
};

const engine = self.onmessage;
self.onmessage = (event: MessageEvent<{ type?: string; kind?: string }>) => {
  const msg = event.data;
  if (msg.type === 'resources') {
    const entries = performance.getEntriesByType('resource').map((e) => ({ name: e.name, initiatorType: (e as PerformanceResourceTiming).initiatorType }));
    self.postMessage({ type: 'resources', entries });
    return;
  }
  if (msg.type !== 'fault') {
    engine?.call(self, event);
    return;
  }
  if (msg.kind === 'crash') throw new Error('injected crash');
  if (msg.kind === 'hang') for (;;);
  if (msg.kind === 'oom') {
    if (!wasm) throw new Error('fault oom: pdfium.wasm is not instantiated yet');
    // Allocate in halving blocks until not even 4 KiB is left. The blocks are never freed.
    for (let size = 64 * 2 ** 20; size >= 4096; ) if (!wasm.malloc(size)) size /= 2;
  }
};
