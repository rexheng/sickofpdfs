/// <reference lib="webworker" />
// Our own engine worker, loaded from a chrome-extension:// file URL (not a blob: URL).
//   ← {type:'init', wasmUrl, fontBaseUrl}   → {type:'ready'} | {type:'init-error', error}
//   ← {id, method, args}                    → {id, ok:true, value} | {id, ok:false, error}
// `method` is any SpikeNative method. A PdfTask result is awaited; an RGBA result (renderRaw) is
// returned as an ImageBitmap, transferred. CSP violations inside the worker are forwarded as
// {type:'csp', violation}, because they never reach the page's document.
import { init } from '@embedpdf/pdfium';
import { bundledFontFallback } from './fonts';
import { SpikeNative } from './spike-native';

declare const self: DedicatedWorkerGlobalScope;

type InitMessage = { type: 'init'; wasmUrl: string; fontBaseUrl: string };
type CallMessage = { id: number; method: string; args: unknown[] };

let native: SpikeNative | null = null;

// The message handler is async, so anything it throws becomes an unhandled rejection, which never
// reaches the page and may leave a call unanswered. Report it as an uncaught error instead: the
// page's EngineWorker then fails every pending call.
self.addEventListener('unhandledrejection', (event) => self.reportError(event.reason));

self.addEventListener('securitypolicyviolation', (event) => {
  const e = event as SecurityPolicyViolationEvent;
  self.postMessage({ type: 'csp', violation: `${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'}` });
});

self.onmessage = async (event: MessageEvent<InitMessage | CallMessage>) => {
  const msg = event.data;
  if ('type' in msg) {
    try {
      const wasmBinary = await (await fetch(msg.wasmUrl)).arrayBuffer();
      native = new SpikeNative(await init({ wasmBinary }), { fontFallback: bundledFontFallback(msg.fontBaseUrl) });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'init-error', error: describe(err) });
    }
    return;
  }

  const { id, method, args } = msg;
  try {
    if (!native) throw new Error('engine worker is not initialised');
    const fn = (native as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') throw new Error(`SpikeNative has no method "${method}"`);
    let value: unknown = fn.apply(native, args);
    if (isTask(value)) value = await value.toPromise();
    else value = await value;
    if (isImageDataLike(value)) {
      const bitmap = await createImageBitmap(new ImageData(value.data, value.width, value.height));
      self.postMessage({ id, ok: true, value: bitmap }, [bitmap]);
      return;
    }
    self.postMessage({ id, ok: true, value });
  } catch (err) {
    self.postMessage({ id, ok: false, error: describe(err) });
  }
};

function isTask(v: unknown): v is { toPromise(): Promise<unknown> } {
  return !!v && typeof (v as { toPromise?: unknown }).toPromise === 'function';
}

function isImageDataLike(v: unknown): v is { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  return !!v && (v as { data?: unknown }).data instanceof Uint8ClampedArray && typeof (v as { width?: unknown }).width === 'number';
}

// TaskRejectedError carries PDFium's {code, message} in `reason`.
function describe(err: unknown): string {
  const reason = (err as { reason?: unknown })?.reason;
  if (reason) return JSON.stringify(reason);
  return err instanceof Error ? err.message : String(err);
}
