// The background OCR of saved readings, the offscreen page's half (started from entrypoints/offscreen/main.ts). A viewer tab
// that opens a saved scan asks for it on the OCR channel (progress.ts: 'ocr:start'); this keeps the queue of readings (their
// fingerprints only, in this document's storage, so a round cut short by Chrome closing goes on the next time the offscreen
// document starts) and runs the OCR worker (bg-worker.ts), which reads the pages with an engine of its own over the saved copy,
// writes each page to the library, and tells every tab how far it is. So closing the tab does not stop the reading.
// The worker is ended when no reading is left, which gives the PDF engine's and the recogniser's memory back.
//
// It says nothing in the console about what it reads: no titles, no text, no ids.
import { type DocumentId, isSha } from '@sop/core';
import { STORE_PORT, type StorePortMessage } from '../store/transport';
import { isWorkerMessage, WORKER_FINISHED, WORKER_IDLE, WORKER_JOB, WORKER_PORT, WORKER_PORT_REQUEST } from './host-protocol';
import { asOcrMessage, OCR_CHANNEL, type OcrHint } from './progress';

/** Where the queue is kept between runs of the offscreen document: fingerprints only. */
const QUEUE_KEY = 'sop-ocr-queue';
/** A queue left by a round that Chrome cut short goes on this long after the offscreen document starts, so a first viewer tab comes first. */
const RESUME_AFTER_MS = 30_000;

function loadQueue(): DocumentId[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is DocumentId => isSha(id)) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: readonly DocumentId[]): void {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // No storage here: the next time the reading is opened asks again.
  }
}

export interface OcrHost {
  stop(): void;
}

export function startOcrHost(storeWorker: Worker): OcrHost {
  const channel = new BroadcastChannel(OCR_CHANNEL);
  let queue = loadQueue();
  let worker: Worker | null = null;
  let stopped = false;

  const storePort = (): MessagePort => {
    const { port1, port2 } = new MessageChannel();
    const toStore: StorePortMessage = { type: STORE_PORT };
    storeWorker.postMessage(toStore, [port2]);
    return port1;
  };

  const startWorker = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL('./bg-worker.ts', import.meta.url), { type: 'module', name: 'sop-ocr-background' });
    w.onerror = (e) => {
      console.error('sickofpdfs: the text recognition worker failed', e.message);
      if (worker === w) {
        w.terminate();
        worker = null;
      }
    };
    w.onmessage = (e: MessageEvent) => {
      if (isWorkerMessage(e.data, WORKER_PORT_REQUEST)) w.postMessage({ type: WORKER_PORT }, [storePort()]);
      else if (isWorkerMessage(e.data, WORKER_FINISHED)) {
        const id = (e.data as { documentId?: unknown }).documentId;
        queue = queue.filter((q) => q !== id);
        saveQueue(queue);
      } else if (isWorkerMessage(e.data, WORKER_IDLE)) {
        if (worker !== w || queue.length > 0) return;
        w.terminate();
        worker = null;
      }
    };
    worker = w;
    return w;
  };

  const run = (documentId: DocumentId, hint: OcrHint): void => {
    if (stopped) return;
    if (!queue.includes(documentId)) {
      queue.push(documentId);
      saveQueue(queue);
    }
    startWorker().postMessage({ type: WORKER_JOB, documentId, ...hint });
  };

  channel.onmessage = (e: MessageEvent) => {
    const m = asOcrMessage(e.data);
    if (m?.type === 'ocr:start') run(m.documentId, { visible: m.visible, direction: m.direction });
  };

  const left = queue;
  const resume = left.length > 0 ? setTimeout(() => left.forEach((id) => run(id, { visible: [], direction: 1 })), RESUME_AFTER_MS) : null;

  return {
    stop() {
      stopped = true;
      if (resume !== null) clearTimeout(resume);
      worker?.terminate();
      worker = null;
      channel.close();
    },
  };
}
