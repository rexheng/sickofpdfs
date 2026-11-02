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

/** Why a run was held (R86). */
export type HeldReason =
  /** The folder holds readings that this library does not have and never wrote there: probably another computer's backup, or a backup not restored yet. */
  | 'other-library'
  /** The folder's `library.json` is there but cannot be read (damaged, cut short by a sync tool): it may be the only copy of something. */
  | 'unreadable'
  /** Readings that were in the last backup are gone from the library without being removed on purpose (every one, or many at once). */
  | 'many-missing'
  /** Many notes that were in the last backup are gone from the library (at least 20, and at least half). */
  | 'notes-missing';

/** Removals that were given up (R88): the old folder no longer exists, or they waited 30 days. Settings says so until the owner clears it. */
export interface DroppedRemovals {
  folderName: string;
  count: number;
  reason: 'gone' | 'expired';
  at: number;
}

/** A folder the owner moved away from, with removals still waiting for it (handle-store.ts `retired`). */
export interface RetiredSummary {
  id: number;
  folderName: string;
  /** Readings still to be removed from that folder. */
  count: number;
}

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
  /**
   * Files in the backup folder that the last removal could not read (paths inside `sickofpdfs-backup`, such as
   * `snapshots/library-2026-10-30.json`). They are left as they are, and the removal is tried again at each run.
   */
  unreadable: string[];
  /** Folders the owner moved away from with removals still waiting for them. Filled in when a page reads the status (client.ts). */
  retired: RetiredSummary[];
  /** Removals that were given up (R88), until the owner clears the line in Settings. */
  dropped: DroppedRemovals[];
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
  unreadable: [],
  retired: [],
  dropped: [],
});

// ---- the words ---------------------------------------------------------------------------------------------------------

export const WAITING_MESSAGE = 'Backup is waiting. Click to allow.';

/** Why the backup is on hold, in plain words (Settings, the pill's popover). The folder was not changed. */
export const HELD_MESSAGES: Readonly<Record<HeldReason, string>> = {
  'other-library': 'This folder already holds a backup that isn’t from this library. It was left as it is.',
  unreadable: 'The library file in the backup folder can’t be read. It was left as it is, in case it is the only copy of something.',
  'many-missing': 'Some readings are missing from your library, but your backup still has them.',
  'notes-missing': 'Many notes that were in your last backup are missing from your library. The backup was left as it is, so nothing is lost.',
};

/** What "Back up anyway" will do, for each hold. */
export const ANYWAY_MESSAGES: Readonly<Record<HeldReason, string>> = {
  'other-library': 'Back up anyway replaces that backup with this library. To keep it, choose a different folder.',
  unreadable: 'Back up anyway replaces that file with this library. The daily copies in the folder stay.',
  // R87, word for word with the line above: a lost reading's copies are never deleted, forced or not.
  'many-missing': 'To get them back, use Restore from backup. Back up anyway keeps their copies in the folder.',
  'notes-missing': 'If you deleted them on purpose, back up anyway. The daily copies in the folder keep them for a week.',
};

/** The toolbar icon's tooltip while a backup is on hold (R86). */
export const HELD_TITLES: Readonly<Record<HeldReason, string>> = {
  'other-library': 'Backup is on hold: the folder holds another library’s backup. Open your library to choose.',
  unreadable: 'Backup is on hold: the backup file in the folder can’t be read. Open your library to choose.',
  'many-missing': 'Backup is on hold: readings are missing from your library. Open your library to choose.',
  'notes-missing': 'Backup is on hold: many notes are missing from your library. Open your library to choose.',
};

/** What the toolbar badge shows: nothing, "waiting for a click", or "on hold" and why (R86). */
export type BadgeState = { attention: null } | { attention: 'waiting' } | { attention: 'held'; held: HeldReason };

export const badgeOf = (s: Pick<BackupStatus, 'phase' | 'held'>): BadgeState =>
  s.phase === 'waiting' ? { attention: 'waiting' } : s.phase === 'held' && s.held !== null ? { attention: 'held', held: s.held } : { attention: null };

export const sameBadge = (a: BadgeState, b: BadgeState): boolean => a.attention === b.attention && (a.attention !== 'held' || (b.attention === 'held' && a.held === b.held));

/** What the Forget dialog says when the folder was cleaned except for a file that cannot be read. */
export const UNREADABLE_SCRUB_MESSAGE =
  'Removed from your library. One file in your backup folder can’t be read, so it was left as it is and may still name this PDF.';

/** "1 removal is waiting for Backups." The line Settings shows for a folder the owner moved away from. */
export const retiredLine = (r: Pick<RetiredSummary, 'count' | 'folderName'>): string =>
  `${r.count === 1 ? '1 removal is' : `${r.count} removals are`} waiting for ${r.folderName}.`;

/** What "Try now" says when an old folder could not be found and its removal was dropped. */
export const DROPPED_MESSAGE = 'The old backup folder can’t be found any more, so the removal waiting for it was dropped.';

/** The line Settings shows for removals that were given up (R88). */
export function droppedLine(d: Pick<DroppedRemovals, 'folderName' | 'count' | 'reason'>): string {
  const what = d.count === 1 ? '1 removal' : `${d.count} removals`;
  return d.reason === 'gone'
    ? `The old backup folder ${d.folderName} can’t be found any more, so ${what} waiting for it ${d.count === 1 ? 'was' : 'were'} dropped.`
    : `${what} waiting for ${d.folderName} ${d.count === 1 ? 'was' : 'were'} dropped after 30 days.`;
}

/** The line Settings shows when a removal found files it could not read. */
export function unreadableLine(paths: readonly string[]): string {
  const files = paths.length === 1 ? `This file in the backup folder can’t be read: ${paths[0]}.` : `These files in the backup folder can’t be read: ${paths.join(', ')}.`;
  return `A removal couldn’t finish. ${files} ${paths.length === 1 ? 'It was' : 'They were'} left as ${paths.length === 1 ? 'it is' : 'they are'}. It is tried again at each backup.`;
}

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
