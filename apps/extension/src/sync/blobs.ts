// The engine's PDF copies in the extension (CL11): the private file storage (OPFS, store/blob-store.ts). A downloaded PDF is
// hashed as it is written, and kept only when its SHA-256 is its fingerprint (contracts §7: every device re-hashes downloads).
import type { EngineFiles } from '@sop/core/sync-client';
import type { Sha256 } from '@sop/core/ids';
import { BlobHashMismatchError, type BlobStore, openBlobStore } from '../store/blob-store';

export function extensionFiles(): EngineFiles {
  let store: Promise<BlobStore> | null = null;
  const blobs = () => (store ??= openBlobStore());
  return {
    get: async (sha) => (await blobs()).get(sha as Sha256),
    put: async (sha, body) => {
      try {
        await (await blobs()).put(body, sha as Sha256);
        return 'ok';
      } catch (e) {
        if (e instanceof BlobHashMismatchError) return 'mismatch';
        throw e;
      }
    },
  };
}
