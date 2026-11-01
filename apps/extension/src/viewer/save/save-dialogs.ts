// Which of the save decision's dialogs is open in this tab: "Forget this PDF" (File menu, Ctrl+Shift+Delete, and the saved
// chip's "Remove from library…") or "Report a wrong decision" (File menu). The commands open them; SaveDialogs.tsx draws
// them. One viewer per tab, so one value per tab.
import { useSyncExternalStore } from 'react';

export type SaveDialogKind = 'forget' | 'report';

let open: SaveDialogKind | null = null;
const listeners = new Set<() => void>();

function set(next: SaveDialogKind | null): void {
  if (next === open) return;
  open = next;
  for (const cb of [...listeners]) cb();
}

export const openSaveDialog = (kind: SaveDialogKind): void => set(kind);
export const closeSaveDialog = (): void => set(null);

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** The dialog open now, re-read whenever it changes. */
export function useSaveDialog(): SaveDialogKind | null {
  return useSyncExternalStore(subscribe, () => open);
}
