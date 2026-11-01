import type { LibraryQuery } from '../data/types';

export type Sort = LibraryQuery['sort'];
export type SortBy = Sort['by'];

export const SORT_LABELS: Record<SortBy, string> = { title: 'Title', lastOpened: 'Last opened', added: 'Date added', pages: 'Pages' };

/** The way each field reads best first: titles A to Z, dates newest first, pages fewest first. */
export const NATURAL_DIR: Record<SortBy, Sort['dir']> = { title: 'asc', lastOpened: 'desc', added: 'desc', pages: 'asc' };

/** The two directions in plain words, for the Sort menu. */
export function directionLabels(by: SortBy): Record<Sort['dir'], string> {
  switch (by) {
    case 'title':
      return { asc: 'A to Z', desc: 'Z to A' };
    case 'pages':
      return { asc: 'Fewest pages first', desc: 'Most pages first' };
    default:
      return { asc: 'Oldest first', desc: 'Newest first' };
  }
}

/** A header click: the same column turns the order round; another column sorts by it, its natural way first. */
export function nextSort(current: Sort, by: SortBy): Sort {
  if (current.by === by) return { by, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { by, dir: NATURAL_DIR[by] };
}
