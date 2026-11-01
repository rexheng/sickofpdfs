// Nightly snapshots of `library.json` (contracts §5, open decision D6): `snapshots/library-<YYYY-MM-DD>.json`, the last 7 kept.
// Pure: the caller lists the folder, asks for a plan, writes the new file, and only then deletes the ones named to remove.
import { SNAPSHOT_KEEP } from './format';

export interface SnapshotPlan {
  /** Today's snapshot, for example `library-2026-11-01.json`. Writing it again on the same day replaces it. */
  write: string;
  /** Old snapshots to delete once today's is written. Exactly as they were listed. Only files that are snapshots are ever named here. */
  remove: string[];
  /** What is left, newest first, today's included (bare file names). */
  keep: string[];
}

const NAME = /^library-(\d{4})-(\d{2})-(\d{2})\.json$/;

/** True for a real calendar day. */
function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/** The `YYYY-MM-DD` of a snapshot file name (a bare name or a path ending in one), or null when it is not one of ours. */
export function parseSnapshotName(name: string): string | null {
  if (typeof name !== 'string') return null;
  const bare = name.split(/[\\/]/).pop() ?? '';
  const m = NAME.exec(bare);
  if (!m) return null;
  return validDay(Number(m[1]), Number(m[2]), Number(m[3])) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export const snapshotName = (day: string): string => `library-${day}.json`;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/**
 * The calendar day of `today` as `YYYY-MM-DD`. A `Date` or a time in ms gives the day on this computer's clock (the owner's
 * "tonight"); a string that already is `YYYY-MM-DD` is used as it is.
 */
export function dayOf(today: Date | number | string): string {
  if (typeof today === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today.trim());
    if (m && validDay(Number(m[1]), Number(m[2]), Number(m[3]))) return today.trim();
    const parsed = new Date(today);
    if (Number.isNaN(parsed.getTime())) throw new RangeError('today is not a date');
    return dayOf(parsed);
  }
  const d = typeof today === 'number' ? new Date(today) : today;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new RangeError('today is not a date');
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * What to write and what to delete so that the folder keeps the last 7 snapshots, today's among them.
 * `names` is what `snapshots/` holds now. Files that are not named like a snapshot are never touched, so a note the owner left
 * there is safe. Newer-dated files (a clock that was wrong) count as the newest, but today's is always kept.
 */
export function planSnapshots(names: readonly string[], today: Date | number | string, keepCount: number = SNAPSHOT_KEEP): SnapshotPlan {
  const day = dayOf(today);
  const write = snapshotName(day);
  const listed = new Map<string, string[]>(); // day -> the names as listed
  for (const n of names) {
    const d = parseSnapshotName(n);
    if (d === null) continue;
    const list = listed.get(d);
    if (list) list.push(n);
    else listed.set(d, [n]);
  }
  const days = [...new Set([...listed.keys(), day])].sort().reverse();
  const keepDays = new Set(days.slice(0, Math.max(1, keepCount)));
  keepDays.add(day);
  if (keepDays.size > Math.max(1, keepCount)) {
    // today's fell outside the newest few (files dated in the future): it replaces the oldest of them
    const oldest = days.filter((d) => keepDays.has(d) && d !== day).pop();
    if (oldest !== undefined) keepDays.delete(oldest);
  }
  const remove: string[] = [];
  for (const d of days) if (!keepDays.has(d)) remove.push(...(listed.get(d) ?? []));
  return { write, remove, keep: days.filter((d) => keepDays.has(d)).map(snapshotName) };
}
