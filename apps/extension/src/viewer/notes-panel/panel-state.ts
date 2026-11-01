// Whether the notes panel is open, and whether the window is too narrow for margin cards (plan S15).
//
// The comment cards (S14) read both, so a note is never shown twice:
// - While the panel is open, the margin cards are hidden, as Docs hides its margin comments while its sidebar is open.
// - In a narrow window the margin cards are not shown at all; the notes fold into the panel instead. Spec "Viewer
//   specifics": at narrow widths "the thumbnail rail collapses first, then cards fold into the notes panel". The rail
//   collapses below 1100 px (Task 24), so the cards fold below that.
import { useSyncExternalStore } from 'react';

/**
 * Below this window width (CSS px) the margin cards fold into the panel: a laptop at 150 % Windows scaling (1366 px
 * wide, so 910 CSS px) folds; one at 125 % (1093 CSS px) keeps its cards beside the pages.
 */
export const CARDS_FOLD_BELOW_PX = 1000;

let open = false;
const listeners = new Set<() => void>();

/** The panel's open state for this tab. One viewer runs per page, so one value is enough. */
export const notesPanel = {
  isOpen: (): boolean => open,
  setOpen: (next: boolean): void => {
    if (next === open) return;
    open = next;
    for (const cb of [...listeners]) cb();
  },
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/** Re-renders when the panel opens or closes. */
export function useNotesPanelOpen(): boolean {
  return useSyncExternalStore(notesPanel.subscribe, notesPanel.isOpen);
}

const foldQuery = () => window.matchMedia(`(width < ${CARDS_FOLD_BELOW_PX}px)`);

/** The window is too narrow for margin cards: notes show in the panel. */
export function cardsFolded(): boolean {
  return foldQuery().matches;
}

function subscribeFold(cb: () => void): () => void {
  const q = foldQuery();
  q.addEventListener('change', cb);
  return () => q.removeEventListener('change', cb);
}

/** Re-renders when the window crosses CARDS_FOLD_BELOW_PX. */
export function useCardsFolded(): boolean {
  return useSyncExternalStore(subscribeFold, cardsFolded);
}
