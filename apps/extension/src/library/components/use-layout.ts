import { useCallback, useState } from 'react';

export type Layout = 'list' | 'grid';

/**
 * The list/grid choice, the same on every library page. It is kept in this browser (localStorage) for now; contract §5
 * names the synced setting `library.layout`, which needs a settings method in the store (there is none yet).
 */
const KEY = 'library.layout';

function read(): Layout {
  try {
    return localStorage.getItem(KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function useLayoutPreference(): [Layout, (l: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(read);
  const set = useCallback((l: Layout) => {
    setLayout(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      // private mode or blocked storage: the choice lasts until the page closes
    }
  }, []);
  return [layout, set];
}
