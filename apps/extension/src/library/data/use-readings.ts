import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryData, LibraryItem, LibraryQuery } from './types';

/** How many readings one request asks for. The first page of a big library comes in one go (contract target 300 ms). */
export const PAGE_SIZE = 100;

export type ReadingsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: LibraryItem[]; total: number; nextCursor: string | null };

export interface Readings {
  state: ReadingsState;
  /** Asks for the next page, if there is one and none is on its way. */
  loadMore(this: void): void;
  retry(this: void): void;
}

/**
 * The readings `query` names, page by page, kept up to date: any change in the library (from this tab or another)
 * asks again for as many as are shown, so a star or a move to Trash shows at once and the list does not jump back.
 */
export function useReadings(data: LibraryData, query: Omit<LibraryQuery, 'limit' | 'cursor'>): Readings {
  const [state, setState] = useState<ReadingsState>({ kind: 'loading' });
  const key = JSON.stringify(query);
  const shown = useRef(PAGE_SIZE);
  const busy = useRef(false);
  const generation = useRef(0);

  const fetchFirst = useCallback(
    (limit: number) => {
      const mine = ++generation.current;
      busy.current = true;
      data.listDocuments({ ...(JSON.parse(key) as Omit<LibraryQuery, 'limit'>), limit }).then(
        (page) => {
          if (mine !== generation.current) return;
          busy.current = false;
          setState({ kind: 'ready', items: page.items, total: page.total, nextCursor: page.nextCursor });
        },
        () => {
          if (mine !== generation.current) return;
          busy.current = false;
          setState({ kind: 'error' });
        },
      );
    },
    [data, key],
  );

  useEffect(() => {
    shown.current = PAGE_SIZE;
    setState({ kind: 'loading' });
    fetchFirst(PAGE_SIZE);
  }, [fetchFirst]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = data.onChange(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => fetchFirst(shown.current), 50);
    });
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [data, fetchFirst]);

  const loadMore = useCallback(() => {
    if (busy.current || state.kind !== 'ready' || state.nextCursor === null) return;
    const mine = generation.current;
    busy.current = true;
    data.listDocuments({ ...(JSON.parse(key) as Omit<LibraryQuery, 'limit'>), limit: PAGE_SIZE, cursor: state.nextCursor }).then(
      (page) => {
        if (mine !== generation.current) return;
        busy.current = false;
        setState((s) => {
          if (s.kind !== 'ready') return s;
          const items = [...s.items, ...page.items];
          shown.current = Math.max(PAGE_SIZE, items.length);
          return { kind: 'ready', items, total: page.total, nextCursor: page.nextCursor };
        });
      },
      () => {
        if (mine === generation.current) busy.current = false;
      },
    );
  }, [data, key, state]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    fetchFirst(shown.current);
  }, [fetchFirst]);

  return { state, loadMore, retry };
}
