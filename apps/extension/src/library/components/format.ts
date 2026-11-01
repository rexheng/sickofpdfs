// Plain words and dates for the library's rows and cards. Dates follow the browser's language, as Drive's do: the time
// for today, the day and month this year, the full date before that.
import type { LibraryItem } from '../data/types';

/** What a reading is called: its title, else the file name it was opened from, else "Untitled PDF". */
export function readingTitle(item: LibraryItem): string {
  const title = item.doc.title?.trim();
  if (title !== undefined && title !== '') return title;
  const raw = item.location?.raw;
  if (raw !== undefined) {
    try {
      const last = new URL(raw).pathname.split('/').filter(Boolean).pop();
      if (last !== undefined) return decodeURIComponent(last);
    } catch {
      // not a link we can read: fall through
    }
  }
  return 'Untitled PDF';
}

const surname = (name: string) => name.trim().split(/\s+/).pop() ?? name;

/** "Vaswani et al.", "Callaway and Sant'Anna", "Axler"; "—" when the authors are not known. */
export function formatAuthors(authors: readonly string[]): string {
  const names = authors.map((a) => a.trim()).filter(Boolean);
  if (names.length === 0) return '—';
  if (names.length === 1) return names[0] ?? '—';
  if (names.length === 2) return `${surname(names[0] ?? '')} and ${surname(names[1] ?? '')}`;
  return `${surname(names[0] ?? '')} et al.`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** Drive's date column: "10:41" today, "6 Jan" this year, "25 Jun 2022" before. */
export function formatDate(t: number, now: number = Date.now()): string {
  if (t >= startOfDay(now)) return time.format(t);
  if (new Date(t).getFullYear() === new Date(now).getFullYear()) return dayMonth.format(t);
  return fullDate.format(t);
}

/** The full date and time, for a tooltip. */
export function formatDateLong(t: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(t);
}

/** "1 h 35 min", "22 min", "Under a minute". */
export function formatReadingTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'Under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Drive's Recent headings, newest first. */
export const RECENT_GROUPS = [
  'Today',
  'Yesterday',
  'Earlier this week',
  'Last week',
  'Earlier this month',
  'Last month',
  'Earlier this year',
  'Older',
] as const;
export type RecentGroup = (typeof RECENT_GROUPS)[number];

/** Which of Recent's headings a time falls under. Weeks start on Monday; each heading takes what the ones above leave. */
export function recentGroup(t: number, now: number = Date.now()): RecentGroup {
  const today = startOfDay(now);
  const n = new Date(now);
  const day = (offset: number) => new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset).getTime();
  const weekday = (n.getDay() + 6) % 7; // Monday 0 … Sunday 6
  if (t >= today) return 'Today';
  if (t >= day(-1)) return 'Yesterday';
  if (t >= day(-weekday)) return 'Earlier this week';
  if (t >= day(-weekday - 7)) return 'Last week';
  if (t >= new Date(n.getFullYear(), n.getMonth(), 1).getTime()) return 'Earlier this month';
  if (t >= new Date(n.getFullYear(), n.getMonth() - 1, 1).getTime()) return 'Last month';
  if (t >= new Date(n.getFullYear(), 0, 1).getTime()) return 'Earlier this year';
  return 'Older';
}

/** "1 page", "45 pages". */
export function formatPages(n: number): string {
  return n === 1 ? '1 page' : `${n} pages`;
}

/** "1 note", "14 notes". */
export function formatNotes(n: number): string {
  return n === 1 ? '1 note' : `${n} notes`;
}
