// Spec-blind tests for Task 30, the save decision: `reduceSave`, the pure state machine behind the status chip.
//
// Sources:
//   spec, walkthrough 1: a learning PDF shows the chip "Saved to library"; reading it again shows it as saved.
//   spec, walkthrough 10: "Not saved: looks like a receipt. Nothing is stored ... If the filter is wrong, one click on the chip saves it."
//   spec, Learning filter, "Notes on a PDF that isn't saved":
//     "Your first mark or note on a 'not sure' PDF saves it to the library, with an Undo chip."
//     "Your first mark on a PDF judged not learning asks: 'Save this PDF to keep your notes?' Yes saves it. No keeps the notes in
//      memory only, until the tab closes, and nothing is stored."
//   spec, "When the filter is wrong": "The chip ... always shows the decision; click it, or press Ctrl+Alt+S, to save."
//   spec, Library: "In an Incognito window the extension only views PDFs: no marks, notes or saving."
//   spec, Local traces: "A PDF that isn't saved leaves no history row ...".
//   CLAUDE.md non-negotiables: "no lost notes"; "nothing saved from non-learning PDFs".
//   interface file (Tasks 30+31): the SaveEvent and SaveEffect unions, `reduceSave(s, e) -> { state, effect }`, the chip table
//     ("saved + undoable: ... an Undo button for 10 s"), "Undo/forget leaves no rows and no stored PDF copy".
//
// GUESSES (the interface file does not say; written down in task-30-tests-report.md):
//   G1  While a save is in flight (after a `save` effect, before the `saved` event) the state stays `checking` (the only state that has
//       neither a document id nor a question). The tests only rely on it for the learning auto-save; every other check about a pending save
//       is stated as "a second request makes no second save", which holds whatever the in-between state is.
//   G2  An explicit save (Ctrl+Alt+S, a click on the chip) and the Yes answer are not undoable; only the first mark on a 'not sure' PDF is.
//   G3  A mark made while the filter is still deciding (`checking`) saves nothing and asks nothing.
//   G4  After Undo (`undone`) the same tab does not save silently again on the next mark: only an explicit save does.
import { describe, expect, it } from 'vitest';
import type { FilterDecision } from '../filter/types';
import type { DocumentId } from '../ids';
import { reduceSave, type SaveEffect, type SaveEvent } from './save-machine';
import type { SaveState } from './types';

const DOC = 'ab'.repeat(32) as DocumentId;
const OTHER_DOC = 'cd'.repeat(32) as DocumentId;
const STAND_IN_REASONS = ['No filter yet: your first mark saves it'];

const checking: SaveState = { kind: 'checking' };
const unsure: SaveState = { kind: 'unsure', reasons: STAND_IN_REASONS };
const notLearning: SaveState = { kind: 'not-learning', reasons: ['looks like a receipt'] };
const asking: SaveState = { kind: 'asking' };
const memoryOnly: SaveState = { kind: 'memory-only' };
const incognito: SaveState = { kind: 'incognito' };
const saved = (undoable: boolean, documentId: DocumentId = DOC): SaveState => ({ kind: 'saved', documentId, undoable });

const learningDecision: FilterDecision = { verdict: 'learning', reasons: ['References section, DOI, 40 pages'] };
const unsureDecision: FilterDecision = { verdict: 'unsure', reasons: STAND_IN_REASONS };
const notLearningDecision: FilterDecision = { verdict: 'not-learning', reasons: ['looks like a receipt'] };

const ev = {
  identified: { type: 'identified', documentId: DOC } as SaveEvent,
  learning: { type: 'classified', decision: learningDecision } as SaveEvent,
  unsure: { type: 'classified', decision: unsureDecision } as SaveEvent,
  notLearning: { type: 'classified', decision: notLearningDecision } as SaveEvent,
  save: { type: 'save-requested' } as SaveEvent,
  mark: { type: 'first-mark' } as SaveEvent,
  savedAuto: { type: 'saved', documentId: DOC, undoable: true } as SaveEvent,
  savedPlain: { type: 'saved', documentId: DOC, undoable: false } as SaveEvent,
  yes: { type: 'ask-answered', save: true } as SaveEvent,
  no: { type: 'ask-answered', save: false } as SaveEvent,
  undo: { type: 'undo-requested' } as SaveEvent,
  undone: { type: 'undone' } as SaveEvent,
  expired: { type: 'undo-expired' } as SaveEvent,
  incognito: { type: 'incognito' } as SaveEvent,
};

/** Feeds the events in order; returns the final state and every effect that came out, in order. */
function run(start: SaveState, ...events: SaveEvent[]): { state: SaveState; effects: SaveEffect[] } {
  let state = start;
  const effects: SaveEffect[] = [];
  for (const e of events) {
    const out = reduceSave(state, e);
    state = out.state;
    if (out.effect !== null) effects.push(out.effect);
  }
  return { state, effects };
}
const savesIn = (effects: SaveEffect[]) => effects.filter((e) => e.kind === 'save');

describe('opening a PDF: what the first answers do to the chip', () => {
  it.each([
    {
      name: 'a known document (fingerprint or stamp alias) shows as saved at once, with no Undo, and nothing is saved again',
      event: ev.identified,
      state: saved(false),
      effect: null,
    },
    {
      name: 'a learning verdict saves it by itself, not undoable (walkthrough 1: it just says "Saved to library")',
      event: ev.learning,
      state: checking, // G1
      effect: { kind: 'save', undoable: false },
    },
    {
      name: 'a "not sure" verdict asks through the chip and saves nothing',
      event: ev.unsure,
      state: unsure,
      effect: null,
    },
    {
      name: 'a not-learning verdict shows why on the chip and saves nothing (walkthrough 10)',
      event: ev.notLearning,
      state: notLearning,
      effect: null,
    },
    {
      name: 'an Incognito window is view only',
      event: ev.incognito,
      state: incognito,
      effect: null,
    },
  ])('from checking, $name', ({ event, state, effect }) => {
    const out = reduceSave(checking, event);
    expect(out.state).toEqual(state);
    expect(out.effect).toEqual(effect);
  });

  it('the chip keeps the filter\'s own reasons, in order (they are its tooltip and, for not-learning, its text)', () => {
    const reasons = ['looks like a tax form', 'Tax-form type', 'Few pages'];
    const out = reduceSave(checking, { type: 'classified', decision: { verdict: 'not-learning', reasons } });
    expect(out.state).toEqual({ kind: 'not-learning', reasons });
    const sure = reduceSave(checking, { type: 'classified', decision: { verdict: 'unsure', reasons } });
    expect(sure.state).toEqual({ kind: 'unsure', reasons });
  });
});

describe('saving on request (Ctrl+Alt+S, or a click on the chip)', () => {
  it.each([
    { from: 'not sure', state: unsure },
    { from: 'judged not learning ("if the filter is wrong, one click on the chip saves it")', state: notLearning },
    { from: 'notes kept in memory after "No"', state: memoryOnly },
  ])('saves from "$from", and there is no Undo (G2)', ({ state }) => {
    const out = reduceSave(state, ev.save);
    expect(out.effect).toEqual({ kind: 'save', undoable: false });
  });

  it.each([
    { name: 'saved with Undo open', state: saved(true) },
    { name: 'saved, Undo closed', state: saved(false) },
  ])('does nothing when it is already saved ($name): no second copy, no second row', ({ state }) => {
    const out = reduceSave(state, ev.save);
    expect(out.effect).toBeNull();
    expect(out.state).toEqual(state);
  });
});

describe('the first mark', () => {
  it('on a "not sure" PDF saves it with an Undo chip (spec: "saves it to the library, with an Undo chip")', () => {
    expect(reduceSave(unsure, ev.mark).effect).toEqual({ kind: 'save', undoable: true });
  });

  it('on a PDF judged not learning asks first and saves nothing until the answer', () => {
    const out = reduceSave(notLearning, ev.mark);
    expect(out.effect).toEqual({ kind: 'ask' });
    expect(out.state).toEqual({ kind: 'asking' });
  });

  it.each([
    { name: 'Yes saves it (not undoable: the person just answered)', answer: ev.yes, effect: { kind: 'save', undoable: false }, state: undefined },
    { name: 'No keeps the notes in memory only, and stores nothing', answer: ev.no, effect: null, state: memoryOnly },
  ])('answering the question: $name', ({ answer, effect, state }) => {
    const out = reduceSave(asking, answer);
    expect(out.effect).toEqual(effect);
    if (state !== undefined) expect(out.state).toEqual(state);
  });

  it.each([
    { name: 'while the question is open', state: asking },
    { name: 'after the person said No (the question is not asked again in this tab)', state: memoryOnly },
    { name: 'after it is saved, with Undo open', state: saved(true) },
    { name: 'after it is saved, Undo closed', state: saved(false) },
    { name: 'while the filter is still deciding (G3)', state: checking },
    { name: 'in Incognito', state: incognito },
  ])('later marks cause no effect $name', ({ state }) => {
    const out = reduceSave(state, ev.mark);
    expect(out.effect).toBeNull();
    expect(out.state).toEqual(state);
  });

  it('a mark made again while the question is open, and a second tap on the same mark, ask once and save once', () => {
    expect(run(notLearning, ev.mark, ev.mark, ev.mark).effects).toEqual([{ kind: 'ask' }]);
    expect(savesIn(run(unsure, ev.mark, ev.mark).effects)).toHaveLength(1);
  });
});

describe('the save finishing', () => {
  it.each([
    { from: 'checking (a learning PDF saved by itself)', state: checking },
    { from: 'unsure (first mark)', state: unsure },
    { from: 'asking (Yes)', state: asking },
    { from: 'memory-only (Ctrl+Alt+S)', state: memoryOnly },
    { from: 'not-learning (a click on the chip)', state: notLearning },
  ])('"saved" from $from carries the document id and whether Undo is open', ({ state }) => {
    expect(reduceSave(state, ev.savedAuto)).toEqual({ state: saved(true), effect: null });
    expect(reduceSave(state, ev.savedPlain)).toEqual({ state: saved(false), effect: null });
  });
});

describe('Undo: it forgets the PDF, only while it is open, and never loses a PDF the person kept', () => {
  it('Undo while it is open asks for the PDF to be forgotten, nothing else', () => {
    const out = reduceSave(saved(true), ev.undo);
    expect(out.effect).toEqual({ kind: 'forget' });
  });

  it('after 10 seconds the Undo closes and the PDF stays saved', () => {
    expect(reduceSave(saved(true), ev.expired)).toEqual({ state: saved(false), effect: null });
    expect(reduceSave(saved(false), ev.expired)).toEqual({ state: saved(false), effect: null });
  });

  it('an Undo that arrives after it expired (a late click, a stale message) forgets nothing: that would delete a kept PDF and its notes', () => {
    const afterExpiry = run(saved(true), ev.expired, ev.undo);
    expect(afterExpiry.effects).toEqual([]);
    expect(afterExpiry.state).toEqual(saved(false));
    expect(reduceSave(saved(false), ev.undo)).toEqual({ state: saved(false), effect: null });
  });

  it('Undo for a PDF that was saved some other way (Ctrl+Alt+S, a known document) cannot forget it', () => {
    expect(run(unsure, ev.save, ev.savedPlain, ev.undo).effects).toEqual([{ kind: 'save', undoable: false }]);
    expect(run(checking, ev.identified, ev.undo).effects).toEqual([]);
  });

  it('once forgotten the chip is not "saved" any more, and the person can save again on purpose (G4: a mark alone does not)', () => {
    const forgotten = run(unsure, ev.mark, ev.savedAuto, ev.undo, ev.undone);
    expect(forgotten.effects).toEqual([{ kind: 'save', undoable: true }, { kind: 'forget' }]);
    expect(forgotten.state.kind).not.toBe('saved');

    expect(savesIn(run(forgotten.state, ev.mark).effects), 'a mark after Undo must not silently save the PDF the person just undid').toEqual([]);
    expect(savesIn(run(forgotten.state, ev.save).effects), 'Ctrl+Alt+S after Undo saves again').toHaveLength(1);
  });
});

describe('Incognito: view only, whatever arrives', () => {
  it.each([
    { name: 'Ctrl+Alt+S', event: ev.save },
    { name: 'a first mark', event: ev.mark },
    { name: 'a Yes answer', event: ev.yes },
    { name: 'a learning verdict', event: ev.learning },
    { name: 'an Undo', event: ev.undo },
  ])('$name causes no effect and the chip stays "Incognito: view only"', ({ event }) => {
    const out = reduceSave(incognito, event);
    expect(out.effect).toBeNull();
    expect(out.state).toEqual(incognito);
  });
});

describe('a save requested twice, or two ways at once, makes one save', () => {
  it.each([
    { name: 'Ctrl+Alt+S twice on a "not sure" PDF', start: unsure, events: [ev.save, ev.save] },
    { name: 'Ctrl+Alt+S twice on a not-learning PDF', start: notLearning, events: [ev.save, ev.save] },
    { name: 'Ctrl+Alt+S twice after "No"', start: memoryOnly, events: [ev.save, ev.save] },
    { name: 'Ctrl+Alt+S, then a mark, before the first save has finished', start: unsure, events: [ev.save, ev.mark] },
    { name: 'a mark, then Ctrl+Alt+S, before the first save has finished', start: unsure, events: [ev.mark, ev.save] },
    { name: 'the Yes answer twice (a double click on "Save")', start: asking, events: [ev.yes, ev.yes] },
  ])('$name', ({ start, events }) => {
    expect(savesIn(run(start, ...events).effects)).toHaveLength(1);
  });

  it('a save that finished is not repeated by a late request', () => {
    const out = run(unsure, ev.save, ev.savedPlain, ev.save, ev.mark);
    expect(savesIn(out.effects)).toHaveLength(1);
    expect(out.state).toEqual(saved(false));
  });
});

describe('every state meets every event without breaking', () => {
  const states: SaveState[] = [checking, saved(true), saved(false), unsure, notLearning, asking, memoryOnly, incognito];
  const events: SaveEvent[] = Object.values(ev);
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
  };

  it('answers with a known state and an effect or null, never throws, and never edits what it was given', () => {
    const kinds = new Set(['checking', 'saved', 'unsure', 'not-learning', 'asking', 'memory-only', 'incognito']);
    for (const s of states) {
      for (const e of events) {
        const out = reduceSave(deepFreeze(structuredClone(s)), deepFreeze(structuredClone(e)));
        expect(kinds.has(out.state.kind), `${s.kind} + ${e.type} gave state ${JSON.stringify(out.state)}`).toBe(true);
        expect(out.effect === null || ['save', 'forget', 'ask'].includes(out.effect.kind), `${s.kind} + ${e.type} gave effect ${JSON.stringify(out.effect)}`).toBe(true);
      }
    }
  });

  it('only ever forgets from a saved PDF whose Undo is open, and only ever saves with a reason to (never from saved, never in Incognito)', () => {
    for (const s of states) {
      for (const e of events) {
        const { effect } = reduceSave(structuredClone(s), structuredClone(e));
        if (effect?.kind === 'forget') expect(s, `${s.kind} + ${e.type} must not forget`).toEqual(saved(true));
        if (effect?.kind === 'save') expect(['saved', 'incognito'], `${s.kind} + ${e.type} must not save`).not.toContain(s.kind);
      }
    }
  });

  it('a "saved" state for another document is a different state: ids are not mixed up', () => {
    const out = reduceSave(unsure, { type: 'saved', documentId: OTHER_DOC, undoable: false });
    expect(out.state).toEqual(saved(false, OTHER_DOC));
  });
});
