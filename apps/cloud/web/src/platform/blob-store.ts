// The web's version of apps/extension/src/store/blob-store.ts (swapped in by vite.config.ts). The web library keeps no PDF files
// on this computer: a reading's saved copy is in the owner's cloud. So this store is always empty, and a write is refused.
import type { BlobStore } from '@ext/store/blob-store';

export { BLOB_CHUNK_BYTES, BlobHashMismatchError, blobPath, type BlobStore } from '@ext/store/blob-store';

const EMPTY: BlobStore = {
  put: () => Promise.reject(new Error('read-only: the web library keeps no PDF files on this computer')),
  get: () => Promise.resolve(null),
  has: () => Promise.resolve(false),
  delete: () => Promise.resolve(),
};

export function openBlobStore(): Promise<BlobStore> {
  return Promise.resolve(EMPTY);
}
