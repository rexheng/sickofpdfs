// "Restore from backup" (Phase 3 S17): what happens between the folder the owner picked and a library that holds the backup again.
// It runs in the restore worker (restore-worker.ts, started by the Settings page), so reading and parsing `library.json` never happens
// on the page's main thread, which viewer tabs share (backupfix N4).
//
//   1. previewBackup: reads the folder (restore-read.ts: size caps, no `library.json` means no restore, a newer version is refused) and
//      says what is in it in plain words ("12 readings, 340 notes, 9 PDFs"), and how many readings removed here will be left out.
//   2. applyBackup, after the owner says Restore:
//      - the store plans the merge against the library as it is at that moment and writes it in one transaction
//        (`applyRestorePlan`). It never deletes; it leaves out readings forgotten here (R88) and any row that would move a note to
//        another reading; it follows sync's conflict rules (an edit beats a delete, the losing text becomes an "edited on another device"
//        copy); it publishes its changes with origin 'restore', so open tabs redraw;
//      - the PDFs the library now lacks are copied from the backup into the private file storage, each hashed as it is written: a copy
//        whose SHA-256 is not its name is never kept (BlobStore.put);
//      - the readings whose page text must be read again are listed for the offscreen document (reindex.ts).
//   Restoring the same backup again changes nothing: the plan is empty, every PDF is here, and every page has its text.
//
// Nothing here writes to the backup folder, and nothing here reads the secrets store.
import { countDump, describeBackup, isSha, type DocumentId, type LibraryDump, type RestoreSummary, TOO_NEW_MESSAGE } from '@sop/core';
import { BlobHashMismatchError, type BlobStore } from '../store/blob-store';
import type { StoreApi } from '../store/store-api';
import { openBackupPdf, readBackupFolder, type BackupRead } from './restore-read';

/** A backup that was read and can be restored. */
export type ReadBackup = Extract<BackupRead, { ok: true }>;

export type RefusalReason = Extract<BackupRead, { ok: false }>['reason'] | 'unreadable';

/** What the restore dialog shows before anything changes. */
export type RestorePreview =
  | {
      ok: true;
      /** In the restore dialog's words: "12 readings, 340 notes, 9 PDFs" (describeBackup). */
      words: string;
      readings: number;
      notes: number;
      pdfs: number;
      /** When the backup was made (Unix ms). */
      createdAt: number;
      /** Readings in the backup that were removed here for good (Forget, the Trash purge): they stay out (R88). */
      leftOut: number;
    }
  | { ok: false; reason: RefusalReason; message: string };

/** A newer version made this backup (contracts §5: "Update sickofpdfs first"). */
export const TOO_NEW_WORDS = `This backup was made by a newer version of sickofpdfs. ${TOO_NEW_MESSAGE}, then restore it.`;
/** The folder could not be read at all (permission, or it is gone). */
export const UNREADABLE_WORDS = 'This folder can’t be opened. Choose it again.';

const FORGOTTEN_QUERY = 10_000;

/** The readings of `ids` that left this library for good, asked in pieces the store accepts. */
async function forgottenOf(store: Pick<StoreApi, 'forgottenAmong'>, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let at = 0; at < ids.length; at += FORGOTTEN_QUERY) for (const id of await store.forgottenAmong(ids.slice(at, at + FORGOTTEN_QUERY))) out.add(id);
  return out;
}

/** The counts the dialog shows: readings and notes not deleted, and the readings whose PDF the backup holds. */
export function backupCounts(read: Pick<ReadBackup, 'dump' | 'manifest'>): { readings: number; notes: number; pdfs: number } {
  const c = countDump(read.dump, 0);
  const pdfs = read.dump.tables.documents.filter((d) => isSha(d.id) && read.manifest.pdfs[d.id] !== undefined).length;
  return { readings: c.documents, notes: c.threads, pdfs };
}

/**
 * Reads the backup in `folder` (the folder the owner picked, or the `sickofpdfs-backup` folder in it) and says what it holds. Never
 * throws: a folder that cannot be used is a refusal in plain words. `read` is what `applyBackup` needs, when the answer is yes.
 */
export async function previewBackup(
  folder: FileSystemDirectoryHandle,
  store: Pick<StoreApi, 'schemaVersion' | 'forgottenAmong'>,
): Promise<{ preview: RestorePreview; read: ReadBackup | null }> {
  let read: BackupRead;
  try {
    read = await readBackupFolder(folder);
  } catch {
    return { preview: { ok: false, reason: 'unreadable', message: UNREADABLE_WORDS }, read: null };
  }
  if (!read.ok) return { preview: { ok: false, reason: read.reason, message: read.reason === 'too-new' ? TOO_NEW_WORDS : read.message }, read: null };
  // A backup from a newer database is refused too (restore rulings): its rows may mean things this version does not know.
  if (read.manifest.schemaVersion > (await store.schemaVersion())) return { preview: { ok: false, reason: 'too-new', message: TOO_NEW_WORDS }, read: null };
  const counts = backupCounts(read);
  const ids = read.dump.tables.documents.map((d) => d.id).filter(isSha);
  const forgotten = await forgottenOf(store, ids);
  return {
    preview: { ok: true, words: describeBackup({ counts: { documents: counts.readings, threads: counts.notes, marks: 0, comments: 0, pdfs: counts.pdfs } }), ...counts, createdAt: read.manifest.createdAt, leftOut: forgotten.size },
    read,
  };
}

export type RestoreProgress = { step: 'merging' } | { step: 'copying'; done: number; total: number };

export interface RestoreOutcome {
  /** When the restore finished (Unix ms). */
  at: number;
  /** Rows the backup added here. `notes` are threads; `comments` include "edited on another device" copies. */
  added: { readings: number; notes: number; marks: number; comments: number };
  /** Rows here that the backup brought up to date (the newer version won). */
  updated: number;
  /** Readings removed here for good that the backup still held, and were left out (R88). */
  forgotten: number;
  /** Rows of the backup that could not be used here, and were left out. */
  skipped: number;
  pdfs: {
    /** Copied from the backup, or already here and now kept. */
    copied: number;
    /** Not in the backup (or not the size the backup lists). */
    missing: number;
    /** In the backup, but its bytes are not the file it is named for: never kept. */
    damaged: number;
    /** Could not be copied (the folder went away, the disk is full). Restoring again tries them again. */
    failed: number;
  };
  /** The readings whose page text is read again in the background, most recently read first. */
  reindex: DocumentId[];
}

/** True when the restore wrote nothing and copied nothing: the library held everything already. */
export const changedNothing = (o: Pick<RestoreOutcome, 'added' | 'updated' | 'pdfs'>): boolean =>
  o.added.readings + o.added.notes + o.added.marks + o.added.comments + o.updated + o.pdfs.copied === 0;

const sum = (counts: RestoreSummary['updated']): number => Object.values(counts).reduce((n, v) => n + v, 0);

/** The readings of the backup, most recently read first (they become searchable first); readings never opened come last. */
export function readingOrder(dump: LibraryDump): DocumentId[] {
  const last = new Map(dump.tables.history.map((h) => [h.documentId as string, typeof h.lastOpened === 'number' ? h.lastOpened : 0]));
  return dump.tables.documents
    .map((d) => d.id)
    .filter(isSha)
    .sort((a, b) => (last.get(b) ?? -1) - (last.get(a) ?? -1) || (a < b ? -1 : a > b ? 1 : 0));
}

export interface ApplyDeps {
  store: Pick<StoreApi, 'applyRestorePlan' | 'getDocument' | 'markCopyRestored'>;
  blobs: BlobStore;
  onProgress(p: RestoreProgress): void;
  now(): number;
}

/** Merges the backup into the library, then copies the PDFs it lacks. Rejects only when the merge itself fails (then nothing changed). */
export async function applyBackup(read: ReadBackup, deps: ApplyDeps): Promise<RestoreOutcome> {
  deps.onProgress({ step: 'merging' });
  const result = await deps.store.applyRestorePlan(read.dump);
  const pdfs = { copied: 0, missing: 0, damaged: 0, failed: 0 };
  const wanted = result.needsPdf.filter(isSha);
  for (let i = 0; i < wanted.length; i++) {
    deps.onProgress({ step: 'copying', done: i, total: wanted.length });
    const id = wanted[i];
    try {
      // A reading the backup names that is an alias here, or already has its copy, needs nothing.
      const doc = await deps.store.getDocument(id);
      if (doc === null || doc.blobStored) continue;
      if (!(await deps.blobs.has(id))) {
        const file = await openBackupPdf(read.root, id, read.manifest);
        if (file === null) {
          pdfs.missing += 1;
          continue;
        }
        await deps.blobs.put(file, id); // hashed as it is written; another hash keeps nothing and throws
      }
      await deps.store.markCopyRestored(id);
      pdfs.copied += 1;
    } catch (error) {
      if (error instanceof BlobHashMismatchError) pdfs.damaged += 1;
      else pdfs.failed += 1;
    }
  }
  deps.onProgress({ step: 'copying', done: wanted.length, total: wanted.length });
  const a = result.summary.added;
  return {
    at: deps.now(),
    added: { readings: a.documents, notes: a.threads, marks: a.marks, comments: a.comments },
    updated: sum(result.summary.updated),
    forgotten: result.forgotten,
    skipped: result.skipped,
    pdfs,
    reindex: readingOrder(read.dump),
  };
}

// ---- words --------------------------------------------------------------------------------------------------------------

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** R88's line: "1 reading you removed here was left out" / "3 readings you removed here were left out". */
export const leftOutLine = (n: number): string => `${count(n, 'reading', 'readings')} you removed here ${n === 1 ? 'was' : 'were'} left out.`;

/** R101's line: a restore brings back readings, notes, tags and history, never a setting. */
export const SETTINGS_KEPT = 'Your settings were not changed.';

/** What a finished restore did, in short plain sentences, most important first. */
export function outcomeLines(o: Omit<RestoreOutcome, 'reindex'>): string[] {
  const lines: string[] = [];
  if (changedNothing(o)) lines.push('Everything in this backup is already in your library. Nothing changed.');
  else {
    // Comments are part of their notes; on their own (a reply, an "edited on another device" copy) they are named.
    const back = [
      o.added.readings > 0 ? count(o.added.readings, 'reading', 'readings') : '',
      o.added.notes > 0 ? count(o.added.notes, 'note', 'notes') : '',
      o.added.notes === 0 && o.added.comments > 0 ? count(o.added.comments, 'comment', 'comments') : '',
      o.added.marks > 0 ? count(o.added.marks, 'mark', 'marks') : '',
    ].filter(Boolean);
    if (back.length > 0) lines.push(`${back.length === 1 ? back[0] : `${back.slice(0, -1).join(', ')} and ${back.at(-1)}`} came back.`);
    if (o.updated > 0) lines.push(`${count(o.updated, 'item', 'items')} in your library ${o.updated === 1 ? 'was' : 'were'} brought up to date.`);
    if (o.pdfs.copied > 0) lines.push(`${count(o.pdfs.copied, 'PDF was', 'PDFs were')} copied back.`);
  }
  if (o.forgotten > 0) lines.push(leftOutLine(o.forgotten));
  if (o.pdfs.missing > 0) lines.push(`${count(o.pdfs.missing, 'PDF isn’t', 'PDFs aren’t')} in the backup. ${o.pdfs.missing === 1 ? 'Its reading and notes' : 'Their readings and notes'} came back without ${o.pdfs.missing === 1 ? 'it' : 'them'}.`);
  if (o.pdfs.damaged > 0) lines.push(`${count(o.pdfs.damaged, 'PDF', 'PDFs')} in the backup ${o.pdfs.damaged === 1 ? 'is' : 'are'} damaged, so ${o.pdfs.damaged === 1 ? 'it was' : 'they were'} not copied.`);
  if (o.pdfs.failed > 0) lines.push(`${count(o.pdfs.failed, 'PDF', 'PDFs')} couldn’t be copied. Restore again to try ${o.pdfs.failed === 1 ? 'it' : 'them'} again.`);
  if (o.skipped > 0) lines.push(`${count(o.skipped, 'item', 'items')} in the backup couldn’t be used here, so ${o.skipped === 1 ? 'it was' : 'they were'} left out.`);
  // R101: a restore never changes a setting (online lookups, "Always save from" and the rest stay as they are here).
  if (!changedNothing(o)) lines.push(SETTINGS_KEPT);
  return lines;
}
