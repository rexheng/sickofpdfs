// The save decision as a pure state machine (Task 30). The viewer's save controller feeds it events (identity resolved,
// the filter's verdict, a click on the chip, the first mark, Undo) and runs the effect it returns. It decides; it never
// writes. Privacy follows from it: no state reached without an owner's action or a `learning` verdict asks for a save.
import type { FilterDecision } from '../filter/types';
import { STAND_IN_REASONS } from '../filter/stand-in';
import type { DocumentId } from '../ids';
import type { SaveState } from './types';

export type SaveEvent =
  /** The PDF is already in the library (its fingerprint, or a stamped copy of it). */
  | { type: 'identified'; documentId: DocumentId }
  /** Not in the library: the filter's verdict. */
  | { type: 'classified'; decision: FilterDecision }
  /** The chip, or Ctrl+Alt+S. */
  | { type: 'save-requested' }
  /** The first mark or note on a PDF that is not saved. */
  | { type: 'first-mark' }
  /** A save effect finished. */
  | { type: 'saved'; documentId: DocumentId; undoable: boolean }
  /** "Save this PDF to keep your notes?" was answered. */
  | { type: 'ask-answered'; save: boolean }
  | { type: 'undo-requested' }
  /** A forget effect finished: the library holds nothing of the PDF. */
  | { type: 'undone' }
  /** The 10 s Undo after an automatic save ran out. */
  | { type: 'undo-expired' }
  | { type: 'incognito' };

/** What the controller must do: save (with an Undo when `undoable`), forget the document, or ask the question. */
export type SaveEffect = { kind: 'save'; undoable: boolean } | { kind: 'forget' } | { kind: 'ask' };

type Step = { state: SaveState; effect: SaveEffect | null };

const stay = (state: SaveState): Step => ({ state, effect: null });
const save = (state: SaveState, undoable: boolean): Step => ({ state, effect: { kind: 'save', undoable } });

/** States in which the PDF is not in the library and a save may be asked for. */
const notSaved = (s: SaveState): boolean => s.kind === 'unsure' || s.kind === 'not-learning' || s.kind === 'memory-only' || s.kind === 'asking';

export function reduceSave(s: SaveState, e: SaveEvent): Step {
  // Incognito is final: view only, whatever happens.
  if (s.kind === 'incognito') return stay(s);
  switch (e.type) {
    case 'incognito':
      return stay({ kind: 'incognito' });
    case 'identified':
      return stay({ kind: 'saved', documentId: e.documentId, undoable: false });
    case 'classified':
      if (s.kind !== 'checking') return stay(s);
      switch (e.decision.verdict) {
        // A learning PDF saves on its own; the chip says so once the save is done.
        case 'learning':
          return save(s, false);
        case 'unsure':
          return stay({ kind: 'unsure', reasons: e.decision.reasons });
        case 'not-learning':
          return stay({ kind: 'not-learning', reasons: e.decision.reasons });
      }
      return stay(s);
    case 'save-requested':
      // The owner's own choice always saves, with no Undo (they asked for it).
      return notSaved(s) ? save(s, false) : stay(s);
    case 'first-mark':
      switch (s.kind) {
        case 'unsure':
          return save(s, true);
        case 'not-learning':
          return { state: { kind: 'asking' }, effect: { kind: 'ask' } };
        default:
          // Asking already, memory-only (the owner said No), saved, or still checking: nothing to do.
          return stay(s);
      }
    case 'saved':
      return stay({ kind: 'saved', documentId: e.documentId, undoable: e.undoable });
    case 'ask-answered':
      if (s.kind !== 'asking') return stay(s);
      return e.save ? save(s, false) : stay({ kind: 'memory-only' });
    case 'undo-requested':
      return s.kind === 'saved' && s.undoable ? { state: s, effect: { kind: 'forget' } } : stay(s);
    case 'undone':
      // Back to before the save. An undoable save only comes from a first mark on a "not sure" PDF, so Undo returns
      // there; the controller puts its filter's own reasons back.
      return s.kind === 'saved' ? stay({ kind: 'unsure', reasons: [...STAND_IN_REASONS] }) : stay(s);
    case 'undo-expired':
      return s.kind === 'saved' && s.undoable ? stay({ ...s, undoable: false }) : stay(s);
  }
}
