// What the comments in the viewer need from the document's annotation session. S13's wiring (annotations/wire.ts)
// builds the one session per document; until it merges, stand-in-session.ts builds a memory-only one.
import type { MarkColor } from '@sop/core';
import type { Anchor, CharRange } from '../annotations/boundary';
import type { AnnotationSession } from '../annotations/session';

export interface NotesWiring {
  session: AnnotationSession;
  /** Save typed text now: the draft keeper's flush. The note box calls it on blur and Esc. */
  flushDrafts(): void;
  /** The text anchor for selected ranges (quote, positions, line rects): the same one marks use. */
  makeTextAnchor(ranges: CharRange[]): Promise<Extract<Anchor, { kind: 'text' }>>;
  /** The colour of a new note's highlight: the last colour used (settings 'marks.lastColor'; yellow, 1, by default). */
  highlightColor(): MarkColor;
}
