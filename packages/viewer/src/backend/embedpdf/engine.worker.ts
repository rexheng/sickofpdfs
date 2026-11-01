// The engine worker: our own module worker, loaded from a chrome-extension:// file URL in the product (the Phase 0
// `v2-file` variant), running PDFium through SopPdfiumNative. The protocol is in rpc.ts.
//
// - init: fetches pdfium.wasm from the extension, starts PDFium with the bundled fallback fonts, answers `ready`.
// - calls: one EngineApi method each; an ImageBitmap result is transferred.
// - A wasm trap (WebAssembly.RuntimeError, which is also how PDFium's abort() on a failed allocation surfaces) leaves
//   the module unusable, and an allocation failure with the heap at its limit leaves it out of memory. Either way the
//   worker answers `fatal` instead of replying, and the page ends it.
import { init } from '@embedpdf/pdfium';
import { ENGINE_METHODS, toWireError, type CallMessage, type EngineMethod, type InitMessage, type WorkerMessage } from './rpc';
import { bundledFontFallback } from './fonts';
import { SopPdfiumNative } from './sop-native';

/** The wasm heap's limit in this build (getHeapMax in @embedpdf/pdfium's Emscripten glue). */
const HEAP_LIMIT = 2 ** 31;
/** A heap this close to the limit counts as full. */
const HEAP_FULL_MARGIN = 64 * 2 ** 20;

const methods: ReadonlySet<string> = new Set(ENGINE_METHODS);
let native: SopPdfiumNative | null = null;
/** Emscripten printed "Cannot enlarge memory" during the current call: the heap could not grow. */
let heapLimitHit = false;

const post = (message: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(message, { transfer });

// The message handler is async, so anything it throws becomes an unhandled rejection, which never reaches the page and
// would leave a call unanswered. Report it as an uncaught error instead: the page then fails every waiting call.
self.addEventListener('unhandledrejection', (event) => self.reportError(event.reason));

self.onmessage = (event: MessageEvent<InitMessage | CallMessage>) => {
  const msg = event.data;
  if ('type' in msg) void start(msg);
  else void call(msg);
};

async function start(msg: InitMessage): Promise<void> {
  try {
    const res = await fetch(msg.wasmUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${msg.wasmUrl}`);
    const wasmBinary = await res.arrayBuffer();
    const module = await init({
      wasmBinary,
      // Emscripten's stderr: only used to notice a heap that cannot grow; nothing is logged.
      printErr: (text: string) => {
        if (text.includes('Cannot enlarge memory')) heapLimitHit = true;
      },
    });
    native = new SopPdfiumNative(module, { fontFallback: bundledFontFallback(msg.fontBaseUrl) });
    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'init-error', error: toWireError(err) });
  }
}

async function call({ id, method, args }: CallMessage): Promise<void> {
  heapLimitHit = false;
  try {
    if (!native) throw new Error('the engine worker is not started');
    if (!methods.has(method)) throw new Error(`the engine has no method "${method}"`);
    const fn = (native as unknown as Record<EngineMethod, (...a: unknown[]) => unknown>)[method];
    const value: unknown = await fn.apply(native, args);
    post({ id, ok: true, value }, value instanceof ImageBitmap ? [value] : []);
  } catch (err) {
    const fatal = fatalReason(err);
    if (fatal) post({ type: 'fatal', reason: fatal, message: err instanceof Error ? err.message : String(err) });
    else post({ id, ok: false, error: toWireError(err) });
  }
}

function fatalReason(err: unknown): 'crashed' | 'out-of-memory' | null {
  const full = heapLimitHit || (native !== null && native.heapBytes() >= HEAP_LIMIT - HEAP_FULL_MARGIN);
  if (err instanceof WebAssembly.RuntimeError) return full ? 'out-of-memory' : 'crashed';
  // EmbedPDF's MemoryManager throws a plain Error when malloc returns 0 or its 2 GiB budget is used up.
  if (full && err instanceof Error && /Failed to allocate|would exceed limit/.test(err.message)) return 'out-of-memory';
  return null;
}
