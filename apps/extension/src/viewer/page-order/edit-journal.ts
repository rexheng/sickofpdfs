// One Ctrl+Z for the whole tab (R108): page moves and notes each keep their own undo history (the annotation session's
// undo.ts for notes, the page order controller for moves). This journal remembers which of the two did each action, so
// Ctrl+Z undoes the latest one, whichever it was, and Ctrl+Y redoes in the same order.
//
// A tab that never moved a page behaves exactly as before: with nothing journalled, Undo and Redo go to the notes.

export type EditKind = 'notes' | 'pages';

/** The tab's actions, oldest first, and the undone ones that can be redone (latest undone last). */
const done: EditKind[] = [];
const undone: EditKind[] = [];
/** A page was moved in this tab, so an empty journal no longer means "notes only". */
let pagesTouched = false;
const LIMIT = 300;

/** A new action. Clears what could be redone. */
export function recordEdit(kind: EditKind): void {
  if (kind === 'pages') pagesTouched = true;
  done.push(kind);
  if (done.length > LIMIT) done.shift();
  undone.length = 0;
}

/** Which history Ctrl+Z goes to now. */
export function nextUndo(): EditKind {
  return done.at(-1) ?? 'notes';
}

/** Which history Ctrl+Y goes to now; null when there is nothing to redo here. */
export function nextRedo(): EditKind | null {
  return undone.at(-1) ?? (pagesTouched ? null : 'notes');
}

/** Ctrl+Z went to `kind`. */
export function tookUndo(kind: EditKind): void {
  if (done.at(-1) === kind) done.pop();
  undone.push(kind);
}

/** Ctrl+Y went to `kind`. */
export function tookRedo(kind: EditKind): void {
  if (undone.at(-1) === kind) undone.pop();
  done.push(kind);
}

/** The open document went (one document per tab): its history goes with it. */
export function clearEdits(): void {
  done.length = 0;
  undone.length = 0;
  pagesTouched = false;
}
