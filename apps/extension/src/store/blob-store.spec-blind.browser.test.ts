// Spec-blind browser test for Task 29: the OPFS blob store (saved copies of PDFs, named by their SHA-256).
//
// Sources:
//   interface file (Task 29): blobPath(sha) = 'pdf/ab/<sha>.pdf'; BlobStore { put(data: Blob | ReadableStream<Uint8Array>, expected?)
//     -> { sha256, size, created }; get(sha) -> File | null; has; delete }; BlobHashMismatchError. put: "Stream into tmp/<uuid>.part ... On a
//     mismatch against expected, remove the temp file and throw. If the target exists, remove the temp file and return created: false.
//     Otherwise move it to pdf/<ab>/<sha>.pdf".
//   spec, Storage: "tabs write them straight into the extension's private file storage, named by fingerprint, so duplicates are stored
//     once"; Identity rule 1: the fingerprint is the SHA-256 of the file's bytes.
//   plan summary (interface file): "keyed by their SHA-256 and checked on write"; the documents.blob_stored column: "OPFS
//     pdf/<id[0..2]>/<id>.pdf exists".
//   CLAUDE.md: "no lost notes": a copy that fails its check must never appear as a saved PDF.
// Real Chromium, real OPFS. Every PDF in these tests is random bytes with a marker, so a leftover temp file can be recognised by content.
import { afterEach, describe, expect, it } from 'vitest';
import { BlobHashMismatchError, blobPath, openBlobStore, type BlobStore } from './blob-store';

const created: string[] = [];
let store: BlobStore;

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

/** `size` bytes that start with a unique marker, so this test's bytes can be told from any other test's. */
function makeBytes(size: number): { bytes: Uint8Array; marker: string } {
  const marker = `SOPBLOB-${crypto.randomUUID()}-`;
  const bytes = new Uint8Array(Math.max(size, 0));
  for (let offset = 0; offset < bytes.length; offset += 65_536) crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
  const head = new TextEncoder().encode(marker);
  bytes.set(head.subarray(0, Math.min(head.length, bytes.length)));
  return { bytes, marker: bytes.length >= head.length ? marker : '' };
}

/** A stream that delivers `bytes` in pieces of `chunk` bytes (with an empty piece in the middle), optionally failing after `failAfter` bytes. */
function streamOf(bytes: Uint8Array, chunk: number, failAfter?: number): ReadableStream<Uint8Array> {
  let at = 0;
  let sentEmpty = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && at >= failAfter) return controller.error(new Error('the connection dropped'));
      if (!sentEmpty && at > 0) {
        sentEmpty = true;
        return controller.enqueue(new Uint8Array(0));
      }
      if (at >= bytes.length) return controller.close();
      const end = Math.min(at + chunk, bytes.length, failAfter ?? Infinity);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    },
  });
}

async function opfsFile(path: string): Promise<File | null> {
  try {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return await (await dir.getFileHandle(parts.at(-1)!)).getFile();
  } catch {
    return null;
  }
}

/** The temp files (anywhere under tmp/) that hold this test's marker: there must be none once a put has finished. */
async function leftovers(marker: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const tmp = await (await navigator.storage.getDirectory()).getDirectoryHandle('tmp');
    for await (const [name, handle] of tmp.entries()) {
      if (handle.kind !== 'file') continue;
      const text = new TextDecoder('latin1').decode(await (await (handle).getFile()).arrayBuffer());
      if (text.includes(marker)) out.push(name);
    }
  } catch {
    // no tmp/ folder at all: nothing left over
  }
  return out;
}

async function stored(sha: string, bytes: Uint8Array): Promise<string> {
  created.push(sha);
  const file = await store.get(sha as never);
  expect(file, `${sha} should be stored`).not.toBeNull();
  const back = new Uint8Array(await file!.arrayBuffer());
  return back.length === bytes.length && back.every((b, i) => b === bytes[i]) ? 'same bytes' : 'different bytes';
}

afterEach(async () => {
  store ??= await openBlobStore();
  for (const sha of created.splice(0)) await store.delete(sha as never).catch(() => undefined);
});

describe('the blob store', () => {
  it('names a file by its fingerprint: pdf/<first two characters>/<sha>.pdf', () => {
    expect(blobPath('ab'.repeat(32) as never)).toBe(`pdf/ab/${'ab'.repeat(32)}.pdf`);
    expect(blobPath(`0f${'12'.repeat(31)}` as never)).toBe(`pdf/0f/0f${'12'.repeat(31)}.pdf`);
  });

  it.each([
    { name: 'an empty file', size: 0, make: 'blob' },
    { name: 'one byte', size: 1, make: 'blob' },
    { name: 'a Blob of 3 MiB', size: 3 * 1024 * 1024, make: 'blob' },
    { name: 'a stream in several chunks, one of them empty', size: 70_001, make: 'stream-10000' },
    { name: 'a stream of 3 MiB in 64 KiB chunks', size: 3 * 1024 * 1024, make: 'stream-65536' },
    { name: 'a stream in 1-byte chunks', size: 300, make: 'stream-1' },
  ])('stores $name under its SHA-256, byte for byte, and says so', async ({ size, make }) => {
    store = await openBlobStore();
    const { bytes, marker } = makeBytes(size);
    const sha = await sha256(bytes);
    const data = make === 'blob' ? new Blob([bytes as BlobPart]) : streamOf(bytes, Number(make.split('-')[1]));

    const result = await store.put(data, sha as never);
    created.push(sha);

    expect(result).toEqual({ sha256: sha, size: bytes.length, created: true });
    expect(await store.has(sha as never)).toBe(true);
    expect(await stored(sha, bytes)).toBe('same bytes');
    expect((await opfsFile(blobPath(sha as never)))?.size, 'the file is where blobPath says').toBe(bytes.length);
    if (marker) expect(await leftovers(marker), 'no temp file is left').toEqual([]);
  });

  it('works out the fingerprint itself when none is given', async () => {
    store = await openBlobStore();
    const { bytes } = makeBytes(5000);
    const sha = await sha256(bytes);
    expect(await store.put(new Blob([bytes as BlobPart]))).toEqual({ sha256: sha, size: 5000, created: true });
    expect(await stored(sha, bytes)).toBe('same bytes');
  });

  it('putting the same PDF again is harmless: created is false, one file, same bytes, no temp file', async () => {
    store = await openBlobStore();
    const { bytes, marker } = makeBytes(40_000);
    const sha = await sha256(bytes);
    expect((await store.put(new Blob([bytes as BlobPart]), sha as never)).created).toBe(true);
    created.push(sha);

    const again = await store.put(streamOf(bytes, 9000), sha as never);

    expect(again).toEqual({ sha256: sha, size: bytes.length, created: false });
    expect(await stored(sha, bytes)).toBe('same bytes');
    expect(await leftovers(marker)).toEqual([]);
  });

  it('two tabs saving the same PDF at the same moment end with one good copy and no temp files', async () => {
    store = await openBlobStore();
    const { bytes, marker } = makeBytes(200_000);
    const sha = await sha256(bytes);
    created.push(sha);

    const results = await Promise.all([
      store.put(new Blob([bytes as BlobPart]), sha as never),
      (await openBlobStore()).put(streamOf(bytes, 4096), sha as never),
      store.put(new Blob([bytes as BlobPart])),
      (await openBlobStore()).put(streamOf(bytes, 50_000)),
    ]);

    for (const r of results) expect(r).toMatchObject({ sha256: sha, size: bytes.length });
    expect(results.some((r) => r.created), 'someone made it').toBe(true);
    expect(await stored(sha, bytes)).toBe('same bytes');
    expect(await leftovers(marker)).toEqual([]);
  });
});

describe('a copy that fails its check never shows up as a saved PDF', () => {
  const WRONG = 'f0'.repeat(32);
  const CASES = [
    {
      name: 'the bytes do not match the fingerprint they were announced with',
      run: async (bytes: Uint8Array) => store.put(new Blob([bytes as BlobPart]), WRONG as never),
      expectError: BlobHashMismatchError,
    },
    {
      name: 'a stream with the wrong fingerprint',
      run: async (bytes: Uint8Array) => store.put(streamOf(bytes, 5000), WRONG as never),
      expectError: BlobHashMismatchError,
    },
    {
      name: 'the connection drops half way through the stream',
      run: async (bytes: Uint8Array) => store.put(streamOf(bytes, 5000, bytes.length / 2), (await sha256(bytes)) as never),
      expectError: Error,
    },
  ];

  it.each(CASES)('$name: it throws, leaves no file under either name, and no temp file', async ({ run, expectError }) => {
    store = await openBlobStore();
    const { bytes, marker } = makeBytes(60_000);
    const real = await sha256(bytes);

    await expect(run(bytes)).rejects.toBeInstanceOf(expectError);

    expect(await store.has(real as never), 'the real name must not exist').toBe(false);
    expect(await store.has(WRONG as never), 'the announced name must not exist').toBe(false);
    expect(await opfsFile(blobPath(real as never))).toBeNull();
    expect(await opfsFile(blobPath(WRONG as never))).toBeNull();
    expect(await leftovers(marker), 'a half-written .part file is left in tmp/').toEqual([]);
    // and the store still works afterwards
    expect((await store.put(new Blob([bytes as BlobPart]), real as never)).created).toBe(true);
    created.push(real);
  });

  it('a failed put never harms a good copy that is already there, even when it names that copy', async () => {
    store = await openBlobStore();
    const good = makeBytes(30_000);
    const goodSha = await sha256(good.bytes);
    await store.put(new Blob([good.bytes as BlobPart]), goodSha as never);
    created.push(goodSha);
    const other = makeBytes(30_000);

    await expect(store.put(new Blob([other.bytes as BlobPart]), goodSha as never)).rejects.toBeInstanceOf(BlobHashMismatchError);
    await expect(store.put(new Blob([good.bytes as BlobPart]), WRONG as never)).rejects.toBeInstanceOf(BlobHashMismatchError);

    expect(await stored(goodSha, good.bytes)).toBe('same bytes');
    expect(await store.has((await sha256(other.bytes)) as never)).toBe(false);
    expect(await leftovers(other.marker)).toEqual([]);
    expect(await leftovers(good.marker)).toEqual([]);
  });
});

describe('looking up and removing copies', () => {
  it('asks for a copy that is not there and gets null / false, and deleting it is harmless; delete removes exactly that copy and the same PDF can be put again; another store sees the same files', async () => {
    store = await openBlobStore();
    const missing = 'd1'.repeat(32);
    expect(await store.get(missing as never)).toBeNull();
    expect(await store.has(missing as never)).toBe(false);
    await expect(store.delete(missing as never)).resolves.toBeUndefined();

    const a = makeBytes(2000);
    const b = makeBytes(3000);
    const [shaA, shaB] = [await sha256(a.bytes), await sha256(b.bytes)];
    await store.put(new Blob([a.bytes as BlobPart]), shaA as never);
    await store.put(new Blob([b.bytes as BlobPart]), shaB as never);
    created.push(shaA, shaB);
    const other = await openBlobStore();
    expect(await other.has(shaA as never), 'the files are the state, not the object').toBe(true);

    await store.delete(shaA as never);

    expect(await store.has(shaA as never)).toBe(false);
    expect(await other.get(shaA as never)).toBeNull();
    expect(await opfsFile(blobPath(shaA as never))).toBeNull();
    expect(await stored(shaB, b.bytes)).toBe('same bytes');
    expect((await store.put(new Blob([a.bytes as BlobPart]), shaA as never)).created).toBe(true);
  });
});
