// The layout detector (Phase 7.4, plan §4): the boxes of a scanned page, found by the layout model in a worker of its own
// (layout.worker.ts). to-figures.ts turns them into the viewer's figures. The page image is drawn small, read once and
// closed; nothing is stored, posted or logged here: the caller keeps the result in memory (or not at all).
//
// No network: `base` is this extension's own folder (chrome.runtime.getURL('')), and the worker checks it again.
import type { LayoutBox } from './models';

export interface LayoutDetector {
  /** The boxes of the page image in its own px. The bitmap is taken (closed). */
  detect(img: ImageBitmap): Promise<LayoutBox[]>;
  dispose(): void;
}

export function createLayoutDetector(assets: { base: string; createWorker?: () => Worker }): LayoutDetector {
  let worker: Worker | null = null;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (b: LayoutBox[]) => void; reject: (e: Error) => void }>();
  const start = (): Worker => {
    if (worker) return worker;
    const w = assets.createWorker?.() ?? new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'sop-layout' });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; ok: boolean; boxes?: LayoutBox[]; error?: string };
      const job = waiting.get(m.id);
      if (!job) return;
      waiting.delete(m.id);
      if (m.ok && m.boxes) job.resolve(m.boxes);
      else job.reject(new Error(`layout: ${m.error ?? 'the model failed'}`));
    };
    w.onerror = (e) => {
      e.preventDefault();
      for (const job of waiting.values()) job.reject(new Error('layout: the model stopped'));
      waiting.clear();
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  };
  return {
    detect(img) {
      const id = nextId++;
      const w = start();
      return new Promise<LayoutBox[]>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, cmd: 'detect', bitmap: img, base: assets.base }, [img]);
      });
    },
    dispose() {
      for (const job of waiting.values()) job.reject(new DOMException('The detector was closed.', 'AbortError'));
      waiting.clear();
      worker?.terminate();
      worker = null;
    },
  };
}
