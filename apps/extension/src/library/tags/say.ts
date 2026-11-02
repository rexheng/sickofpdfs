import type { SnackbarMessage } from '@sop/ui/library';

/** A message for the library's snackbar, with Undo when there is one. */
export function sayWith(notify: (m: Omit<SnackbarMessage, 'id'>) => void): (text: string, undo?: () => void) => void {
  return (text, undo) => notify(undo === undefined ? { text } : { text, action: { label: 'Undo', onClick: undo } });
}
