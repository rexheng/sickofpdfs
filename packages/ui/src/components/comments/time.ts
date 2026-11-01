/**
 * The time under a comment author, written the way Google Docs writes it: "9:24 PM Today", "9:24 PM Sep 28" this year,
 * "Dec 3, 2025" for an older year. Hours and month names follow the browser's language ("21:24 28 Sept" in en-GB).
 */
export function formatCommentTime(at: number, now: number, locale?: string): string {
  const when = new Date(at);
  const today = new Date(now);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(when);
  if (sameDay(when, today)) return `${time} Today`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(when, yesterday)) return `${time} Yesterday`;
  if (when.getFullYear() === today.getFullYear()) {
    return `${time} ${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(when)}`;
  }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(when);
}

/** The full date and time, for the tooltip and for screen readers. */
export function formatCommentTimeFull(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(at));
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
