// Small helpers over a `FileSystemDirectoryHandle`, for the backup folder (and the OPFS folder that stands in for it in tests).
// Every file is written through `createWritable()`: Chrome writes to a swap file and puts it in place when the stream is
// closed, so a half-written file never replaces a good one. A failed write is aborted and leaves the old file as it was.
import { pathSegments } from '@sop/core';

const isNotFound = (error: unknown): boolean => error instanceof DOMException && error.name === 'NotFoundError';
const isTypeMismatch = (error: unknown): boolean => error instanceof DOMException && error.name === 'TypeMismatchError';

/** The folder at `path` under `root`, or null when it is not there (and `create` is false). */
export async function openDir(root: FileSystemDirectoryHandle, path: string, create = false): Promise<FileSystemDirectoryHandle | null> {
  let dir = root;
  for (const part of pathSegments(path)) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (error) {
      if (isNotFound(error) || isTypeMismatch(error)) return null;
      throw error;
    }
  }
  return dir;
}

function split(path: string): { dir: string; name: string } {
  const parts = pathSegments(path);
  const name = parts.pop();
  if (name === undefined) throw new RangeError('a file needs a name');
  return { dir: parts.join('/'), name };
}

/** The file at `path`, or null when it is not there. */
export async function openFile(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const { dir, name } = split(path);
  const folder = await openDir(root, dir);
  if (folder === null) return null;
  try {
    return await (await folder.getFileHandle(name)).getFile();
  } catch (error) {
    if (isNotFound(error) || isTypeMismatch(error)) return null;
    throw error;
  }
}

export async function readText(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  return (await openFile(root, path))?.text() ?? null;
}

/** The size of the file at `path`, or null when it is not there. */
export async function fileSize(root: FileSystemDirectoryHandle, path: string): Promise<number | null> {
  return (await openFile(root, path))?.size ?? null;
}

/** Writes text or a stream to `path`, making the folders on the way. The old file stays whole until the new one is complete. */
export async function writeFile(root: FileSystemDirectoryHandle, path: string, data: string | ReadableStream<Uint8Array>): Promise<void> {
  const { dir, name } = split(path);
  const folder = await openDir(root, dir, true);
  if (folder === null) throw new DOMException('The folder could not be made.', 'NotFoundError');
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    if (typeof data === 'string') {
      await writable.write(data);
      await writable.close();
    } else {
      await data.pipeTo(writable); // closes the writable at the end, aborts it on an error
    }
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

/** The name a PDF copy is written under until it is whole (`<sha>.pdf.part`). */
export const PART_SUFFIX = '.part';
/** Chrome's own swap files: `createWritable()` writes into `<name>.crswap` and puts it in place when the stream closes. */
export const SWAP_SUFFIX = '.crswap';

/** lib.dom does not have `move` yet. */
interface MovableHandle extends FileSystemFileHandle {
  move?(newName: string): Promise<void>;
}

/**
 * Writes a stream to `path` by way of `<path>.part`, then moves it into place, so a quit while writing never leaves a short or empty
 * file under the real name (a copy that is there under its real name is whole). The real name is removed first if it is there,
 * since a copy is only rewritten when the one in place is wrong. Where the browser cannot move a file, it writes in place.
 */
export async function writeFileViaPart(root: FileSystemDirectoryHandle, path: string, data: ReadableStream<Uint8Array>): Promise<void> {
  const { dir, name } = split(path);
  const folder = await openDir(root, dir, true);
  if (folder === null) throw new DOMException('The folder could not be made.', 'NotFoundError');
  const part = `${name}${PART_SUFFIX}`;
  await writeFile(root, dir === '' ? part : `${dir}/${part}`, data);
  const handle: MovableHandle = await folder.getFileHandle(part);
  if (typeof handle.move === 'function') {
    await folder.removeEntry(name).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    try {
      await handle.move(name);
      return;
    } catch {
      // A folder where Chrome cannot move a file (some synced folders may refuse): copy it into place below instead.
    }
  }
  // The whole copy is in the part file: write it in place from there (createWritable keeps any old file until the new one is whole).
  await writeFile(root, path, (await handle.getFile()).stream());
  await folder.removeEntry(part).catch(() => {});
}

/**
 * Removes what an earlier run that stopped (the browser quit) left behind under `root`, at any depth: `*.crswap` files last changed
 * before `swapsBefore` (one still in use is newer; Chrome or a sync tool may be writing it), and every `*.part` file in `parts` (the
 * folders only a run writes to, under the run lock). Returns how many went. Errors are ignored: it is tidying, and the next run tries again.
 */
export async function removeLeftovers(root: FileSystemDirectoryHandle, o: { swapsBefore: number; parts: readonly string[] }): Promise<number> {
  let removed = 0;
  const partDirs = new Set(o.parts);
  async function walk(dir: FileSystemDirectoryHandle, path: string): Promise<void> {
    const names: { name: string; kind: string }[] = [];
    for await (const [name, handle] of dir.entries()) names.push({ name, kind: handle.kind });
    for (const { name, kind } of names) {
      try {
        if (kind === 'directory') {
          await walk(await dir.getDirectoryHandle(name), path === '' ? name : `${path}/${name}`);
          continue;
        }
        const top = path.split('/')[0] ?? '';
        const stale =
          (name.endsWith(SWAP_SUFFIX) && (await (await dir.getFileHandle(name)).getFile()).lastModified < o.swapsBefore) ||
          (name.endsWith(PART_SUFFIX) && partDirs.has(top));
        if (stale) {
          await dir.removeEntry(name);
          removed += 1;
        }
      } catch {
        // Tidying only.
      }
    }
  }
  await walk(root, '').catch(() => {});
  return removed;
}

/** Deletes the file at `path`. Nothing happens when it is not there. */
export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const { dir, name } = split(path);
  const folder = await openDir(root, dir);
  if (folder === null) return;
  try {
    await folder.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Deletes a folder if it is empty. A folder that still holds something refuses, which is fine. */
export async function removeDirIfEmpty(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const { dir, name } = split(path);
  const parent = await openDir(root, dir);
  if (parent === null) return;
  await parent.removeEntry(name).catch(() => {});
}

/**
 * Throws `NotFoundError` when the folder behind the handle is gone (renamed, deleted, a drive that is not there). A handle to such a
 * folder looks fine until it is used, and every lookup in it then answers "not found", which must not be read as "empty".
 */
export async function assertReachable(dir: FileSystemDirectoryHandle): Promise<void> {
  await dir.keys()[Symbol.asyncIterator]().next();
}

export interface Entry {
  name: string;
  kind: 'file' | 'directory';
}

/** The names in a folder, files and folders. Empty for a folder that is not there. */
export async function list(root: FileSystemDirectoryHandle, path: string): Promise<Entry[]> {
  const folder = await openDir(root, path);
  if (folder === null) return [];
  const out: Entry[] = [];
  for await (const [name, handle] of folder.entries()) out.push({ name, kind: handle.kind });
  return out;
}
