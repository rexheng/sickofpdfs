// Whether the viewer's "About this PDF" panel is open. One viewer runs per page, so one value is enough. File → About
// this PDF and the saved chip's "Tags and details…" open it; it shares the right side with the notes panel, so opening
// one closes the other.
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const cb of [...listeners]) cb();
}

export const aboutPanel = {
  isOpen: (): boolean => open,
  open: (): void => set(true),
  close: (): void => set(false),
  toggle: (): void => set(!open),
  subscribe: (cb: () => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export function useAboutPanelOpen(): boolean {
  return useSyncExternalStore(aboutPanel.subscribe, aboutPanel.isOpen);
}
