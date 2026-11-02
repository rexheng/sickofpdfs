// LibraryData over the real store: the contract §5 library methods (S9), the blob store's saved copies, and Upload PDF.
// This is the only data the production library reads; the in-memory fake (fake.ts) exists in test builds only.
import type { DocumentId } from '@sop/core';
import { createEmbedPdfBackend, ENGINE_WORKERS, engineAssets, type PdfBackend } from '@sop/viewer';
import type { BlobStore } from '../../store/blob-store';
import type { StoreChange } from '../../store/change-bus';
import type { StoreClient } from '../../store/client';
import type { LibraryData } from './types';
import { savePickedPdf } from './upload';

/** Store changes that can change a library page: a reading, its place, its history, or its note count. */
const SHOWN_TABLES: ReadonlySet<StoreChange['table']> = new Set(['documents', 'aliases', 'locations', 'history', 'threads', 'comments']);

/** The library pages' data from the store. */
export function createStoreLibraryData(client: StoreClient, blobs: BlobStore | null): LibraryData {
  let engine: PdfBackend | null = null;
  // Uploads go one at a time, through one engine worker of this page's own, made on the first upload.
  let uploads: Promise<unknown> = Promise.resolve();
  const backend = (): PdfBackend => (engine ??= createEmbedPdfBackend(engineAssets((p) => chrome.runtime.getURL(p)), { workers: ENGINE_WORKERS }));
  return {
    listDocuments: (q) => client.listDocuments(q),
    setStarred: (id, on) => client.setStarred(id, on),
    trashDocument: (id) => client.trashDocument(id),
    restoreDocument: (id) => client.restoreDocument(id),
    setTitle: (id, title) => client.setTitle(id, title),
    savePickedPdf(file) {
      const next = uploads.then(() => savePickedPdf(file, { store: client, blobs, backend, now: () => Date.now() }));
      uploads = next.catch(() => undefined);
      return next;
    },
    async savedPdf(id) {
      if (blobs === null) return null;
      const doc = await client.getDocument(id);
      if (doc === null || !doc.blobStored) return null;
      return blobs.get(id);
    },
    async hasDocument(id) {
      return (await client.getDocument(id)) !== null;
    },
    onChange(cb) {
      return client.onChange((c) => {
        if (!SHOWN_TABLES.has(c.table)) return;
        cb({ forgotten: c.table === 'documents' && c.op === 'delete' ? (c.ids as DocumentId[]) : [] });
      });
    },
    palette: client,
  };
}
