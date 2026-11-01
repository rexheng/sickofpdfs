// Connects the viewer to the library store once its PDF is open, and publishes it as the runtime's `store`. The save
// flow (Task 30) waits for it through `libraryStore()`. In Incognito there is no library: `store` is null and nothing
// connects.
import { useEffect } from 'react';
import { connectStore, type StoreClient } from '../store/client';
import { isIncognito } from './incognito';
import { publishRuntime } from './runtime';

/** The viewer's mark for its first page on screen (packages/viewer page-driver). */
const FIRST_PAGE_MARK = 'sop:first-page';
/** The longest the store waits for that mark before it connects anyway. */
const FIRST_PAGE_WAIT_MS = 3000;

let started = false;

let settle: (store: StoreClient | null) => void = () => {};
const outcome = new Promise<StoreClient | null>((resolve) => {
  settle = (store) => {
    publishRuntime({ store });
    resolve(store);
  };
});

/** The library store once it has connected; null in Incognito or when it could not be reached. */
export function libraryStore(): Promise<StoreClient | null> {
  return outcome;
}

/**
 * Resolves once the first page is on screen, or after `maxMs`. Starting the store (the offscreen document and SQLite)
 * then never competes with drawing the first page, which has a 1 s budget.
 */
function afterFirstPage(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (performance.getEntriesByName(FIRST_PAGE_MARK, 'mark').length > 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => done(), maxMs);
    const observer = new PerformanceObserver((list) => {
      if (list.getEntriesByName(FIRST_PAGE_MARK).length > 0) done();
    });
    function done(): void {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }
    observer.observe({ type: 'mark' });
  });
}

/** Call it on every render; the first time `documentReady` is true, the store connects (once per page). */
export function useStore(documentReady: boolean): void {
  useEffect(() => {
    if (!documentReady || started) return;
    started = true;
    if (isIncognito()) {
      settle(null);
      return;
    }
    afterFirstPage(FIRST_PAGE_WAIT_MS)
      .then(() => connectStore())
      .then(
        (store) => settle(store),
        (error: unknown) => {
          // The PDF stays readable; only the library is missing. Nothing about the document is in this message.
          console.warn('sickofpdfs: the library is not available', error instanceof Error ? error.message : String(error));
          settle(null);
        },
      );
  }, [documentReady]);
}
