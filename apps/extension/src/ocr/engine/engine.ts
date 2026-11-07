// createOcrEngine (contracts §9 / Phase 7–8 plan §9): the text recogniser for scanned pages, as the OCR service sees it. It runs
// in a worker of its own (ocr.worker.ts), so neither a viewer tab nor the offscreen page waits for it, and it turns the worker's
// words (pixels of the page as displayed) into points of the unrotated page, the space every PdfRect is in.
//
// No network: `assets.base` must be this extension's own folder (chrome.runtime.getURL('')), and the worker checks it again.
import type { OcrEngine, OcrWord } from '@sop/core';
import type { PageSize, PdfRect } from '@sop/viewer';
import { OCR_ENGINE_ID, OCR_ENGINE_VERSION } from './models';
import type { PxWord } from './ppocr';

export interface OcrAssets {
  /** The extension's root folder, ending in '/': chrome.runtime.getURL(''), or a worker's own origin + '/'. */
  base: string;
  /** For tests and the offscreen page: how to start the worker. */
  createWorker?: () => Worker;
}

/** Times of the last page, in ms (det, crops, rec, words, load, total): the speed checks read them. */
export interface OcrTimings {
  [stage: string]: number;
}

export interface OcrEngineImpl extends OcrEngine {
  lastTimings(): OcrTimings;
}

/** A box in pixels of the page as displayed → points of the unrotated page. */
export function displayedPxToPage(b: PdfRect, page: PageSize, dpi: number): PdfRect {
  const k = 72 / dpi;
  const { width: W, height: H, rotation } = page;
  const corner = (dx: number, dy: number): [number, number] => {
    switch (rotation) {
      case 90:
        return [dy, H - dx];
      case 180:
        return [W - dx, H - dy];
      case 270:
        return [W - dy, dx];
      default:
        return [dx, dy];
    }
  };
  const [ax, ay] = corner(b.x * k, b.y * k);
  const [bx, by] = corner((b.x + b.width) * k, (b.y + b.height) * k);
  const x = Math.max(0, Math.min(ax, bx));
  const y = Math.max(0, Math.min(ay, by));
  return { x, y, width: Math.min(W, Math.max(ax, bx)) - x, height: Math.min(H, Math.max(ay, by)) - y };
}

export function createOcrEngine(assets: OcrAssets): OcrEngineImpl {
  let worker: Worker | null = null;
  let nextId = 1;
  let timings: OcrTimings = {};
  const waiting = new Map<number, { resolve: (w: PxWord[]) => void; reject: (e: Error) => void }>();

  const start = (): Worker => {
    if (worker) return worker;
    const w = assets.createWorker?.() ?? new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module', name: 'sop-ocr' });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; ok: boolean; words?: PxWord[]; ms?: OcrTimings; error?: string; stopped?: boolean };
      const job = waiting.get(m.id);
      if (!job) return;
      waiting.delete(m.id);
      if (m.ok && m.words) {
        timings = m.ms ?? {};
        job.resolve(m.words);
      } else job.reject(m.stopped ? new DOMException('The page was stopped.', 'AbortError') : new Error(`ocr: ${m.error ?? 'the engine failed'}`));
    };
    w.onerror = (e) => {
      // The worker died (out of memory, a crash): every page waiting fails, and the next page starts a new worker.
      e.preventDefault();
      for (const job of waiting.values()) job.reject(new Error('ocr: the engine stopped'));
      waiting.clear();
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  };

  return {
    id: OCR_ENGINE_ID,
    version: OCR_ENGINE_VERSION,
    lastTimings: () => timings,
    recognize(img, o) {
      if (o.signal?.aborted) {
        img.close();
        return Promise.reject(new DOMException('The page was stopped.', 'AbortError'));
      }
      const id = nextId++;
      const w = start();
      return new Promise<OcrWord[]>((resolve, reject) => {
        const onAbort = () => w.postMessage({ id, cmd: 'stop' });
        o.signal?.addEventListener('abort', onAbort, { once: true });
        waiting.set(id, {
          resolve: (px) => {
            o.signal?.removeEventListener('abort', onAbort);
            resolve(px.map((p) => ({ text: p.text, box: displayedPxToPage(p.box, o.pageSize, o.dpi), confidence: p.confidence, line: p.line, block: p.block })));
          },
          reject: (e) => {
            o.signal?.removeEventListener('abort', onAbort);
            reject(e);
          },
        });
        w.postMessage({ id, cmd: 'recognize', bitmap: img, base: assets.base }, [img]);
      });
    },
    dispose() {
      for (const job of waiting.values()) job.reject(new DOMException('The engine was closed.', 'AbortError'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    },
  };
}
