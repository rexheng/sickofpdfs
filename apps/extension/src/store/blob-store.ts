// The copies of saved PDFs: one file per document in the extension's private file storage (OPFS), named by the
// SHA-256 of its bytes. Task 30 saves through it; Phase 3 restores and backs up through it.
//
// Layout (binding): `pdf/<first two hex digits>/<sha256>.pdf`, and `tmp/<uuid>.part` while a file is being written.
// A file reaches `pdf/` only when it is whole and its hash is known, so a reader never sees half a PDF.
import { createSha256 } from '@sop/core/fingerprint';
import type { Sha256 } from '@sop/core/ids';

const MiB = 1024 * 1024;

/** Every write to disk is this big, except the last one (R34 asks for 4 to 16 MiB). */
export const BLOB_CHUNK_BYTES = 8 * MiB;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The hash of the bytes that were written is not the hash the caller expected. Nothing was kept. */
export class BlobHashMismatchError extends Error {
  override readonly name = 'BlobHashMismatchError';
  constructor(
    readonly expected: Sha256,
    readonly actual: Sha256,
  ) {
    super(`The file's SHA-256 is ${actual}, not the expected ${expected}. Nothing was saved.`);
  }
}

export interface BlobStore {
  /**
   * Writes the bytes in 8 MiB steps while hashing them, without holding the whole file in memory. With `expected`, a
   * different hash removes the partial file and throws `BlobHashMismatchError`. Putting bytes that are already stored
   * changes nothing and answers `created: false`.
   */
  put(data: Blob | ReadableStream<Uint8Array>, expected?: Sha256): Promise<{ sha256: Sha256; size: number; created: boolean }>;
  /** The stored file (backed by the disk, not read into memory), or null. */
  get(sha256: Sha256): Promise<File | null>;
  has(sha256: Sha256): Promise<boolean>;
  /** Removes the stored file. Nothing happens when there is none. */
  delete(sha256: Sha256): Promise<void>;
}

function assertSha256(value: string): asserts value is Sha256 {
  if (!SHA256_PATTERN.test(value)) throw new TypeError('A SHA-256 is 64 lower-case hex characters.');
}

/** Where a stored PDF lives, from the OPFS root: `pdf/ab/<sha256>.pdf`. */
export function blobPath(sha256: Sha256): string {
  assertSha256(sha256);
  return `pdf/${sha256.slice(0, 2)}/${sha256}.pdf`;
}

/** `FileSystemFileHandle.move` ships in Chrome 110 and later; TypeScript's DOM types do not have it yet. */
type MovableFileHandle = FileSystemFileHandle & { move(destination: FileSystemDirectoryHandle, name: string): Promise<void> };

const isNotFound = (error: unknown): boolean => error instanceof DOMException && error.name === 'NotFoundError';

async function removeQuietly(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    // Already gone, or the browser will clear it later (see sweepStaleParts).
  }
}

/** Runs `body` while holding a lock that every tab, worker and offscreen document of this extension shares. */
function withLock<T>(name: string, body: () => Promise<T>): Promise<T> {
  return navigator.locks.request(name, body);
}

const tmpLock = (id: string) => `sop-blob-tmp-${id}`;
const shardLock = (shard: string) => `sop-blob-shard-${shard}`;

/** Reads a byte stream straight into one reused buffer: no copy, no garbage. */
async function* readIntoBuffer(reader: ReadableStreamBYOBReader, capacity: number): AsyncGenerator<Uint8Array> {
  let buffer = new ArrayBuffer(capacity);
  let held = 0;
  let finished = false;
  try {
    for (;;) {
      // Reading hands our buffer to the stream and gives it back inside `value`.
      const { done, value } = await reader.read(new Uint8Array(buffer, held, capacity - held));
      if (value) {
        buffer = value.buffer;
        held += value.byteLength;
      }
      if (done) break;
      if (held === capacity) {
        yield new Uint8Array(buffer, 0, held);
        held = 0;
      }
    }
    if (held > 0) yield new Uint8Array(buffer, 0, held);
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Copies whatever chunk sizes a plain stream delivers into one reused buffer. */
async function* copyIntoBuffer(reader: ReadableStreamDefaultReader<Uint8Array>, capacity: number): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(capacity);
  let held = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('A byte stream must hold Uint8Array chunks.');
      let rest = value;
      while (rest.byteLength > 0) {
        const take = Math.min(rest.byteLength, capacity - held);
        buffer.set(rest.subarray(0, take), held);
        held += take;
        rest = rest.subarray(take);
        if (held === capacity) {
          yield buffer;
          held = 0;
        }
      }
    }
    if (held > 0) yield buffer.subarray(0, held);
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * The input as views of exactly BLOB_CHUNK_BYTES, then the remainder. Every view is over the same reused buffer, so
 * memory stays flat however big the file is: the consumer must be done with a view (written and hashed it) before it asks
 * for the next one, which `for await` guarantees. Stops reading the input if the consumer stops.
 */
function chunksOf(data: Blob | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const stream = data instanceof Blob ? data.stream() : data;
  const capacity = data instanceof Blob ? Math.max(1, Math.min(data.size, BLOB_CHUNK_BYTES)) : BLOB_CHUNK_BYTES;
  // A byte stream (a Blob's, a fetch body's) can be read into our own buffer. Any other stream cannot, and is copied.
  try {
    return readIntoBuffer(stream.getReader({ mode: 'byob' }), capacity);
  } catch {
    return copyIntoBuffer(stream.getReader(), capacity);
  }
}

/** Removes files in `tmp/` that no live `put` owns: what a crash or a closed tab left behind. */
async function sweepStaleParts(tmp: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = [];
  for await (const name of tmp.keys()) names.push(name);
  for (const name of names) {
    // `<uuid>.part`, and the browser's own `<uuid>.part.crswap` next to it while a write is open.
    const id = name.split('.')[0];
    await navigator.locks.request(tmpLock(id), { ifAvailable: true }, async (lock) => {
      if (lock) await removeQuietly(tmp, name);
    });
  }
}

export async function openBlobStore(): Promise<BlobStore> {
  const root = await navigator.storage.getDirectory();
  const pdfDir = await root.getDirectoryHandle('pdf', { create: true });
  const tmpDir = await root.getDirectoryHandle('tmp', { create: true });
  await sweepStaleParts(tmpDir);

  async function shardOf(sha256: Sha256): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await pdfDir.getDirectoryHandle(sha256.slice(0, 2));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function fileHandleOf(sha256: Sha256): Promise<FileSystemFileHandle | null> {
    const shard = await shardOf(sha256);
    if (!shard) return null;
    try {
      return await shard.getFileHandle(`${sha256}.pdf`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Streams `data` into `tmp/<name>`; returns what was written. On any failure the temp file is removed. */
  async function writePart(name: string, data: Blob | ReadableStream<Uint8Array>): Promise<{ file: FileSystemFileHandle; sha256: Sha256; size: number }> {
    const file = await tmpDir.getFileHandle(name, { create: true });
    try {
      const hasher = await createSha256();
      const writable = await file.createWritable();
      let size = 0;
      try {
        for await (const chunk of chunksOf(data)) {
          hasher.update(chunk);
          await writable.write(chunk as Uint8Array<ArrayBuffer>);
          size += chunk.byteLength;
        }
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
      return { file, sha256: hasher.digest(), size };
    } catch (error) {
      await removeQuietly(tmpDir, name);
      throw error;
    }
  }

  return {
    async put(data, expected) {
      if (expected !== undefined) assertSha256(expected);
      const id = crypto.randomUUID();
      const name = `${id}.part`;
      // The lock marks the temp file as in use, so another tab's sweep leaves it alone. It is taken before the file exists.
      return withLock(tmpLock(id), async () => {
        const { file, sha256, size } = await writePart(name, data);
        if (expected !== undefined && expected !== sha256) {
          await removeQuietly(tmpDir, name);
          throw new BlobHashMismatchError(expected, sha256);
        }
        const shardName = sha256.slice(0, 2);
        // Checking for the file and moving into place happen under one lock, so two tabs putting the same bytes
        // agree on who created it.
        return withLock(shardLock(shardName), async () => {
          try {
            const shard = await pdfDir.getDirectoryHandle(shardName, { create: true });
            const target = `${sha256}.pdf`;
            const exists = await shard.getFileHandle(target).then(
              () => true,
              (error: unknown) => {
                if (isNotFound(error)) return false;
                throw error;
              },
            );
            if (exists) {
              await removeQuietly(tmpDir, name);
              return { sha256, size, created: false };
            }
            await (file as MovableFileHandle).move(shard, target);
            return { sha256, size, created: true };
          } catch (error) {
            await removeQuietly(tmpDir, name);
            throw error;
          }
        });
      });
    },

    async get(sha256) {
      assertSha256(sha256);
      const handle = await fileHandleOf(sha256);
      return handle ? handle.getFile() : null;
    },

    async has(sha256) {
      assertSha256(sha256);
      return (await fileHandleOf(sha256)) !== null;
    },

    async delete(sha256) {
      assertSha256(sha256);
      const shardName = sha256.slice(0, 2);
      await withLock(shardLock(shardName), async () => {
        const shard = await shardOf(sha256);
        if (!shard) return;
        try {
          await shard.removeEntry(`${sha256}.pdf`);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        // An empty folder is tidied away; a folder that still holds other PDFs refuses, which is fine.
        await pdfDir.removeEntry(shardName).catch(() => {});
      });
    },
  };
}
