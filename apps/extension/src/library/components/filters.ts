import type { DocumentRow } from '@sop/core';
import type { LibraryQuery } from '../data/types';

export type Kind = DocumentRow['kind'];

export const KIND_LABELS: Record<Kind, string> = { paper: 'Papers', book: 'Books', slides: 'Slides', other: 'Other' };
export const KINDS: readonly Kind[] = ['paper', 'book', 'slides', 'other'];

export type OpenedRange = 'today' | 'week' | 'month' | 'year' | 'last-year';
export const OPENED_LABELS: Record<OpenedRange, string> = {
  today: 'Today',
  week: 'Last 7 days',
  month: 'Last 30 days',
  year: 'This year',
  'last-year': 'Last year',
};
export const OPENED_RANGES: readonly OpenedRange[] = ['today', 'week', 'month', 'year', 'last-year'];

export interface Filters {
  kinds: Kind[];
  hasNotes: boolean;
  opened: OpenedRange | null;
}

export const NO_FILTERS: Filters = { kinds: [], hasNotes: false, opened: null };

export const isFiltered = (f: Filters) => f.kinds.length > 0 || f.hasNotes || f.opened !== null;

const DAY = 86_400_000;

/** The contract's filter for these choices. Date ranges are worked out from `now`. */
export function toQueryFilter(f: Filters, now: number = Date.now()): NonNullable<LibraryQuery['filter']> {
  const out: NonNullable<LibraryQuery['filter']> = {};
  if (f.kinds.length > 0) out.kind = [...f.kinds];
  if (f.hasNotes) out.hasNotes = true;
  if (f.opened !== null) {
    const d = new Date(now);
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const thisYear = new Date(d.getFullYear(), 0, 1).getTime();
    switch (f.opened) {
      case 'today':
        out.readFrom = today;
        break;
      case 'week':
        out.readFrom = now - 7 * DAY;
        break;
      case 'month':
        out.readFrom = now - 30 * DAY;
        break;
      case 'year':
        out.readFrom = thisYear;
        break;
      case 'last-year':
        out.readFrom = new Date(d.getFullYear() - 1, 0, 1).getTime();
        out.readTo = thisYear - 1;
        break;
    }
  }
  return out;
}
