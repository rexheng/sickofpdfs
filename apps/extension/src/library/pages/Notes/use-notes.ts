// The notes a Notes page tab (or Home's "Recent notes") shows, page by page, kept up to date: a change to any note or
// reading, in this tab or another, asks again for as many as are shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NoteItem, NotesQuery } from '../../data/pages-data';
import type { LibraryData } from '../../data/types';

export type NotesState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; items: NoteItem[]; nextCursor: string | null };

export interface Notes {
  state: NotesState;
  loadMore(this: void): void;
  retry(this: void): void;
}

export function useNotes(data: LibraryData, query: Omit<NotesQuery, 'limit' | 'cursor'>, pageSize = 50): Notes {
  const [state, setState] = useState<NotesState>({ kind: 'loading' });
  const key = JSON.stringify(query);
  const shown = useRef(pageSize);
  const busy = useRef(false);
  const generation = useRef(0);

  const fetchFirst = useCallback(
    (limit: number) => {
      const mine = ++generation.current;
      busy.current = true;
      data.listNotes({ ...(JSON.parse(key) as Omit<NotesQuery, 'limit'>), limit }).then(
        (page) => {
          if (mine !== generation.current) return;
          busy.current = false;
          setState({ kind: 'ready', items: page.items, nextCursor: page.nextCursor });
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
    shown.current = pageSize;
    setState({ kind: 'loading' });
    fetchFirst(pageSize);
  }, [fetchFirst, pageSize]);

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
    data.listNotes({ ...(JSON.parse(key) as Omit<NotesQuery, 'limit'>), limit: pageSize, cursor: state.nextCursor }).then(
      (page) => {
        if (mine !== generation.current) return;
        busy.current = false;
        setState((s) => {
          if (s.kind !== 'ready') return s;
          const items = [...s.items, ...page.items];
          shown.current = Math.max(pageSize, items.length);
          return { kind: 'ready', items, nextCursor: page.nextCursor };
        });
      },
      () => {
        if (mine === generation.current) busy.current = false;
      },
    );
  }, [data, key, state, pageSize]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    fetchFirst(shown.current);
  }, [fetchFirst]);

  return { state, loadMore, retry };
}
