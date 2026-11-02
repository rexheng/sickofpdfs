// "Forget this PDF" removes the reading from the backups too (ruling R75). This is the hook the Forget flow (S11's ForgetDialog) calls
// after the library has forgotten the reading: `forgetFromBackups(documentId)`. It is a module of its own, with no store client and no zip
// code, so the viewer can import it without growing.
import type { DocumentId } from '@sop/core';
import { openHandleStore, type HandleStore } from './handle-store';
import { ask, newRequestId, type ScrubSummary } from './rpc';

let handles: Promise<HandleStore> | null = null;
const handlesOf = (): Promise<HandleStore> => (handles ??= openHandleStore());

/** What the Forget dialog says when the copies in the backup folder are gone too. Drive and OneDrive keep deleted files in their own trash. */
export const FORGOTTEN_EVERYWHERE = 'Removed from your library and your backups. Google Drive or OneDrive may keep their own copy in their trash for a while.';
/** What it says when the backup folder could not be reached yet. */
export const FORGOTTEN_BACKUP_PENDING = 'Removed from your library. Your backup folder can’t be reached yet, so it will be cleaned at the next backup.';
/** What it says when there is no backup folder. */
export const FORGOTTEN_LIBRARY_ONLY = 'Removed from your library';

export type ForgetBackupResult =
  /** No backup folder is chosen: nothing to remove. */
  | { status: 'no-backup'; message: string }
  /** The reading is gone from the folder, from `library.json`, and from every snapshot. */
  | { status: 'removed'; message: string }
  /** The folder could not be reached or written. The request is kept and is done at the next backup run. */
  | { status: 'pending'; message: string };

/** How long the Forget dialog waits for the writer before it says "at the next backup". */
const FORGET_WAIT_MS = 8000;

/**
 * Removes a forgotten reading from the backup folder: its PDF copy, its notes file, and its rows in `library.json`, every
 * snapshot and the manifest. Call it after the library has forgotten the reading (`store.forgetDocument`).
 *
 * It never throws and never loses the request: the id is written to `sop-handles` first, and stays there until the folder is clean,
 * so a folder that is offline (or whose permission is lost) is cleaned at the next backup run. The caller shows `message` as it is.
 * It never writes to the library and never reads a secret.
 */
export async function forgetFromBackups(documentId: DocumentId): Promise<ForgetBackupResult> {
  try {
    const h = await handlesOf();
    if ((await h.getTarget()) === null) return { status: 'no-backup', message: FORGOTTEN_LIBRARY_ONLY };
    await h.addScrub(documentId, Date.now());
    const reply = await ask<ScrubSummary>({ type: 'scrub', id: newRequestId(), documentId }, FORGET_WAIT_MS);
    if (reply?.status === 'removed') return { status: 'removed', message: FORGOTTEN_EVERYWHERE };
    if (reply?.status === 'no-backup') return { status: 'no-backup', message: FORGOTTEN_LIBRARY_ONLY };
    // A file that names it cannot be read: the dialog says that plainly (the removal stays pending and is tried again).
    if (reply?.status === 'pending' && reply.reason === 'unreadable') return { status: 'pending', message: reply.message };
    return { status: 'pending', message: FORGOTTEN_BACKUP_PENDING };
  } catch {
    return { status: 'pending', message: FORGOTTEN_BACKUP_PENDING };
  }
}

