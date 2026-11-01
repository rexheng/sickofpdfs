// The viewer's view state for one tab: zoom, current page, rotation, spread, rail and presentation mode. A tiny external
// store, so the page list, the toolbar (Task 23) and the thumbnail rail (Task 24) read and write one copy, and tests read
// it as a snapshot.
import { useCallback, useSyncExternalStore } from 'react';
import type { Rotation } from '../backend/types';
import type { Spread, ZoomMode } from '../layout/zoom';
import type { Presenting } from '../view/view-state';

export interface ViewerSnapshot {
  zoom: ZoomMode;
  /** The scale the pages are drawn at now (zoom resolved against the viewport): 1 = 100%. */
  scale: number;
  /** 0-based: the page with the most area in view. */
  currentPage: number;
  /** The reader's rotation, clockwise, added to every page's /Rotate. */
  viewRotation: Rotation;
  /** Two-page view (Task 26): pages in pairs, 1–2, 3–4, … */
  spread: Spread;
  railOpen: boolean;
  /**
   * Presentation mode (Task 26): the page on screen, one page a screen on black; null while not presenting. The page
   * list follows it (presentation.ts and the reading keys step it).
   */
  presenting: Presenting | null;
}

export interface ViewerStore {
  get(): ViewerSnapshot;
  set(p: Partial<ViewerSnapshot>): void;
  subscribe(cb: () => void): () => void;
}

export const INITIAL_VIEWER_SNAPSHOT: ViewerSnapshot = {
  zoom: { kind: 'fit-width' },
  scale: 1,
  currentPage: 0,
  viewRotation: 0,
  spread: 'none',
  railOpen: false,
  presenting: null,
};

/** A store holding `initial` (default: fit width, page 1). `set` notifies only when a field actually changes. */
export function createViewerStore(initial: Partial<ViewerSnapshot> = {}): ViewerStore {
  let snapshot: ViewerSnapshot = { ...INITIAL_VIEWER_SNAPSHOT, ...initial };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(p) {
      const changed = (Object.keys(p) as (keyof ViewerSnapshot)[]).some((k) => !sameValue(snapshot[k], p[k]));
      if (!changed) return;
      snapshot = { ...snapshot, ...p };
      for (const cb of [...listeners]) cb();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Re-renders when `select(snapshot)` changes. */
export function useViewerState<T>(store: ViewerStore, select: (s: ViewerSnapshot) => T): T {
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  return useSyncExternalStore(subscribe, () => select(store.get()));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}
