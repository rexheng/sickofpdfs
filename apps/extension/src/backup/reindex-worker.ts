// The indexing worker: a module worker the offscreen document starts while restored readings wait for their page text (reindex.ts), and
// closes when none is left. It opens each reading's saved copy with the PDF engine (which runs in workers of its own) and writes its
// page text, as the viewer does when it saves a PDF. A worker has no `chrome.*`: the port to the store worker comes from the offscreen
// document, and the engine's files are this worker's own origin.
import { type DocumentId, isSha } from '@sop/core';
import { createEmbedPdfBackend, ENGINE_WORKERS, engineAssets, MAX_OPEN_BYTES, type PdfBackend } from '@sop/viewer';
import { type BlobStore, openBlobStore } from '../store/blob-store';
import { createStoreClient } from '../store/client';
import type { StoreApi } from '../store/store-api';
import { type IndexOutcome, isWorkerMessage, WORKER_INDEX, WORKER_INDEXED, WORKER_PORT, WORKER_PORT_REQUEST } from './reindex-protocol';

/** The pages written to the store at a time (as the viewer's save does). */
export const TEXT_BATCH = 50;
const STORE_TIMEOUT_MS = 120_000;

export interface IndexDeps {
  store: Pick<StoreApi, 'getDocument' | 'putPageText'>;
  blobs: BlobStore;
  /** The PDF engine, made on first use. */
  engine(): PdfBackend;
}

/** Reads one reading's page text from its saved copy and stores it. Never throws: a reading that cannot be read is `failed`. */
export async function indexReading(id: DocumentId, deps: IndexDeps): Promise<IndexOutcome> {
  try {
    const doc = await deps.store.getDocument(id);
    if (doc === null || !doc.blobStored || !doc.hasText || !doc.indexText) return 'skipped';
    const file = await deps.blobs.get(id);
    if (file === null || file.size > MAX_OPEN_BYTES) return 'failed';
    const engine = deps.engine();
    const opened = await engine.open(await file.arrayBuffer());
    try {
      // The library's page count is the one its rows were made for; the store refuses a page past it.
      const pages = Math.min(opened.pageCount, doc.pageCount);
      for (let at = 0; at < pages; at += TEXT_BATCH) {
        const batch: { pageIndex: number; text: string }[] = [];
        for (let i = at; i < Math.min(pages, at + TEXT_BATCH); i++) batch.push({ pageIndex: i, text: await engine.getPageText(opened.doc, i) });
        await deps.store.putPageText(id, batch);
      }
    } finally {
      await engine.close(opened.doc).catch(() => {});
    }
    return 'indexed';
  } catch {
    return 'failed'; // a password, a damaged file, the engine stopped, or the reading left the library meanwhile
  }
}

const waiting: ((port: MessagePort) => void)[] = [];
const store = createStoreClient(
  () =>
    new Promise<MessagePort>((resolve) => {
      waiting.push(resolve);
      self.postMessage({ type: WORKER_PORT_REQUEST });
    }),
  STORE_TIMEOUT_MS,
);
let blobs: Promise<BlobStore> | null = null;
let engine: PdfBackend | null = null;
const deps = (b: BlobStore): IndexDeps => ({
  store,
  blobs: b,
  engine: () => (engine ??= createEmbedPdfBackend(engineAssets((p) => new URL(p, self.location.origin).href), { workers: ENGINE_WORKERS })),
});

/** One reading at a time, in the order asked. */
let turn: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (isWorkerMessage(e.data, WORKER_PORT) && port) {
    waiting.shift()?.(port);
    return;
  }
  if (!isWorkerMessage(e.data, WORKER_INDEX)) return;
  const id = (e.data as { id?: unknown }).id;
  if (!isSha(id)) return;
  turn = turn.then(async () => {
    let outcome: IndexOutcome = 'failed';
    try {
      blobs ??= openBlobStore();
      outcome = await indexReading(id, deps(await blobs));
    } catch {
      blobs = null; // the file storage could not be opened: tried again for the next reading
    }
    self.postMessage({ type: WORKER_INDEXED, id, outcome });
  });
};
