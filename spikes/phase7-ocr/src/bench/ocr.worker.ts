// Module worker that hosts the PP-OCR pipeline (what apps/extension/src/ocr/engine/ocr.worker.ts will be). It is started by
// the bench page; onnxruntime-web is imported from the extension's own files, never from a URL on the network.
import { PpOcr } from '../ocr/ppocr.ts';
import type { RgbaImage } from '../ocr/types.ts';
import type { PpocrConfig } from './config.ts';

let engine: PpOcr | null = null;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function probe() {
  const nav = self.navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: Record<string, unknown>; features?: Set<string>; limits?: Record<string, number> } | null> } };
  let adapter: Record<string, unknown> | null = null;
  let gpuError: string | null = null;
  if (nav.gpu) {
    try {
      const a = await nav.gpu.requestAdapter();
      adapter = a ? { info: a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description } : null, maxBufferSize: a.limits?.maxBufferSize } : null;
    } catch (e) {
      gpuError = String(e);
    }
  }
  return {
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    navigatorGpu: !!nav.gpu,
    adapter,
    gpuError,
    hardwareConcurrency: self.navigator.hardwareConcurrency,
    location: self.location.protocol + '//' + self.location.host,
    perfMemory: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  };
}

self.onmessage = async (e: MessageEvent) => {
  const { id, cmd } = e.data as { id: number; cmd: string };
  try {
    if (cmd === 'probe') {
      self.postMessage({ id, ok: true, result: await probe() });
    } else if (cmd === 'init') {
      const { cfg, base } = e.data as { cfg: PpocrConfig; base: string };
      const t0 = performance.now();
      const ortUrl = `${base}ort/${cfg.backend === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`;
      const ort = await import(/* @vite-ignore */ ortUrl);
      ort.env.logLevel = 'error'; // the models make ORT warn about unused initialisers on every load
      ort.env.wasm.wasmPaths = `${base}ort/`;
      ort.env.wasm.numThreads = cfg.threads;
      const t1 = performance.now();
      const dir = (n: string) => `${base}models/ppocr/${n}/`;
      const [detModel, recModel, detYml, recYml] = await Promise.all([
        fetchBytes(`${dir(cfg.det)}inference.onnx`),
        fetchBytes(`${dir(cfg.rec)}inference.onnx`),
        fetchText(`${dir(cfg.det)}inference.yml`),
        fetchText(`${dir(cfg.rec)}inference.yml`),
      ]);
      const t2 = performance.now();
      engine = new PpOcr({ id: cfg.id, ort, detModel, recModel, detYml, recYml, backend: cfg.backend, detMaxSide: cfg.detMaxSide, recBatch: cfg.recBatch, widthBucket: cfg.widthBucket });
      await engine.init();
      const t3 = performance.now();
      self.postMessage({
        id,
        ok: true,
        result: { facts: engine.info(), ms: { importOrt: t1 - t0, fetchModels: t2 - t1, createSessions: t3 - t2, total: t3 - t0 }, modelBytes: { det: detModel.length, rec: recModel.length }, probe: await probe(), ortVersion: ort.env?.versions?.common ?? null },
      });
    } else if (cmd === 'recognize') {
      const { buffer, width, height } = e.data as { buffer: ArrayBuffer; width: number; height: number };
      const image: RgbaImage = { data: new Uint8ClampedArray(buffer), width, height };
      const t0 = performance.now();
      const words = await engine!.recognize(image);
      self.postMessage({ id, ok: true, result: { words, timings: engine!.lastTimings(), wallMs: performance.now() - t0, perfMemory: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null } });
    } else if (cmd === 'dispose') {
      await engine?.dispose();
      engine = null;
      self.postMessage({ id, ok: true, result: null });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
