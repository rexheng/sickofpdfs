// The compact toolbar (TB4): in a narrow window (a half-screen window beside notes is 640 or 683 px), the pill keeps the
// page box, the zoom, Find, Comment and Notes, and moves Download, Print and Area note into a "More" menu. Comment and
// Notes keep their icon (and Notes its count) without their words. Nothing in the pill ever overlaps.
import { useSyncExternalStore } from 'react';

/**
 * Below this window width the toolbar pill is compact. Measured: the full pill's controls take 717 px with "Notes" (a
 * 749 px window, with the row's 16 px each side); "Notes 888" adds 33 px and a four-digit page count about 27 px. So
 * 820 px, not the 760 first thought of: between them a PDF with many notes or pages pushed Comment onto Find.
 */
export const COMPACT_TOOLBAR_BELOW_PX = 820;

let query: MediaQueryList | null = null;
const compactQuery = (): MediaQueryList => (query ??= window.matchMedia(`(width < ${COMPACT_TOOLBAR_BELOW_PX}px)`));

function subscribe(cb: () => void): () => void {
  const q = compactQuery();
  q.addEventListener('change', cb);
  return () => q.removeEventListener('change', cb);
}

/** Whether the toolbar pill is compact now; re-renders when the window crosses COMPACT_TOOLBAR_BELOW_PX. */
export function useCompactToolbar(): boolean {
  return useSyncExternalStore(subscribe, () => compactQuery().matches);
}
