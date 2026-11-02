// Reading the page text of restored readings again, in the background, in the offscreen document (S17). A backup never holds page text
// (contracts §5), so a restored reading is not searchable until its text is read from its PDF, as the viewer does when it saves one.
//
// This is the offscreen document's half (started from entrypoints/offscreen/main.ts). It hears requests from pages and the restore worker
// (reindex-protocol.ts), asks the store which readings really need their text (`needsText`), keeps the queue in order, and tells every
// page how far it is ("Indexing 3 of 12"). The reading itself happens in the indexing worker (reindex-worker.ts), which runs the PDF
// engine on threads of its own, so neither this document nor a viewer tab waits for it; the worker is closed when the queue is empty,
// which gives the engine's memory back. The queue is kept in this document's storage, so a round cut short by Chrome closing goes on
// the next time the offscreen document starts.
//
// Rules this file keeps:
// - Only readings the library holds, with a copy kept here and text the owner lets into search (`needsText`; the worker and
//   `putPageText` check again): a reading saved by choice with its text kept out of search (D9) is never read.
// - Running it again changes nothing: a reading whose pages all have their text is not queued.
// - It says nothing in the console about what it reads: no titles, no text, no ids.
import { isSha } from '@sop/core';
import { createStoreClient, type StoreClient } from '../store/client';
import { STORE_PORT, type StorePortMessage } from '../store/transport';
import {
  asReindexMessage,
  type IndexOutcome,
  isWorkerMessage,
  REINDEX_CHANNEL,
  type ReindexMessage,
  type ReindexProgress,
  WORKER_INDEX,
  WORKER_INDEXED,
  WORKER_PORT,
  WORKER_PORT_REQUEST,
} from './reindex-protocol';

/** Where the queue is kept between runs of the offscreen document: fingerprints only. */
const QUEUE_KEY = 'sop-reindex-queue';
/** A queue left by a round that Chrome cut short goes on this long after the offscreen document starts, so a first viewer tab comes first. */
const RESUME_AFTER_MS = 30_000;
/** One reading taking longer than this means the worker is stuck: it is closed and the reading counts as failed. */
const READING_TIMEOUT_MS = 10 * 60_000;
/** The store answers `needsText` for this many ids at a time. */
const ASK_IDS = 10_000;
const STORE_TIMEOUT_MS = 120_000;

function loadQueue(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => isSha(id)) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: readonly string[]): void {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // No storage here: a round cut short is finished by the next restore instead.
  }
}

/** A new port to the store worker, made here (the offscreen document owns the store worker). */
function storePortFrom(storeWorker: Worker): MessagePort {
  const { port1, port2 } = new MessageChannel();
  const toStore: StorePortMessage = { type: STORE_PORT };
  storeWorker.postMessage(toStore, [port2]);
  return port1;
}

export interface ReindexHost {
  stop(): void;
}

export function startReindexHost(storeWorker: Worker): ReindexHost {
  const channel = new BroadcastChannel(REINDEX_CHANNEL);
  /** In order; the head is the reading being read while a worker runs. */
  let queue: string[] = [];
  const progress: ReindexProgress = { active: false, done: 0, total: 0, failed: 0 };
  let worker: Worker | null = null;
  let current: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Requests are filtered one after another, so the queue keeps their order. */
  let intake: Promise<void> = Promise.resolve();
  let stopped = false;

  let store: StoreClient | null = null;
  let stopListening: (() => void) | null = null;
  const storeOf = (): StoreClient => {
    if (store !== null) return store;
    const client = createStoreClient(() => Promise.resolve(storePortFrom(storeWorker)), STORE_TIMEOUT_MS);
    // A reading that leaves the library while it waits (Forget) leaves the queue at once: its fingerprint is not kept here.
    stopListening = client.onChange((c) => {
      if (c.table !== 'documents' || c.op !== 'delete') return;
      const gone = new Set(c.ids);
      const kept = queue.filter((id) => !gone.has(id) || id === current?.id);
      if (kept.length === queue.length) return;
      progress.total -= queue.length - kept.length;
      queue = kept;
      saveQueue(queue);
      announce();
    });
    store = client;
    return client;
  };

  const announce = (): void => {
    const message: ReindexMessage = { type: 'reindex:progress', progress: { ...progress } };
    channel.postMessage(message);
  };

  const closeWorker = (): void => {
    worker?.terminate();
    worker = null;
  };

  function finishOne(id: string, outcome: IndexOutcome): void {
    if (current === null || current.id !== id) return;
    clearTimeout(current.timer);
    current = null;
    queue = queue.filter((q) => q !== id);
    saveQueue(queue);
    progress.done += 1;
    if (outcome === 'failed') progress.failed += 1;
    pump();
  }

  function startWorker(): Worker {
    const w = new Worker(new URL('./reindex-worker.ts', import.meta.url), { type: 'module', name: 'sop-reindex' });
    w.onerror = (e) => {
      console.error('sickofpdfs: the text indexing worker failed', e.message);
      if (worker !== w) return;
      closeWorker();
      if (current !== null) finishOne(current.id, 'failed');
    };
    w.onmessage = (e: MessageEvent) => {
      if (isWorkerMessage(e.data, WORKER_PORT_REQUEST)) w.postMessage({ type: WORKER_PORT }, [storePortFrom(storeWorker)]);
      else if (isWorkerMessage(e.data, WORKER_INDEXED)) {
        const m = e.data as { id?: unknown; outcome?: unknown };
        const outcome: IndexOutcome = m.outcome === 'indexed' || m.outcome === 'skipped' ? m.outcome : 'failed';
        if (typeof m.id === 'string') finishOne(m.id, outcome);
      }
    };
    return w;
  }

  /** Reads the next reading, or, when none is left, closes the worker and says the round is over. */
  function pump(): void {
    if (stopped || current !== null) return;
    const next = queue[0];
    if (next === undefined) {
      closeWorker();
      if (progress.active) {
        progress.active = false;
        announce();
      }
      return;
    }
    progress.active = true;
    announce();
    worker ??= startWorker();
    const w = worker;
    current = {
      id: next,
      timer: setTimeout(() => {
        if (worker === w) closeWorker();
        finishOne(next, 'failed');
      }, READING_TIMEOUT_MS),
    };
    w.postMessage({ type: WORKER_INDEX, id: next });
  }

  /** Adds the readings among `ids` that need their text, in order, to the queue. A new round starts when none is running. */
  const enqueue = (ids: readonly string[]): void => {
    intake = intake.then(async () => {
      if (stopped) return;
      const waiting = new Set(queue);
      const asked = [...new Set(ids)].filter((id) => isSha(id) && !waiting.has(id));
      const needed: string[] = [];
      try {
        for (let at = 0; at < asked.length; at += ASK_IDS) needed.push(...(await storeOf().needsText(asked.slice(at, at + ASK_IDS))));
      } catch {
        return; // the store did not answer: the next restore asks again
      }
      if (needed.length > 0 && !progress.active) {
        progress.done = 0;
        progress.total = 0;
        progress.failed = 0;
      }
      queue.push(...needed);
      progress.total += needed.length;
      saveQueue(queue);
      if (needed.length === 0) announce();
      else pump();
    });
  };

  channel.onmessage = (e: MessageEvent) => {
    const m = asReindexMessage(e.data);
    if (m?.type === 'reindex:request') enqueue(m.ids);
    else if (m?.type === 'reindex:ask') announce();
  };

  // A round that Chrome cut short goes on a little after start-up.
  const left = loadQueue();
  const resume = left.length > 0 ? setTimeout(() => enqueue(left), RESUME_AFTER_MS) : null;

  return {
    stop() {
      stopped = true;
      if (resume !== null) clearTimeout(resume);
      if (current !== null) clearTimeout(current.timer);
      closeWorker();
      channel.close();
      stopListening?.();
      store?.close();
    },
  };
}
