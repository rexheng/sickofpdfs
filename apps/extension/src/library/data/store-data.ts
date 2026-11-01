// LibraryData over the real store: the contract §5 methods that S9 adds to the store, and the blob store's saved copies.
import type { DocumentId } from '@sop/core';
import type { BlobStore } from '../../store/blob-store';
import type { StoreChange } from '../../store/change-bus';
import type { StoreClient } from '../../store/client';
import type { LibraryData, LibraryPage, LibraryQuery } from './types';

/** The store methods the library pages need (contract §5; S9 adds them to StoreApi). */
interface LibraryStoreMethods {
  listDocuments(q: LibraryQuery): Promise<LibraryPage>;
  setStarred(documentId: DocumentId, on: boolean): Promise<void>;
  trashDocument(documentId: DocumentId): Promise<void>;
  restoreDocument(documentId: DocumentId): Promise<void>;
  /** Not in contract §5 (see LibraryData.setTitle). */
  setTitle(documentId: DocumentId, title: string): Promise<void>;
}

/** Store changes that can change a library page: a reading, its place, its history, or its note count. */
const SHOWN_TABLES: ReadonlySet<StoreChange['table']> = new Set(['documents', 'aliases', 'locations', 'history', 'threads', 'comments']);

/**
 * The library pages' data from the store, or null when this store cannot list the library yet (S9's methods are
 * missing), so the page can say so instead of showing an empty library.
 */
export function createStoreLibraryData(client: StoreClient, blobs: BlobStore | null): LibraryData | null {
  const store = client as StoreClient & Partial<LibraryStoreMethods>;
  const { listDocuments, setStarred, trashDocument, restoreDocument, setTitle } = store;
  if (listDocuments === undefined || setStarred === undefined || trashDocument === undefined || restoreDocument === undefined) return null;
  return {
    listDocuments: (q) => listDocuments.call(store, q),
    setStarred: (id, on) => setStarred.call(store, id, on),
    trashDocument: (id) => trashDocument.call(store, id),
    restoreDocument: (id) => restoreDocument.call(store, id),
    setTitle: setTitle === undefined ? null : (id, title) => setTitle.call(store, id, title),
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
  };
}
