// The question the first mark asks on a PDF judged not learning (spec: "Your first mark on a PDF judged not learning
// asks: 'Save this PDF to keep your notes?'"). Save saves it; No keeps the notes in memory until the tab closes. The first
// line says why it is asking: what the PDF looks like, or the owner's own earlier choice (S11).
// R96: the question never eats typing. It often opens on the first letter of a note, while the owner is still typing:
// - no button has the focus when it opens (the dialog itself has it), so Space and letters never press one, and no focus ring
//   shows; Tab still reaches the buttons;
// - the letters typed while it is open (Space and Backspace too) are kept, and go into the note box, in order, once it is
//   answered;
// - Enter means Save and Esc means No (Enter on a button the keyboard moved to presses that button, as usual).
// Closing the tab while the notes are only in memory brings up the browser's "Leave site?" question (session.ts).
import { HARD_BLOCK_REASON } from '@sop/core';
import { Dialog } from '@sop/ui';
import { FORGOTTEN_REASON, NEVER_SAVE_REASON } from '../filter/async-filter';
import { CARD_ID_PREFIX } from '../notes/CardColumn';
import cards from '../ui/cards.module.css';
import type { SaveControllerImpl } from './save-controller';
import { useCallback, useEffect, useRef } from 'react';
import { useSaveView } from './StatusChip';
import styles from './SaveDialogs.module.css';

/**
 * The question can open as a note box does (the first note on a PDF judged not learning asks before any typing). While it
 * is open it holds the keyboard, so the note box could not take it. As the question closes, the box gets the caret
 * (`focusOnClose`), and again if the box is drawn anew as the save lands; never over a field that has it already.
 */
// The box is in its margin card, or in the notes panel when the cards are folded (R98: the rail no longer folds for them).
const openNoteBox = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(`[id^="${CARD_ID_PREFIX}"] textarea, [id^="sop-panel-note-"] textarea`);

/** How long letters typed right after the answer are kept for the note box, at most. */
const TYPE_AHEAD_MS = 1500;

/**
 * No lost letters (R96): while the question is open, and between the answer and the moment the note box has the caret (the
 * question takes a moment to close), the letters typed are kept here and put into the box, in order, once it has it. Only
 * while a note box waits for them. `asking` is true while the question is open: then Enter answers Save.
 */
const typedAhead = { active: false, asking: false, until: 0, text: '', answer: null as ((save: boolean) => void) | null };

/** The question opened: from now until it is answered, what is typed is kept for the note box (R96). */
function holdTyping(answer: (save: boolean) => void): void {
  typedAhead.active = true;
  typedAhead.asking = true;
  typedAhead.until = Infinity;
  typedAhead.answer = answer;
}

function startTypeAhead(): void {
  typedAhead.active = true;
  typedAhead.asking = false;
  typedAhead.answer = null;
  typedAhead.until = performance.now() + TYPE_AHEAD_MS;
  setTimeout(() => {
    const box = openNoteBox();
    if (typedAhead.active && box !== null) {
      box.focus({ preventScroll: true });
      flushTypeAhead(box);
    }
    typedAhead.active = false;
  }, TYPE_AHEAD_MS);
}

/** Puts the letters typed ahead at the end of the box, as typing would (an input event, so the note keeps them). */
function flushTypeAhead(box: HTMLTextAreaElement): void {
  const text = typedAhead.text;
  typedAhead.text = '';
  typedAhead.active = false;
  if (text === '') return;
  // The element's own value setter, past React's tracker, so React sees the input event as a change.
  Reflect.set(HTMLTextAreaElement.prototype, 'value', box.value + text, box);
  box.setSelectionRange(box.value.length, box.value.length);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A key that types a character (a letter, a digit, Space, punctuation; AltGr characters too), not a shortcut. */
function typesCharacter(e: KeyboardEvent): boolean {
  const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  return e.key.length === 1 && !e.metaKey && (!(e.ctrlKey || e.altKey) || altGraph);
}

/** Before every other key handler of the page (it is added first): a letter typed while the box waits is kept for it. */
function catchTypedAhead(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (typedAhead.asking) {
    // R96: the question is open. Only Enter (Save) and Esc (No, the dialog's own) answer it; Tab moves between its buttons.
    const onButton = document.activeElement instanceof HTMLButtonElement && document.activeElement.closest('[role="dialog"]') !== null;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !onButton) {
      e.preventDefault();
      e.stopImmediatePropagation();
      typedAhead.answer?.(true);
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      typedAhead.text = typedAhead.text.slice(0, -1);
      return;
    }
    if (!typesCharacter(e)) return;
    // Space and letters never press a button. With a note box waiting, they are the note's letters.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (openNoteBox() !== null) typedAhead.text += e.key;
    return;
  }
  if (!typedAhead.active) return;
  const box = openNoteBox();
  if (box === null || performance.now() > typedAhead.until) {
    typedAhead.active = false;
    typedAhead.text = '';
    return;
  }
  if (document.activeElement === box) {
    flushTypeAhead(box); // the box has the caret now: what came before goes in first, then this key as usual
    return;
  }
  if (!typesCharacter(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // not a reading key or a mark key: it is a letter of the note
  typedAhead.text += e.key;
}

function giveBackToNoteBox(): void {
  const tryFocus = (): void => {
    if (document.querySelector('[role="dialog"]') !== null) return; // still closing
    const box = openNoteBox();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      if (box !== null && active === box) flushTypeAhead(box);
      return; // something took it on purpose
    }
    if (box === null) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    flushTypeAhead(box);
  };
  for (const ms of [0, 30, 80, 160, 320]) setTimeout(tryFocus, ms);
}

/** The note box takes the caret as the question closes, and then the letters typed meanwhile. */
function focusOnClose(): HTMLTextAreaElement | null {
  const box = openNoteBox();
  if (box !== null) queueMicrotask(() => flushTypeAhead(box)); // after the dialog has focused it
  return box;
}

export interface SaveAskDialogProps {
  save: SaveControllerImpl | null;
}

/** The question's first line, in plain words, from the reason the PDF is not saved. */
export function whyAsking(reason: string | undefined, privateNumbers: boolean): string {
  if (privateNumbers || reason === HARD_BLOCK_REASON) return 'It has card, bank or ID numbers, so it isn’t in your library. If you save it, its text won’t be searchable.';
  if (reason === NEVER_SAVE_REASON) return 'You chose never to save this file. Saving it now changes that.';
  if (reason === FORGOTTEN_REASON) return 'You removed it from your library.';
  if (reason !== undefined && reason.startsWith('looks like ')) return `It ${reason}, so it isn’t in your library yet.`;
  return 'It doesn’t look like a learning PDF, so it isn’t in your library yet.';
}

/** Open while the save state is `asking`. Escape or a click outside answers No: nothing is stored. */
export function SaveAskDialog({ save }: SaveAskDialogProps) {
  const { state } = useSaveView(save);
  const open = save !== null && state?.kind === 'asking';
  // R96: the question's text takes the focus as it is drawn, before the dialog would give it to its first button (the dialog
  // only does that when the focus is not inside it yet), so no button has it and no ring is ever drawn on one. The shared
  // Dialog does the same for any dialog opened with the mouse; this one does it however it opens, since it usually opens
  // on a keystroke in the note box.
  // What had the focus before it opened gets it back after (the pages, after a mark), when no note box waits for it.
  const opener = useRef<HTMLElement | null>(null);
  const focusText = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return;
    if (document.activeElement instanceof HTMLElement && !el.contains(document.activeElement)) opener.current = document.activeElement;
    el.focus({ preventScroll: true });
  }, []);
  const giveFocusBack = useCallback((): HTMLElement | null => {
    const box = focusOnClose();
    if (box !== null) return box;
    const back = opener.current;
    opener.current = null;
    return back?.isConnected === true ? back : null;
  }, []);
  // Added when the viewer starts, before the page's own key handlers, so it sees a typed-ahead letter first.
  useEffect(() => {
    window.addEventListener('keydown', catchTypedAhead, true);
    return () => window.removeEventListener('keydown', catchTypedAhead, true);
  }, []);
  // A failed save keeps the question open (the App's note says it failed); the rejection is handled there.
  const answered = useRef(false);
  const answer = (yes: boolean): void => {
    if (save === null || answered.current) return;
    answered.current = true;
    if (openNoteBox() !== null) startTypeAhead();
    else {
      typedAhead.asking = false;
      typedAhead.answer = null;
      typedAhead.active = false;
      typedAhead.text = '';
    }
    void save.answerAsk(yes).catch(() => {});
    giveBackToNoteBox();
  };
  const answerRef = useRef(answer);
  answerRef.current = answer;
  // R96: from the moment it opens, typing is held for the note box.
  useEffect(() => {
    if (!open) return;
    answered.current = false;
    typedAhead.text = typedAhead.active ? typedAhead.text : '';
    holdTyping((yes) => answerRef.current(yes));
    return () => {
      if (typedAhead.asking) {
        typedAhead.asking = false;
        typedAhead.answer = null;
      }
    };
  }, [open]);
  if (save === null || state === null) return null;
  return (
    <Dialog
      open={open}
      title="Save this PDF to keep your notes?"
      actions={[
        { label: 'No', onClick: () => answer(false) },
        { label: 'Save', primary: true, onClick: () => answer(true) },
      ]}
      onOpenChange={(o) => !o && answer(false)}
      // A note box waiting for this answer takes the caret back as the question closes (and again, if it is drawn anew).
      focusOnClose={giveFocusBack}
    >
      <div ref={focusText} tabIndex={-1} className={styles.questionBody}>
        <p className={cards.body}>{whyAsking(save.whyNotSaved ?? undefined, save.decision?.ownerSave !== undefined)}</p>
        <p className={cards.body}>If you choose No, your notes stay only until you close this tab.</p>
      </div>
    </Dialog>
  );
}
