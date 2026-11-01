// How Ctrl+Alt+M reaches figures, areas and pins (Phase 2, S16). The comments feature (S14) owns the key, the note box
// and the margin; before its text flow it asks here whether the note is about something else: the selected figure or
// area, or a pin on the figure under the pointer. If so, the note is made here on that anchor, with no highlight (a
// figure note shows an outline), and shown through S14's own steps, so the box, the margin and "no lost text" are the
// ones text notes use. The figures controller says what the target is (setSpecialNoteTarget).
import type { Anchor, ThreadId } from '@sop/core';
import type { AnnotationSession } from '../annotations/session';
import type { NoteTarget } from '../notes/comment-flow';

/**
 * A note Ctrl+Alt+M makes on something that is not selected text. `existing` is a note already on that figure or area,
 * which opens instead of a second one.
 */
export type SpecialNote =
  | { kind: 'existing'; threadId: ThreadId }
  | { kind: 'new'; anchor: () => Promise<Anchor>; keep?: { clientX: number; clientY: number } };

let target: (() => SpecialNote | null) | null = null;

/** The figures controller says what Ctrl+Alt+M is about when it is not the selected text (null: the text flow decides). */
export function setSpecialNoteTarget(fn: (() => SpecialNote | null) | null): void {
  target = fn;
}

/** S14's steps for showing a note. */
export interface SpecialNoteSteps {
  session: AnnotationSession;
  /** The active card loses its turn: its typed text is sent, an empty new note is dropped. */
  finishOpen(): void;
  /** Opens the margin before the note appears, keeping a point (client px) where it is on screen. */
  openMargin(keep?: { clientX: number; clientY: number }): void;
  /** Shows the note that was made or found: its card active, its box focused. */
  open(target: NoteTarget): void;
  /** Nothing was made: a margin opened for it closes again if the document has no notes. */
  nothingOpened(target: NoteTarget | null): void;
}

let busy = false;

/**
 * Ctrl+Alt+M (or the Comment button) on a figure, an area or a pin. Returns false when the note is not about one of
 * them, and the text flow then runs as before.
 */
export function openSpecialNote(d: SpecialNoteSteps): boolean {
  const special = target?.() ?? null;
  if (special === null) return false;
  d.finishOpen();
  if (special.kind === 'existing') {
    d.openMargin();
    d.open({ kind: 'existing', threadId: special.threadId });
    return true;
  }
  if (busy || d.session.state().mode === 'view-only') return true;
  busy = true;
  special
    .anchor()
    .then(
      (anchor) => {
        if (d.session.state().mode === 'view-only') return d.nothingOpened(null);
        d.openMargin(special.keep);
        const { threadId, commentId } = d.session.startThread(anchor, { highlight: null });
        d.open({ kind: 'new', threadId, commentId, anchor });
      },
      () => d.nothingOpened(null),
    )
    .finally(() => {
      busy = false;
    });
  return true;
}
