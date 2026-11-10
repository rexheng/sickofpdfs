// R108: the page numbers the owner sees follow the order they put the pages in. One open document per viewer tab, so
// the tab has one page order: the Reader binds its view store here, and every label that names a page ("Page 4" on a
// card, a chip, a link, the find bar) reads the number through shownPage(). Stored page indices never change.
import { type PageOrder, positionOfPage, shownPageNumber } from '@sop/core/page-order';
import type { ViewerStore } from '@sop/viewer';
import { useSyncExternalStore } from 'react';

let bound: ViewerStore | null = null;
let unwatch: (() => void) | null = null;
let order: PageOrder = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

/** The open document's view store is the tab's page order from now on. Returns what unbinds it. */
export function bindPageOrder(store: ViewerStore): () => void {
  unwatch?.();
  bound = store;
  order = store.get().pageOrder;
  const off = store.subscribe(() => {
    const next = store.get().pageOrder;
    if (next === order) return;
    order = next;
    notify();
  });
  unwatch = off;
  notify();
  return () => {
    if (bound !== store) return;
    off();
    unwatch = null;
    bound = null;
    order = null;
    notify();
  };
}

/** The order the pages are shown in now (null: the file's own). */
export function currentPageOrder(): PageOrder {
  return order;
}

/** The page number shown for page `index` (an original page index, 0-based): 1-based, in the order shown. */
export function shownPage(index: number): number {
  return shownPageNumber(order, index);
}

/** Where page `index` is shown, 0-based. */
export function shownPosition(index: number): number {
  return positionOfPage(order, index);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The tab's page order, re-rendering when it changes. */
export function usePageOrder(): PageOrder {
  return useSyncExternalStore(subscribe, currentPageOrder);
}

/** Calls `cb` whenever the tab's page order changes. */
export function onPageOrderChange(cb: () => void): () => void {
  return subscribe(cb);
}
