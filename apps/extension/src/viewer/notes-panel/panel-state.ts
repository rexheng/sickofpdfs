// Whether the notes panel is open, and whether the margin cards fit beside the pages (plan S15; ruling R69).
//
// The comment cards (S14) read both, so a note is never shown twice:
// - While the panel is open, the margin cards are hidden, as Docs hides its margin comments while its sidebar is open.
// - When the cards do not fit beside the pages at the zoom the reader chose, they fold into the notes button in the
//   toolbar, and a note that becomes active opens the panel. Spec "Viewer specifics": at narrow widths "the thumbnail
//   rail collapses first, then cards fold into the notes panel"; ruling R69: the zoom never changes to make room.
//   The margin (notes/NotesLayer.tsx) measures this and publishes it here.
import { useSyncExternalStore } from 'react';

function createFlag(initial: boolean) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): boolean => value,
    set: (next: boolean): void => {
      if (next === value) return;
      value = next;
      for (const cb of [...listeners]) cb();
    },
    subscribe: (cb: () => void): (() => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const open = createFlag(false);

/** The panel's open state for this tab. One viewer runs per page, so one value is enough. */
export const notesPanel = {
  isOpen: open.get,
  setOpen: open.set,
  subscribe: open.subscribe,
};

/** Re-renders when the panel opens or closes. */
export function useNotesPanelOpen(): boolean {
  return useSyncExternalStore(notesPanel.subscribe, notesPanel.isOpen);
}

const folded = createFlag(false);

/** The margin cards do not fit beside the pages at their size: the notes show in the panel. */
export function cardsFolded(): boolean {
  return folded.get();
}

/** The margin says whether its cards fit (NotesLayer measures the pages after every layout). */
export function setCardsFolded(f: boolean): void {
  folded.set(f);
}

/** Re-renders when the cards fold away or come back. */
export function useCardsFolded(): boolean {
  return useSyncExternalStore(folded.subscribe, folded.get);
}

const over = createFlag(false);

/** The open panel lies over the pages' right side: they do not fit beside it at their size (R69). It then has a shadow. */
export function setPanelOverPages(f: boolean): void {
  over.set(f);
}

/** Re-renders when the open panel starts or stops lying over the pages. */
export function usePanelOverPages(): boolean {
  return useSyncExternalStore(over.subscribe, over.get);
}

// ---------------------------------------------------------------- the notes button in the toolbar

/** What the toolbar's notes button shows and does: the panel mount publishes it while a document's notes are up. */
export interface NotesButtonState {
  /** How many notes the PDF has. */
  count: number;
  /** Opens or closes the panel; opened from the button, it takes the focus. */
  toggle(this: void): void;
}

let button: NotesButtonState | null = null;
const buttonListeners = new Set<() => void>();

export function publishNotesButton(b: NotesButtonState | null): void {
  button = b;
  for (const cb of [...buttonListeners]) cb();
}

function subscribeNotesButton(cb: () => void): () => void {
  buttonListeners.add(cb);
  return () => buttonListeners.delete(cb);
}

/** The notes button's state, or null while no document's notes are up (Incognito, or still opening). */
export function useNotesButton(): NotesButtonState | null {
  return useSyncExternalStore(subscribeNotesButton, () => button);
}
