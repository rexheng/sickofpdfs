// The background OCR worker: a module worker the offscreen page starts while saved readings wait for their scanned pages to be
// read (host.ts), and ends when none is left. It opens each reading's saved copy with a PDF engine of its own, runs the OCR
// service with `persist: true` (each page is written to the library as soon as it is read, with its page text), listens on the
// OCR channel for the pages a tab has on screen, and tells every tab how far it is. A worker has no `chrome.*`: the port to the
// store worker comes from the offscreen document, and the engine's and the models' files are this worker's own origin.
//
// Only readings the library holds, with a saved copy here, are read, and only while "Read text in scanned pages" (ocr.enabled)
// is on. Nothing is sent anywhere: the recogniser and the PDF engine run here, from the extension's own files.
import { type DocumentId, isSha } from '@sop/core';
import { createEmbedPdfBackend, type DocHandle, engineAssets, MAX_OPEN_BYTES, type PdfBackend } from '@sop/viewer';
import { type BlobStore, openBlobStore } from '../store/blob-store';
import { createStoreClient } from '../store/client';
import { createOcrEngine } from './engine/engine';
import { OCR_LANGS } from './engine/models';
import { isWorkerMessage, WORKER_FINISHED, WORKER_IDLE, WORKER_JOB, WORKER_PORT, WORKER_PORT_REQUEST } from './host-protocol';
import { createPageSource } from './page-source';
import { asOcrMessage, OCR_CHANNEL, type OcrHint, type OcrMessage } from './progress';
import { createOcrService } from './service';

const STORE_TIMEOUT_MS = 120_000;

const waiting: ((port: MessagePort) => void)[] = [];
const store = createStoreClient(
  () =>
    new Promise<MessagePort>((resolve) => {
      waiting.push(resolve);
      self.postMessage({ type: WORKER_PORT_REQUEST });
    }),
  STORE_TIMEOUT_MS,
);
const origin = `${self.location.origin}/`;
let backend: PdfBackend | null = null;
let blobs: Promise<BlobStore> | null = null;
const service = createOcrService({ engine: () => createOcrEngine({ base: origin }), store, now: () => Date.now() });
const channel = new BroadcastChannel(OCR_CHANNEL);
/** The readings open here: their engine handle. */
const open = new Map<DocumentId, DocHandle | null>();

function finish(id: DocumentId): void {
  if (!open.has(id)) return;
  const doc = open.get(id) ?? null;
  open.delete(id);
  service.stop(id);
  if (doc !== null) void backend?.close(doc).catch(() => {});
  self.postMessage({ type: WORKER_FINISHED, documentId: id });
  if (open.size === 0) self.postMessage({ type: WORKER_IDLE });
}

service.onProgress((p) => {
  channel.postMessage({ type: 'ocr:progress', progress: p } satisfies OcrMessage);
  if (p.state === 'done' || p.state === 'error') finish(p.documentId);
});

async function startJob(id: DocumentId, hint: OcrHint): Promise<void> {
  if (open.has(id)) {
    service.hint(id, hint);
    return;
  }
  open.set(id, null);
  try {
    if ((await store.getSetting('ocr.enabled')) === false) return finish(id);
    const row = await store.getDocument(id);
    if (row === null || !row.blobStored) return finish(id);
    blobs ??= openBlobStore();
    const file = await (await blobs).get(id);
    if (file === null || file.size > MAX_OPEN_BYTES) return finish(id);
    backend ??= createEmbedPdfBackend(
      engineAssets((p) => new URL(p, origin).href),
      { workers: 1 },
    );
    const opened = await backend.open(await file.arrayBuffer());
    if (!open.has(id)) {
      await backend.close(opened.doc).catch(() => {}); // forgotten meanwhile
      return;
    }
    open.set(id, opened.doc);
    // The library's page count is the one its rows were made for; the store refuses a page past it.
    const pages = opened.pages.slice(0, Math.min(opened.pageCount, row.pageCount));
    await service.start({ documentId: id, source: createPageSource(backend, opened.doc, pages), persist: true, langs: OCR_LANGS });
    service.hint(id, hint);
  } catch {
    blobs = null; // a password, a damaged file, or the file storage could not be opened: tried again the next time it is asked for
    finish(id);
  }
}

// A reading that leaves the library (Forget, the Trash purge) is stopped at once.
store.onChange((c) => {
  if (c.table !== 'documents' || c.op !== 'delete') return;
  for (const id of c.ids) if (isSha(id)) finish(id);
});

channel.onmessage = (e: MessageEvent) => {
  const m = asOcrMessage(e.data);
  if (m === null || m.type === 'ocr:start' || m.type === 'ocr:progress') return; // starts come through the host
  if (m.type === 'ocr:hint') service.hint(m.documentId, { visible: m.visible, direction: m.direction });
  else if (m.type === 'ocr:pause') service.pause(m.documentId);
  else if (m.type === 'ocr:resume') service.resume(m.documentId);
  else if (m.type === 'ocr:ask') {
    const p = service.progress(m.documentId);
    if (p !== null) channel.postMessage({ type: 'ocr:progress', progress: p } satisfies OcrMessage);
  }
};

self.onmessage = (e: MessageEvent) => {
  const port = e.ports[0];
  if (isWorkerMessage(e.data, WORKER_PORT) && port) {
    waiting.shift()?.(port);
    return;
  }
  if (!isWorkerMessage(e.data, WORKER_JOB)) return;
  const m = e.data as { documentId?: unknown; visible?: unknown; direction?: unknown };
  if (!isSha(m.documentId)) return;
  const visible = Array.isArray(m.visible) ? m.visible.filter((i): i is number => Number.isSafeInteger(i) && i >= 0).slice(0, 16) : [];
  void startJob(m.documentId, { visible, direction: m.direction === -1 ? -1 : 1 });
};
