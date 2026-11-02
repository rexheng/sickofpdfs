// Reading a backup folder for "Restore from backup" (S17 builds the dialog; this is the part that touches the folder). It reads, and
// never writes: the folder is the owner's backup, and a restore must never change it.
//
// Rules this file keeps (carried from the backup security read):
// - Nothing is read without a size check first: `manifest.json`, `library.json` and each PDF have a cap, so a damaged or crafted folder
//   cannot make the page read gigabytes into memory.
// - A folder with no readable `library.json` is refused, in plain words. The snapshots are not used in its place: a restore that
//   picked one silently could bring back a reading that a Forget removed from `library.json` but not yet from an old snapshot.
// - A backup written by a newer version is refused with "Update sickofpdfs first" (contracts §5).
// - A PDF copy is offered only when its name is a fingerprint and its size is the manifest's; the caller still checks the fingerprint of
//   the bytes as it stores them (S17).
// - Paths are built from fingerprints only (`pdfPath`), so nothing in the folder can point the reader elsewhere.
// Then `store.applyRestorePlan(dump)` plans and writes the merge in one transaction, leaving out forgotten readings (backup-api.ts).
import { BACKUP_DIR, BackupFormatError, isSha, LIBRARY_PATH, MANIFEST_PATH, parseLibraryDump, parseManifest, pdfPath, type BackupManifest, type LibraryDump } from '@sop/core';
import { openDir, openFile } from './fs';

/** The biggest `manifest.json` read. It holds one size per PDF, so even 100,000 PDFs fit easily. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** The biggest `library.json` read: far above any library this version writes (18,000 notes come to a few megabytes). */
export const MAX_LIBRARY_BYTES = 256 * 1024 * 1024;
/** The biggest PDF copy taken from a backup. Files over 1 GiB open in Chrome's own viewer and are never saved (spec). */
export const MAX_PDF_BYTES = 1024 * 1024 * 1024;

export const NO_BACKUP_MESSAGE = 'This folder doesn’t hold a sickofpdfs backup. Choose the folder that has “sickofpdfs-backup” in it.';
export const NO_LIBRARY_MESSAGE = 'The library file in this backup can’t be read, so nothing was restored.';
export const TOO_BIG_MESSAGE = 'This backup is bigger than any sickofpdfs makes, so nothing was restored.';

export type BackupRead =
  | { ok: true; manifest: BackupManifest; dump: LibraryDump; /** The `sickofpdfs-backup` folder, for `openBackupPdf`. */ root: FileSystemDirectoryHandle }
  | { ok: false; reason: 'no-backup' | 'no-library' | 'too-big' | 'too-new' | 'damaged'; message: string };

/** A file's text, or a refusal when it is missing or bigger than `max`. */
async function readCapped(root: FileSystemDirectoryHandle, path: string, max: number): Promise<{ text: string } | { missing: true } | { tooBig: true }> {
  const file = await openFile(root, path);
  if (file === null) return { missing: true };
  if (file.size > max) return { tooBig: true };
  return { text: await file.text() };
}

/**
 * Reads the backup in `folder`: the folder the owner picked (with `sickofpdfs-backup` inside), or that folder itself. Never throws for
 * a bad folder: the answer says why, in words fit to show as they are. It throws only when the folder cannot be read at all
 * (permission, a folder that is gone), as every folder call does.
 */
export async function readBackupFolder(folder: FileSystemDirectoryHandle): Promise<BackupRead> {
  const root = (await openFile(folder, MANIFEST_PATH)) !== null ? folder : await openDir(folder, BACKUP_DIR);
  if (root === null) return { ok: false, reason: 'no-backup', message: NO_BACKUP_MESSAGE };

  const manifestText = await readCapped(root, MANIFEST_PATH, MAX_MANIFEST_BYTES);
  if ('missing' in manifestText) return { ok: false, reason: 'no-backup', message: NO_BACKUP_MESSAGE };
  if ('tooBig' in manifestText) return { ok: false, reason: 'too-big', message: TOO_BIG_MESSAGE };
  let manifest: BackupManifest;
  try {
    manifest = parseManifest(manifestText.text);
  } catch (error) {
    if (error instanceof BackupFormatError && error.code === 'too-new') return { ok: false, reason: 'too-new', message: error.message };
    if (error instanceof BackupFormatError && error.code === 'not-a-backup') return { ok: false, reason: 'no-backup', message: NO_BACKUP_MESSAGE };
    return { ok: false, reason: 'damaged', message: NO_LIBRARY_MESSAGE };
  }

  const libraryText = await readCapped(root, LIBRARY_PATH, MAX_LIBRARY_BYTES);
  if ('tooBig' in libraryText) return { ok: false, reason: 'too-big', message: TOO_BIG_MESSAGE };
  if ('missing' in libraryText || libraryText.text.trim() === '') return { ok: false, reason: 'no-library', message: NO_LIBRARY_MESSAGE };
  try {
    return { ok: true, manifest, dump: parseLibraryDump(libraryText.text), root };
  } catch {
    return { ok: false, reason: 'no-library', message: NO_LIBRARY_MESSAGE };
  }
}

/**
 * The backup's copy of one PDF, or null when it is not there, its name is not a fingerprint, its size is not the manifest's, or it is
 * bigger than `MAX_PDF_BYTES`. The caller checks the bytes' fingerprint as it stores them.
 */
export async function openBackupPdf(root: FileSystemDirectoryHandle, sha: string, manifest: BackupManifest): Promise<File | null> {
  if (!isSha(sha)) return null;
  const expected = manifest.pdfs[sha];
  if (expected === undefined || expected > MAX_PDF_BYTES) return null;
  const file = await openFile(root, pdfPath(sha));
  return file !== null && file.size === expected ? file : null;
}
