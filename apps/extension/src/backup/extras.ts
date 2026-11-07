// Scan text and import refs in the backup (Release 3): `ocr/<sha[0..2]>/<sha>.json` and `imports/<sha[0..2]>/<sha>.json`. One small
// file for each saved reading that has any. The store decides who is eligible (backup-api: not in Trash, not "keep out of search");
// a reading that is not saved, was forgotten with "Never save", or was removed on purpose has no rows to give, so nothing is written
// for it, and `scrub.ts` removes what an earlier run wrote. A file is rewritten only when its text changed.
import { importsPath, IMPORTS_DIR, isSha, ocrPath, OCR_DIR } from '@sop/core';
import type { StoreApi } from '../store/store-api';
import { list, readText, removeDirIfEmpty, removeFile, writeFile } from './fs';

export type ExtrasStore = Pick<StoreApi, 'backupOcrIds' | 'backupOcrFile' | 'backupImportRefs'>;

export interface Extras {
  files: Extra[];
  /** Ids of the marks, threads and comments each reading imported from its PDF (for the Markdown label). */
  imported: Map<string, Set<string>>;
}

export interface Extra {
  path: string;
  /** The reading it belongs to. */
  documentId: string;
  text: string;
}


/** The files the library wants in the backup right now, in a stable order. `liveIds` are the readings not in Trash. */
export async function extraFiles(store: ExtrasStore, liveIds: Iterable<string>): Promise<Extras> {
  const out: Extra[] = [];
  const imported = new Map<string, Set<string>>();
  for (const id of await store.backupOcrIds()) {
    if (!isSha(id)) continue;
    const file = await store.backupOcrFile(id);
    if (file !== null) out.push({ path: ocrPath(id), documentId: id, text: JSON.stringify(file) });
  }
  for (const id of liveIds) {
    if (!isSha(id)) continue;
    const file = await store.backupImportRefs(id);
    if (file === null) continue;
    out.push({ path: importsPath(id), documentId: id, text: JSON.stringify(file) });
    imported.set(id, new Set(file.refs.filter((r) => r.rowId !== '').map((r) => r.rowId)));
  }
  return { files: out, imported };
}

/** Writes the files that changed. Returns the bytes the folder holds for them. */
export async function writeExtras(root: FileSystemDirectoryHandle, files: readonly Extra[]): Promise<number> {
  const enc = new TextEncoder();
  let bytes = 0;
  for (const f of files) {
    if ((await readText(root, f.path)) !== f.text) await writeFile(root, f.path, f.text);
    bytes += enc.encode(f.text).byteLength;
  }
  return bytes;
}

/**
 * Removes files of readings that no longer belong: removed on purpose, or still in the library but not eligible now (in Trash, or
 * kept out of search). A reading that is only missing, without being removed on purpose, keeps its files (R87).
 */
export async function removeStaleExtras(root: FileSystemDirectoryHandle, wanted: ReadonlySet<string>, onPurpose: ReadonlySet<string>, have: ReadonlySet<string>): Promise<void> {
  for (const dir of [OCR_DIR, IMPORTS_DIR]) {
    for (const sub of await list(root, dir)) {
      if (sub.kind !== 'directory') continue;
      for (const f of await list(root, `${dir}/${sub.name}`)) {
        const id = f.name.endsWith('.json') ? f.name.slice(0, -'.json'.length) : '';
        const path = `${dir}/${sub.name}/${f.name}`;
        if (f.kind !== 'file' || !isSha(id) || wanted.has(path)) continue;
        if (have.has(id) || onPurpose.has(id)) await removeFile(root, path);
      }
      await removeDirIfEmpty(root, `${dir}/${sub.name}`);
    }
  }
}

/** Removes every file of these readings (a scrub). */
export async function removeExtrasOf(root: FileSystemDirectoryHandle, ids: Iterable<string>): Promise<void> {
  for (const id of ids) {
    if (!isSha(id)) continue;
    await removeFile(root, ocrPath(id));
    await removeDirIfEmpty(root, `${OCR_DIR}/${id.slice(0, 2)}`);
    await removeFile(root, importsPath(id));
    await removeDirIfEmpty(root, `${IMPORTS_DIR}/${id.slice(0, 2)}`);
  }
}
