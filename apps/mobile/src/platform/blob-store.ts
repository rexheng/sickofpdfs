// The app's version of apps/extension/src/store/blob-store.ts (swapped in by vite.config.ts): the copies of saved PDFs.
//
// Where the WebView can write OPFS files (createWritable and move, as Chrome can), new copies go there, through the extension's
// own blob store, unchanged. On a WebView that cannot, they go to IndexedDB instead (`pdf:<sha256>` in the app's `sop-mobile`
// database). Reading and removing always look in both places, so a copy is found wherever it was put, and a forgotten reading
// leaves nothing behind in either.
import { createSha256 } from '@sop/core/fingerprint';
import type { Sha256 } from '@sop/core/ids';
import { BlobHashMismatchError, type BlobStore, openBlobStore as openOpfsBlobStore } from '@ext/store/blob-store';
import { idbDelete, idbGet, idbHas, idbPut } from './idb';

export { BLOB_CHUNK_BYTES, BlobHashMismatchError, blobPath, type BlobStore } from '@ext/store/blob-store';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const keyOf = (sha256: Sha256): string => {
  if (!SHA256_PATTERN.test(sha256)) throw new TypeError('A SHA-256 is 64 lower-case hex characters.');
  return `pdf:${sha256}`;
};

/** Can this WebView write OPFS files the way the extension's blob store does? */
export function canWriteOpfsFiles(): boolean {
  if (typeof navigator.storage?.getDirectory !== 'function' || typeof FileSystemFileHandle === 'undefined') return false;
  const proto = FileSystemFileHandle.prototype as { createWritable?: unknown; move?: unknown };
  return typeof proto.createWritable === 'function' && typeof proto.move === 'function';
}

async function* chunksOf(data: Blob | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = (data instanceof Blob ? data.stream() : data).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** The fallback: whole PDFs as Blobs in IndexedDB (Chrome keeps large Blobs as files on disk). */
function idbBlobStore(): BlobStore {
  return {
    async put(data, expected) {
      if (expected !== undefined) keyOf(expected);
      const hasher = await createSha256();
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      for await (const chunk of chunksOf(data)) {
        hasher.update(chunk);
        parts.push(chunk as Uint8Array<ArrayBuffer>);
        size += chunk.byteLength;
      }
      const sha256 = hasher.digest();
      if (expected !== undefined && expected !== sha256) throw new BlobHashMismatchError(expected, sha256);
      if (await idbHas(keyOf(sha256))) return { sha256, size, created: false };
      await idbPut(keyOf(sha256), new Blob(parts, { type: 'application/pdf' }));
      return { sha256, size, created: true };
    },
    async get(sha256) {
      const blob = await idbGet<Blob>(keyOf(sha256));
      return blob instanceof Blob ? new File([blob], `${sha256}.pdf`, { type: 'application/pdf' }) : null;
    },
    has: (sha256) => idbHas(keyOf(sha256)),
    delete: (sha256) => idbDelete(keyOf(sha256)),
  };
}

export async function openBlobStore(): Promise<BlobStore> {
  const fallback = idbBlobStore();
  const opfs = canWriteOpfsFiles() ? await openOpfsBlobStore().catch(() => null) : null;
  if (opfs === null) return fallback;
  return {
    put: (data, expected) => opfs.put(data, expected),
    async get(sha256) {
      return (await opfs.get(sha256)) ?? (await fallback.get(sha256).catch(() => null));
    },
    async has(sha256) {
      return (await opfs.has(sha256)) || (await fallback.has(sha256).catch(() => false));
    },
    async delete(sha256) {
      await opfs.delete(sha256);
      await fallback.delete(sha256);
    },
  };
}
