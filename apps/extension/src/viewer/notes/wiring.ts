// What the comments in the viewer need from the document's annotation session. S13's wiring (annotations/wire.ts)
// builds the one session per document; the comments feature (feature.tsx) hands it here from the NotesHost.
import type { Anchor, CharRange } from '../annotations/boundary';
import type { AnnotationSession } from '../annotations/session';

export interface NotesWiring {
  session: AnnotationSession;
  /** Save typed text now: the draft keeper's flush. The note box calls it on blur and Esc. */
  flushDrafts(): void;
  /** The text anchor for selected ranges (quote, positions, line rects): the same one marks use. */
  makeTextAnchor(ranges: CharRange[]): Promise<Extract<Anchor, { kind: 'text' }>>;
}
