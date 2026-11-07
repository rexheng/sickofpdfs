// A reading that left the library for good (R75, R82: Forget, a Trash purge, an Undo of a save) leaves the backup folder too: its PDF
// copy, its notes file, and its rows in `library.json`, in every `snapshots/library-<day>.json` and in the manifest.
//
// Rules this file keeps:
// - Only the reading's own rows, files and notes go. Every other file is kept: a file that can be read is rewritten without the
//   reading's rows, and nothing else in it changes. A file is never deleted as a way to clean it (secread4 M1).
// - Another reading's note that mentions the reading (a pasted link with its id, say) is that other reading's content. It stays as it is.
// - A file that cannot be read (damaged, cut short) is left as it is, and named in the answer, so Settings can say so plainly. The
//   removal then stays pending and is tried again at each run.
// - Each file is checked after it is written: if any of the reading's rows are still in it, the scrub says it failed and is tried again.
// - A notes file is removed only if its own front matter says it is the reading's (a file the owner keeps in `notes/` is safe).
// - The request is kept (handle-store.ts `scrub`, or `retired` for a folder the owner moved away from) until it is done, so a folder
//   that is offline or has lost its permission is cleaned at the next run.
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
import { removeExtrasOf } from './extras';
import { assertReachable, list, openDir, PART_SUFFIX, readText, removeDirIfEmpty, removeFile, writeFile } from './fs';
import type { HandleStore } from './handle-store';
import { notesDocumentId, notesTag } from './layout';
import { classifyFailure, type FailureKind } from './status';
import type { BackupTarget } from './target';

export type ScrubOutcome =
  /** Done, except in the files named in `unreadable` (paths inside `sickofpdfs-backup`), which could not be read and were left as they are. */
  | { ok: true; unreadable: string[] }
  | { ok: false; kind: 'permission' }
  | { ok: false; kind: 'failed'; failure: FailureKind };

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

/** A library file's tables, or null when the text is not one. */
function tablesOf(text: string): { raw: Record<string, unknown>; tables: Record<string, unknown> } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(raw) && isRecord(raw.tables) ? { raw, tables: raw.tables } : null;
}

/** True for a row that belongs to one of the readings: it names one in its table's document field (an alias also by its own fingerprint). */
function isTheirs(table: string, row: unknown, ids: ReadonlySet<string>): boolean {
  if (!isRecord(row)) return false;
  const field = DOCUMENT_FIELD[table];
  if (field !== undefined && typeof row[field] === 'string' && ids.has(row[field])) return true;
  return table === 'aliases' && typeof row.sha256 === 'string' && ids.has(row.sha256);
}

/**
 * `library.json` text without the given readings: their rows are dropped from every table, every other row is kept as it was (a note
 * of another reading that mentions one of them included). Null if the text is not a library file. `removed` is the number of rows dropped.
 */
export function libraryWithout(text: string, ids: ReadonlySet<string>): { text: string; removed: number } | null {
  const parsed = tablesOf(text);
  if (parsed === null) return null;
  const tables: Record<string, unknown> = { ...parsed.tables };
  let removed = 0;
  for (const table of Object.keys(DOCUMENT_FIELD)) {
    const rows = tables[table];
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter((r) => !isTheirs(table, r, ids));
    removed += rows.length - kept.length;
    tables[table] = kept;
  }
  return { text: removed === 0 ? text : JSON.stringify({ ...parsed.raw, tables }), removed };
}

/** The number of the readings' rows in a library file, or null when it cannot be read. */
export function rowsOfReadings(text: string, ids: ReadonlySet<string>): number | null {
  const parsed = tablesOf(text);
  if (parsed === null) return null;
  let n = 0;
  for (const table of Object.keys(DOCUMENT_FIELD)) {
    const rows = parsed.tables[table];
    if (Array.isArray(rows)) n += rows.filter((r) => isTheirs(table, r, ids)).length;
  }
  return n;
}

const mentions = (text: string, ids: ReadonlySet<string>): boolean => {
  for (const id of ids) if (text.includes(id)) return true;
  return false;
};

/** The error a scrub throws when a file still holds the reading's rows after it was written: the scrub is tried again. */
const stillThere = (): Error => Object.assign(new Error('a backup file still holds a removed reading'), { name: 'ScrubCheckError' });

/** The manifest without the readings' PDF entries, its counts worked out again from the library file. Null if it cannot be read. */
function manifestWithout(text: string, ids: ReadonlySet<string>, libraryText: string | null): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (!isRecord(raw.pdfs) || !Object.keys(raw.pdfs).some((sha) => ids.has(sha))) return text; // nothing of theirs in it
  const pdfs = Object.fromEntries(Object.entries(raw.pdfs).filter(([sha]) => !ids.has(sha)));
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
 * A folder with no backup in it is a success: there is nothing to remove. `handles` (the chosen folder only) also takes the readings
 * out of the list of what this computer wrote there.
 */
export async function scrubFolder(target: BackupTarget, documentIds: readonly string[], handles?: Pick<HandleStore, 'getKnown' | 'setKnown'>): Promise<ScrubOutcome> {
  const ids = new Set<string>(documentIds.filter(isSha));
  const unreadable: string[] = [];
  try {
    if (ids.size === 0) return { ok: true, unreadable };
    if ((await target.queryPermission()) !== 'granted') return { ok: false, kind: 'permission' };
    const parent = await target.directory();
    await assertReachable(parent); // a folder that is gone is not an empty one
    const root = await openDir(parent, BACKUP_DIR);
    if (root !== null) {
      // 1. The copies and the notes files: the most personal things go first. A copy cut short by a quit (`.part`) goes too.
      for (const id of ids) {
        await removeFile(root, pdfPath(id));
        await removeFile(root, `${pdfPath(id)}${PART_SUFFIX}`);
        await removeDirIfEmpty(root, `${PDF_DIR}/${id.slice(0, 2)}`);
      }
      await removeExtrasOf(root, ids); // scan text and import refs
      for (const entry of await list(root, NOTES_DIR)) {
        const tag = notesTag(entry.name);
        if (entry.kind !== 'file' || tag === null || ![...ids].some((id) => id.startsWith(tag))) continue;
        const owner = notesDocumentId((await readText(root, `${NOTES_DIR}/${entry.name}`)) ?? '');
        if (owner !== null && ids.has(owner)) await removeFile(root, `${NOTES_DIR}/${entry.name}`);
      }

      // 2. The rows: `library.json` and every snapshot, each rewritten without the readings' rows and then read back.
      const libraryFiles = [LIBRARY_PATH];
      for (const entry of await list(root, SNAPSHOT_DIR)) if (entry.kind === 'file' && entry.name.endsWith('.json')) libraryFiles.push(`${SNAPSHOT_DIR}/${entry.name}`);
      let cleanLibrary: string | null = null;
      for (const path of libraryFiles) {
        const text = await readText(root, path);
        if (path === LIBRARY_PATH) cleanLibrary = text;
        if (text === null || !mentions(text, ids)) continue;
        const without = libraryWithout(text, ids);
        if (without === null) {
          unreadable.push(path); // it names the reading but cannot be read: left as it is, and said plainly
          continue;
        }
        if (without.removed === 0) continue; // only another reading's note mentions it: that note stays as it is
        await writeFile(root, path, without.text);
        if ((rowsOfReadings((await readText(root, path)) ?? '', ids) ?? 1) > 0) throw stillThere();
        if (path === LIBRARY_PATH) cleanLibrary = without.text;
      }

      // 3. The manifest, last.
      const manifest = await readText(root, MANIFEST_PATH);
      if (manifest !== null && mentions(manifest, ids)) {
        const without = manifestWithout(manifest, ids, cleanLibrary);
        if (without === null) unreadable.push(MANIFEST_PATH);
        else if (without !== manifest) await writeFile(root, MANIFEST_PATH, without);
      }
    }
    if (handles) {
      const known = await handles.getKnown();
      for (const id of ids) known.delete(id);
      await handles.setKnown(known);
    }
    return { ok: true, unreadable };
  } catch (error) {
    const failure = classifyFailure(error);
    return failure === 'permission' ? { ok: false, kind: 'permission' } : { ok: false, kind: 'failed', failure };
  }
}
