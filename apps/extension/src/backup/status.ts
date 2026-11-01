// What the backup tells the owner, and the words it uses. Pure: no storage, no clock, no folder.
//
// The status record lives in IndexedDB `sop-handles` (handle-store.ts); the offscreen document writes it, and every page reads it.
// Nothing here names a file, a title or a document: a status is safe to show, log and keep.
import type { BackupCounts } from '@sop/core';

/**
 * Where the backup stands.
 *  - `off`: no folder chosen.
 *  - `idle`: a folder is chosen and the last run went well (or none has run yet).
 *  - `running`: a backup is being written now.
 *  - `waiting`: Chrome wants the owner to allow the folder again. The action icon shows a badge.
 *  - `held`: a run was stopped on purpose because writing could have lost something (see `held`). The folder was not changed.
 *  - `failed`: the last run did not finish. It is tried again later.
 */
export type BackupPhase = 'off' | 'idle' | 'running' | 'waiting' | 'held' | 'failed';

/** Why a run was held. */
export type HeldReason =
  /** The folder holds readings that this library does not have and never wrote there: probably another computer's backup, or a backup not restored yet. */
  | 'other-library'
  /** Many readings that were in the last backup are gone from the library: probably a problem here, not a clean-up. */
  | 'many-missing';

export interface BackupStatus {
  phase: BackupPhase;
  /** The chosen folder's name, for Settings. */
  folderName: string | null;
  /** When the last backup finished. */
  lastBackupAt: number | null;
  /** When the last run started (it may have failed). */
  lastAttemptAt: number | null;
  /** The size of the backup in the folder, in bytes. */
  bytes: number | null;
  counts: BackupCounts | null;
  held: HeldReason | null;
  /** Plain words about what is wrong; null when nothing is. */
  message: string | null;
  /** While `running`: PDF copies done of the total to check. */
  progress: { done: number; total: number } | null;
  /** Forgotten readings whose copies in the folder are not removed yet. */
  scrubsPending: number;
}

export const emptyStatus = (): BackupStatus => ({
  phase: 'off',
  folderName: null,
  lastBackupAt: null,
  lastAttemptAt: null,
  bytes: null,
  counts: null,
  held: null,
  message: null,
  progress: null,
  scrubsPending: 0,
});

// ---- the words ---------------------------------------------------------------------------------------------------------

export const WAITING_MESSAGE = 'Backup is waiting. Click to allow.';

export const HELD_MESSAGES: Readonly<Record<HeldReason, string>> = {
  'other-library':
    'This folder already holds a backup that isn’t from this library. It was left as it is. Restore from it, or choose a different folder.',
  'many-missing':
    'Many readings are missing from your library since the last backup. The backup was left as it is, so nothing is lost. If you removed them on purpose, back up anyway.',
};

export const FOLDER_GONE_MESSAGE = 'The backup folder can’t be found. Choose it again.';
export const FOLDER_FULL_MESSAGE = 'The backup folder is full. Free some space, then back up again.';
export const FOLDER_BUSY_MESSAGE = 'A file in the backup folder is in use. We’ll try again soon.';
export const SOMETHING_WRONG_MESSAGE = 'Something went wrong while writing the backup. We’ll try again soon.';
export const LIBRARY_UNREACHABLE_MESSAGE = 'Your library couldn’t be read for the backup. We’ll try again soon.';
export const READ_ONLY_MESSAGE = 'Update sickofpdfs first. This library was saved by a newer version.';

/** Why an error happened, in words fit for the owner. */
export type FailureKind = 'permission' | 'gone' | 'full' | 'busy' | 'library' | 'read-only' | 'other';

export function classifyFailure(error: unknown): FailureKind {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission';
  if (name === 'NotFoundError') return 'gone';
  if (name === 'QuotaExceededError') return 'full';
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError' || name === 'InvalidModificationError') return 'busy';
  if (/^read-only:/.test(message)) return 'read-only';
  if (/^(store-|bad-input|document-missing)/.test(message)) return 'library';
  return 'other';
}

export function failureMessage(kind: FailureKind): string {
  switch (kind) {
    case 'permission':
      return WAITING_MESSAGE;
    case 'gone':
      return FOLDER_GONE_MESSAGE;
    case 'full':
      return FOLDER_FULL_MESSAGE;
    case 'busy':
      return FOLDER_BUSY_MESSAGE;
    case 'library':
      return LIBRARY_UNREACHABLE_MESSAGE;
    case 'read-only':
      return READ_ONLY_MESSAGE;
    case 'other':
      return SOMETHING_WRONG_MESSAGE;
  }
}

const MIB = 1024 * 1024;

/** A size the way Drive writes it: "820 KB", "148 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  if (bytes < MIB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * MIB) return `${Math.round(bytes / MIB)} MB`;
  const gb = bytes / (1024 * MIB);
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today at 2:05 am", "yesterday at 11:40 pm", "12 Oct at 9:15 am". */
export function whenWords(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  const time = TIME.format(d).replace(/\s+/g, ' ').toLowerCase();
  if (sameDay(d, n)) return `today at ${time}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return `yesterday at ${time}`;
  return `${DAY.format(d)} at ${time}`;
}

/** The one line in Settings' backup row: "Today at 2:05 am · 148 MB". */
export function summaryLine(s: BackupStatus, now: number): string {
  switch (s.phase) {
    case 'off':
      return 'Backup is off. Choose a folder to start.';
    case 'running':
      return s.progress !== null && s.progress.total > 0 ? `Backing up… ${s.progress.done} of ${s.progress.total} PDFs checked` : 'Backing up…';
    case 'waiting':
      return WAITING_MESSAGE;
    case 'held':
    case 'failed':
      return s.message ?? SOMETHING_WRONG_MESSAGE;
    case 'idle': {
      if (s.lastBackupAt === null) return 'Ready. The first backup is on its way.';
      const size = s.bytes === null ? '' : ` · ${formatBytes(s.bytes)}`;
      const when = whenWords(s.lastBackupAt, now);
      return `${when.charAt(0).toUpperCase()}${when.slice(1)}${size}`;
    }
  }
}

/** The name of that row: what the line is about. */
export function summaryLabel(s: BackupStatus): string {
  if (s.phase === 'idle' && s.lastBackupAt !== null) return 'Last backup';
  return 'Backup';
}
