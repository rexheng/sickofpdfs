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
