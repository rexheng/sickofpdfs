// The offscreen document (plan 7.0 "extension checks"): starts the OCR worker from here, runs one tiny recognition, and reports
// what the worker could see (cross-origin isolation, navigator.gpu).
import type { PpocrConfig } from './config.ts';

const base = chrome.runtime.getURL('');

async function selfcheck() {
  const worker = new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module', name: 'sop-ocr' });
  let n = 0;
  const pending = new Map<number, (v: any) => void>();
  worker.onmessage = (e) => pending.get(e.data.id)?.(e.data);
  const call = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<any>((resolve) => {
      const id = ++n;
      pending.set(id, resolve);
      worker.postMessage({ id, ...msg }, transfer);
    });
  const out: Record<string, unknown> = { offscreen: { crossOriginIsolated, navigatorGpu: 'gpu' in navigator, location: location.protocol + '//' + location.host } };
  out.workerProbe = (await call({ cmd: 'probe' })).result;
  const cfg: PpocrConfig = { kind: 'ppocr', id: 'offscreen-check', det: 'PP-OCRv6_tiny_det', rec: 'PP-OCRv6_tiny_rec', backend: 'wasm', threads: 2, detMaxSide: 640 };
  const init = await call({ cmd: 'init', cfg, base });
  out.init = init.ok ? { ms: init.result.ms, facts: init.result.facts } : { error: init.error };
  if (init.ok) {
    // a synthetic page: serif text on white is enough to prove the worker runs end to end
    const w = 640;
    const h = 240;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#000';
    g.font = '28px serif';
    g.fillText('Offscreen document check: the quick brown fox', 20, 80);
    g.fillText('jumps over the lazy dog 0123456789', 20, 140);
    const d = g.getImageData(0, 0, w, h);
    const r = await call({ cmd: 'recognize', buffer: d.data.buffer, width: w, height: h }, [d.data.buffer]);
    out.recognize = r.ok ? { text: r.result.words.map((x: { text: string }) => x.text).join(' '), wallMs: r.result.wallMs } : { error: r.error };
  }
  worker.terminate();
  return out;
}

selfcheck()
  .then((result) => chrome.runtime.sendMessage({ cmd: 'selfcheck-result', result }))
  .catch((e) => chrome.runtime.sendMessage({ cmd: 'selfcheck-result', result: { error: String(e) } }));
