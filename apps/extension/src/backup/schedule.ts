// When a backup runs (spec: "every night, and after each session with new notes"; plan S13). Pure: it is given the time and
// what happened last, and answers "run now, and why" or "wake me at". The controller (controller.ts) owns the timers.
//
//  - Every night: the first run after 02:00 on this computer's clock, whether Chrome was open at 02:00 or started later
//    (a catch-up when a night was missed).
//  - After a session with new notes: when notes changed, the library has been quiet for a minute (or the changes have gone on for
//    half an hour), and the last run was at least 10 minutes ago.
//  - After a run that failed, no sooner than 30 minutes later. After a run that was held (backup.ts guards), no sooner than 6 hours later.
//
// A backup that is waiting for the owner's click (permission) is not scheduled at all: the controller waits for the permission.

/** The hour of the night (local time) after which the nightly backup is due. */
export const NIGHT_HOUR = 2;
/** The least time between two runs started by new notes. */
export const NOTES_GAP_MS = 10 * 60_000;
/** How long the notes must stay unchanged before a run starts. */
export const NOTES_QUIET_MS = 60_000;
/** A run starts after this long of steady changes, even without a quiet moment. */
export const NOTES_CAP_MS = 30 * 60_000;
export const RETRY_FAILED_MS = 30 * 60_000;
export const RETRY_HELD_MS = 6 * 60 * 60_000;

/** The latest 02:00 (local time) that is not after `now`. */
export function nightMark(now: number): number {
  const d = new Date(now);
  const mark = new Date(d.getFullYear(), d.getMonth(), d.getDate(), NIGHT_HOUR, 0, 0, 0).getTime();
  if (mark <= now) return mark;
  const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, NIGHT_HOUR, 0, 0, 0);
  return y.getTime();
}

/** The next 02:00 (local time) after `now`. */
export function nextNightMark(now: number): number {
  const d = new Date(now);
  const mark = new Date(d.getFullYear(), d.getMonth(), d.getDate(), NIGHT_HOUR, 0, 0, 0).getTime();
  if (mark > now) return mark;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, NIGHT_HOUR, 0, 0, 0).getTime();
}

export type LastOutcome = 'ok' | 'failed' | 'held' | null;

export interface ScheduleInput {
  now: number;
  /** When the last backup finished. */
  lastSuccessAt: number | null;
  /** When the last run started. */
  lastAttemptAt: number | null;
  lastOutcome: LastOutcome;
  /** When notes first changed after the last run started (null: they have not). */
  notesDirtySince: number | null;
  /** When notes last changed. */
  notesChangedAt: number | null;
}

export type Decision = { run: true; why: 'night' | 'notes' } | { run: false; wakeAt: number | null };

export function decide(i: ScheduleInput): Decision {
  const { now } = i;
  const sinceAttempt = i.lastAttemptAt === null ? Number.POSITIVE_INFINITY : now - i.lastAttemptAt;
  const retryGap = i.lastOutcome === 'failed' ? RETRY_FAILED_MS : i.lastOutcome === 'held' ? RETRY_HELD_MS : 0;
  const retryAt = i.lastAttemptAt === null ? now : i.lastAttemptAt + retryGap;
  const wakes: number[] = [];

  // The night.
  const nightDue = i.lastSuccessAt === null || i.lastSuccessAt < nightMark(now);
  if (nightDue) {
    if (sinceAttempt >= retryGap) return { run: true, why: 'night' };
    wakes.push(retryAt);
  } else {
    wakes.push(nextNightMark(now));
  }

  // New notes.
  if (i.notesDirtySince !== null && i.notesChangedAt !== null) {
    const earliest = Math.max(retryAt, i.lastAttemptAt === null ? now : i.lastAttemptAt + NOTES_GAP_MS);
    const ready = Math.min(i.notesChangedAt + NOTES_QUIET_MS, i.notesDirtySince + NOTES_CAP_MS);
    const at = Math.max(earliest, ready);
    if (at <= now) return { run: true, why: 'notes' };
    wakes.push(at);
  }

  const future = wakes.filter((t) => t > now);
  return { run: false, wakeAt: future.length > 0 ? Math.min(...future) : null };
}
