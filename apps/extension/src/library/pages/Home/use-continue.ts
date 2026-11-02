// Home's "Continue reading": the readings opened most recently, each with where the owner stopped (S16's history), kept up
// to date as readings are opened, starred or moved to Trash in any tab.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingState } from '../../data/pages-data';
import type { LibraryData, LibraryItem } from '../../data/types';

export interface ContinueItem {
  item: LibraryItem;
  /** Null when the reading has no history yet, or it could not be read. */
  reading: ReadingState | null;
}

export type ContinueState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; items: ContinueItem[]; total: number };

export function useContinueReading(data: LibraryData, limit: number): { state: ContinueState; retry(this: void): void } {
  const [state, setState] = useState<ContinueState>({ kind: 'loading' });
  const generation = useRef(0);

  const fetch = useCallback(() => {
    const mine = ++generation.current;
    data
      .listDocuments({ view: 'recent', sort: { by: 'lastOpened', dir: 'desc' }, limit })
      .then(async (page) => {
        const readings = await Promise.all(page.items.map((item) => data.getReading(item.doc.id).catch(() => null)));
        if (mine !== generation.current) return;
        setState({ kind: 'ready', items: page.items.map((item, i) => ({ item, reading: readings[i] ?? null })), total: page.total });
      })
      .catch(() => {
        if (mine === generation.current) setState({ kind: 'error' });
      });
  }, [data, limit]);

  useEffect(() => {
    setState({ kind: 'loading' });
    fetch();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = data.onChange(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fetch, 50);
    });
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [data, fetch]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    fetch();
  }, [fetch]);
  return { state, retry };
}
