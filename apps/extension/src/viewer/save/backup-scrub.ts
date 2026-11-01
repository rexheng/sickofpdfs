// R75 (privacy): forgetting a PDF also takes it out of every backup snapshot in the backup folder. The backup writer (S13)
// does the cleaning; this is where it plugs in for the viewer's Forget. Until it registers, there are no backups to clean.
//
// The hook gets the forgotten document's id only. It answers:
// - 'cleaned':   every snapshot in the folder was rewritten without it (its rows, notes, page text and PDF copy);
// - 'pending':   the folder could not be reached (offline, or its permission was lost); the next backup run tries again;
// - 'no-backup': no backup folder is set up, so there is nothing to clean.
import type { DocumentId } from '@sop/core';

export type BackupScrubResult = 'cleaned' | 'pending' | 'no-backup';
export type BackupScrub = (documentId: DocumentId) => Promise<BackupScrubResult>;

let registered: BackupScrub | null = null;

/** S13 registers its scrub here (one line), for the viewer's Forget. Null takes it away again. */
export function registerBackupScrub(scrub: BackupScrub | null): void {
  registered = scrub;
}

/** Cleans `documentId` out of the backups. A failure is "pending": the next backup run finishes the job. */
export async function scrubBackups(documentId: DocumentId): Promise<BackupScrubResult> {
  if (registered === null) return 'no-backup';
  try {
    return await registered(documentId);
  } catch {
    return 'pending';
  }
}
