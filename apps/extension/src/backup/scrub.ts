// "Forget this PDF" in the backup folder (ruling R75). Forgetting a reading removes it from every backup snapshot, not only from the
// library: its PDF copy, its notes file, and its rows in `library.json`, in every `snapshots/library-<day>.json` and in the manifest.
//
// Rules this file keeps:
// - The rows go by document id and nothing else changes in a snapshot: it is rewritten with the same rows it had, less the forgotten reading's.
// - A snapshot that cannot be read is deleted if it names the reading, because a damaged copy can still hold the reading's notes.
// - Each file is checked after it is written: if the reading's id is still in it, the scrub says it failed and is tried again at the next run.
// - A notes file is removed only if its own front matter says it is the reading's (a file the owner keeps in `notes/` is safe).
// - The request is kept (handle-store.ts `scrub`) until it is done, so a folder that is offline or has lost its permission is cleaned at the next run.
import {
  BACKUP_DIR,
  countDump,
  isSha,
  LIBRARY_PATH,
  MANIFEST_PATH,
  NOTES_DIR,
  parseLibraryDump,
  PDF_DIR,
  pdfPath,
  SNAPSHOT_DIR,
  type LibraryDump,
} from '@sop/core';
import { assertReachable, list, openDir, readText, removeDirIfEmpty, removeFile, writeFile } from './fs';
import type { HandleStore } from './handle-store';
import { notesDocumentId, notesTag } from './layout';
import { classifyFailure, type FailureKind } from './status';
import type { BackupTarget } from './target';

export type ScrubOutcome = { ok: true } | { ok: false; kind: 'permission' } | { ok: false; kind: 'failed'; failure: FailureKind };

/** The field that names a row's document, for each table of `library.json`. */
const DOCUMENT_FIELD: Readonly<Record<string, string>> = {
  documents: 'id',
  aliases: 'documentId',
  locations: 'documentId',
  marks: 'documentId',
  threads: 'documentId',
  comments: 'documentId',
  history: 'documentId',
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `library.json` text without the given readings: their rows are dropped from every table, the rest is kept as it was. Null if the text is not a library file. */
export function libraryWithout(text: string, ids: ReadonlySet<string>): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.tables)) return null;
  const tables: Record<string, unknown> = { ...raw.tables };
  for (const [table, field] of Object.entries(DOCUMENT_FIELD)) {
    const rows = tables[table];
    if (Array.isArray(rows)) tables[table] = rows.filter((r) => !(isRecord(r) && typeof r[field] === 'string' && ids.has(r[field])));
  }
  return JSON.stringify({ ...raw, tables });
}

const mentions = (text: string, ids: ReadonlySet<string>): boolean => {
  for (const id of ids) if (text.includes(id)) return true;
  return false;
};

/** The manifest without the readings' PDF entries, its counts worked out again from the library file. */
function manifestWithout(text: string, ids: ReadonlySet<string>, libraryText: string | null): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const pdfs = isRecord(raw.pdfs) ? Object.fromEntries(Object.entries(raw.pdfs).filter(([sha]) => !ids.has(sha))) : {};
  let counts: unknown = raw.counts;
  if (libraryText !== null) {
    try {
      const dump: LibraryDump = parseLibraryDump(libraryText);
      counts = countDump(dump, Object.keys(pdfs).length);
    } catch {
      // The old counts stay; they are only numbers.
    }
  }
  return JSON.stringify({ ...raw, pdfs, counts });
}

/**
 * Removes the readings from the backup folder. The caller holds the backup lock. Never throws.
 * A folder with no backup in it is a success: there is nothing to remove.
 */
export async function scrubFolder(target: BackupTarget, documentIds: readonly string[], handles?: Pick<HandleStore, 'getKnown' | 'setKnown'>): Promise<ScrubOutcome> {
  const ids = new Set<string>(documentIds.filter(isSha));
  try {
    if (ids.size === 0) return { ok: true };
    if ((await target.queryPermission()) !== 'granted') return { ok: false, kind: 'permission' };
    const parent = await target.directory();
    await assertReachable(parent); // a folder that is gone is not an empty one
    const root = await openDir(parent, BACKUP_DIR);
    if (root !== null) {
      // 1. The copies and the notes files: the most personal things go first.
      for (const id of ids) {
        await removeFile(root, pdfPath(id));
        await removeDirIfEmpty(root, `${PDF_DIR}/${id.slice(0, 2)}`);
      }
      for (const entry of await list(root, NOTES_DIR)) {
        const tag = notesTag(entry.name);
        if (entry.kind !== 'file' || tag === null || ![...ids].some((id) => id.startsWith(tag))) continue;
        const owner = notesDocumentId((await readText(root, `${NOTES_DIR}/${entry.name}`)) ?? '');
        if (owner !== null && ids.has(owner)) await removeFile(root, `${NOTES_DIR}/${entry.name}`);
      }

      // 2. The rows: `library.json` and every snapshot, each rewritten without the readings and then read back.
      const libraryFiles = [LIBRARY_PATH];
      for (const entry of await list(root, SNAPSHOT_DIR)) if (entry.kind === 'file' && entry.name.endsWith('.json')) libraryFiles.push(`${SNAPSHOT_DIR}/${entry.name}`);
      let cleanLibrary: string | null = null;
      for (const path of libraryFiles) {
        const text = await readText(root, path);
        if (text === null || !mentions(text, ids)) {
          if (path === LIBRARY_PATH) cleanLibrary = text;
          continue;
        }
        const without = libraryWithout(text, ids);
        if (without === null) {
          await removeFile(root, path); // damaged, and it names the reading: gone
          continue;
        }
        if (mentions(without, ids)) {
          await removeFile(root, path); // the id is somewhere the rows do not reach: the copy cannot be cleaned, so it goes
          continue;
        }
        await writeFile(root, path, without);
        if (path === LIBRARY_PATH) cleanLibrary = without;
      }

      // 3. The manifest, last.
      const manifest = await readText(root, MANIFEST_PATH);
      if (manifest !== null && mentions(manifest, ids)) {
        const without = manifestWithout(manifest, ids, cleanLibrary);
        if (without === null || mentions(without, ids)) await removeFile(root, MANIFEST_PATH);
        else await writeFile(root, MANIFEST_PATH, without);
      }
    }
    if (handles) {
      const known = await handles.getKnown();
      for (const id of ids) known.delete(id);
      await handles.setKnown(known);
    }
    return { ok: true };
  } catch (error) {
    const failure = classifyFailure(error);
    return failure === 'permission' ? { ok: false, kind: 'permission' } : { ok: false, kind: 'failed', failure };
  }
}
