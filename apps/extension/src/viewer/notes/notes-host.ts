// The open document's comment commands, for controls outside the notes layer (the toolbar's Comment button). One
// viewer tab shows one document, so there is one host per page.
import type { NoteCommandBehaviour, NoteCommandId } from './note-commands';

export type NoteCommands = Record<NoteCommandId, NoteCommandBehaviour>;

let current: NoteCommands | null = null;
const listeners = new Set<() => void>();

/** The notes layer publishes its commands while it is mounted (null when it goes). */
export function publishNoteCommands(c: NoteCommands | null): void {
  current = c;
  for (const cb of [...listeners]) cb();
}

/** The commands of the open document, or null while none is open. */
export function noteCommands(): NoteCommands | null {
  return current;
}

export function subscribeNoteCommands(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
