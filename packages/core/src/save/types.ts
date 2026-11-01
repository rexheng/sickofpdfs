// The library save state of the open PDF, as the viewer's status chip shows it. Task 30's reducer produces it; the
// viewer chrome (Task 23) only reserves the chip's place. Types only.
import type { DocumentId } from '../ids';

export type SaveState =
  /** The learning filter is still deciding. */
  | { kind: 'checking' }
  /** In the library. `undoable` while the 10 s Undo after an automatic save is still open. */
  | { kind: 'saved'; documentId: DocumentId; undoable: boolean }
  /** The filter could not decide: the chip asks ("Not sure: Save?"). */
  | { kind: 'unsure'; reasons: string[] }
  /** Judged not learning (a receipt, a bill): nothing is stored. */
  | { kind: 'not-learning'; reasons: string[] }
  /** The chip's question is open. */
  | { kind: 'asking' }
  /** Notes are kept in memory only until the person chooses Save. */
  | { kind: 'memory-only' }
  /** An Incognito window: view only, no marks, notes or saving. */
  | { kind: 'incognito' };
