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
  /**
   * The first mark or note on a PDF that is not saved. `undoable: false` (R67 c, f): the save gets no Undo, because a
   * note started it, or more than one mark was made before it began. Left out, a "not sure" PDF saves with an Undo.
   */
  | { type: 'first-mark'; undoable?: boolean }
  /**
   * R67 (a): a save the owner started earlier, in a tab that closed or crashed before it finished, completes now. It
   * never has an Undo (R67 tightened 3). On a PDF judged not learning it asks first: the notes may have been made before
   * the verdict was known.
   */
  | { type: 'resume-save' }
  /** A save effect finished. */
  | { type: 'saved'; documentId: DocumentId; undoable: boolean }
  /** "Save this PDF to keep your notes?" was answered. */
  | { type: 'ask-answered'; save: boolean }
  | { type: 'undo-requested' }
  /**
   * A forget effect finished: the library holds nothing of the PDF. Back to "not sure", with `reasons` (the filter's own,
   * Phase 3) for the chip's tooltip; left out, the stand-in's.
   */
  | { type: 'undone'; reasons?: string[] }
  /**
   * Phase 3: the owner forgot the saved PDF ("Forget this PDF", "Remove from library…"), here or in another tab. It is not in
   * the library, and it is not "not sure" either: a mark asks before it saves it again. `reasons` say why ("removed from your
   * library").
   */
  | { type: 'forgotten'; reasons: string[] }
  /** Phase 3: the owner chose "Never for this file". A mark asks before it saves; `reasons` say so. */
  | { type: 'never-save'; reasons: string[] }
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
          return save(s, e.undoable !== false);
        case 'not-learning':
          return { state: { kind: 'asking' }, effect: { kind: 'ask' } };
        default:
          // Asking already, memory-only (the owner said No), saved, or still checking: nothing to do.
          return stay(s);
      }
    case 'resume-save':
      if (s.kind === 'not-learning') return { state: { kind: 'asking' }, effect: { kind: 'ask' } };
      return s.kind === 'unsure' ? save(s, false) : stay(s);
    case 'saved':
      return stay({ kind: 'saved', documentId: e.documentId, undoable: e.undoable });
    case 'ask-answered':
      if (s.kind !== 'asking') return stay(s);
      return e.save ? save(s, false) : stay({ kind: 'memory-only' });
    case 'undo-requested':
      return s.kind === 'saved' && s.undoable ? { state: s, effect: { kind: 'forget' } } : stay(s);
    case 'undone':
      // Back to before the save. An undoable save only comes from a first mark on a "not sure" PDF, so Undo returns
      // there, with the filter's own reasons.
      return s.kind === 'saved' ? stay({ kind: 'unsure', reasons: [...(e.reasons ?? STAND_IN_REASONS)] }) : stay(s);
    case 'forgotten':
      // Here (from `saved`), or in another tab, which went back to "not sure" when it heard the delete and then learnt that
      // it was the owner's Forget, not an Undo.
      return s.kind === 'saved' || s.kind === 'unsure' ? stay({ kind: 'not-learning', reasons: [...e.reasons] }) : stay(s);
    case 'never-save':
      // Not from `memory-only` (the owner said No: the notes stay in this tab, and nothing changes that), nor while asking.
      return s.kind === 'unsure' || s.kind === 'not-learning' ? stay({ kind: 'not-learning', reasons: [...e.reasons] }) : stay(s);
    case 'undo-expired':
      return s.kind === 'saved' && s.undoable ? stay({ ...s, undoable: false }) : stay(s);
  }
}
