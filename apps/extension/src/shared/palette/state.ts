// Whether the search palette is open, and what it starts with. One per page: Ctrl+K, a menu item and the library's search
// box all open the same palette through here, and its host (viewer/palette-host.tsx, library/shell/LibraryPalette.tsx) draws it.
import { useSyncExternalStore } from 'react';

export interface PaletteState {
  open: boolean;
  /** Text it opens with (the library's search box passes what was typed). */
  query: string;
  /** Counts the times it opened, so a new opening starts clean. */
  opened: number;
}

let state: PaletteState = { open: false, query: '', opened: 0 };
const listeners = new Set<() => void>();

function set(next: PaletteState): void {
  state = next;
  for (const cb of [...listeners]) cb();
}

export const palette = {
  state: (): PaletteState => state,
  isOpen: (): boolean => state.open,
  open: (o: { query?: string } = {}): void => {
    if (state.open) return;
    set({ open: true, query: o.query ?? '', opened: state.opened + 1 });
  },
  close: (): void => {
    if (state.open) set({ ...state, open: false });
  },
  /** Ctrl+K: opens it, or closes it when it is open. */
  toggle: (): void => {
    if (state.open) palette.close();
    else palette.open();
  },
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export function usePaletteState(): PaletteState {
  return useSyncExternalStore(palette.subscribe, palette.state);
}
