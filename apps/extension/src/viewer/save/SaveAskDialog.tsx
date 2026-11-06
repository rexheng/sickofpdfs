// The question the first mark asks on a PDF judged not learning (spec: "Your first mark on a PDF judged not learning
// asks: 'Save this PDF to keep your notes?'"). Save saves it; No keeps the notes in memory until the tab closes. The first
// line says why it is asking: what the PDF looks like, or the owner's own earlier choice (S11).
// R96: the question never eats typing. It often opens on the first letter of a note, while the owner is still typing:
// - no button has the focus when it opens (the dialog itself has it), so Space and letters never press one, and no focus ring
//   shows; Tab still reaches the buttons;
// - the letters typed while it is open (Space and Backspace too) go into the note box at once, in order (TB7: they were held
//   until it was answered, and only this tab's memory had them; now the note keeps them as it keeps every letter of the box).
// R100 (TB5 student critic, the blocker): Enter never answers it. The owner presses Enter to send a note, so Enter on a bank
// statement saved the bank statement. Now:
// - the note's letters show in it ("Your note: …"), those typed before it opened and while it is open, so the owner sees
//   where they went;
// - only a click on a button, or Tab to a button and then Enter or Space, answers it. Esc means No;
// - this holds for every PDF, so a quick note on a receipt can never save it.
// Closing the tab while the notes are only in memory brings up the browser's "Leave site?" question (session.ts).
// R105 (TB6): a note that asks Claude ("@Claude …") gets no save question for Claude's sake. Claude never reads a PDF judged not
// learning, so saving it would not help, and the owner should not have to answer a question about a receipt to ask one. While the
// note's first letters could still be "@Claude", the question waits, unseen, and typing goes into the note box as usual. A note
// that starts with "@Claude" answers it No (nothing is kept, as after No); any other note, Enter, Esc, Tab, a click elsewhere or a
// pause of a few seconds shows it as before. The thread then says, in Claude's row, why there is no answer.
import { HARD_BLOCK_REASON } from '@sop/core';
import { Dialog } from '@sop/ui';
import { FORGOTTEN_REASON, NEVER_SAVE_REASON } from '../filter/async-filter';
import { CARD_ID_PREFIX } from '../notes/CardColumn';
import cards from '../ui/cards.module.css';
import type { SaveControllerImpl } from './save-controller';
import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { claudeNoteWaiting } from './claude-note';
import { useSaveView } from './StatusChip';
import styles from './SaveDialogs.module.css';

/**
 * The question can open as a note box does (the first note on a PDF judged not learning asks before any typing). While it
 * is open it holds the keyboard, so the note box could not take it. As the question closes, the box gets the caret
 * (`focusOnClose`), and again if the box is drawn anew as the save lands; never over a field that has it already.
 */
// The box is in its margin card, or in the notes panel when the cards are folded (R98: the rail no longer folds for them).
// Only a box for a note that is not sent yet: once the note is sent its card shows a reply box, and the question's late
// timers (the type-ahead's) must never pull the keyboard into that one, or the next Ctrl+Alt+M would be dropped.
const openNoteBox = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(`[id^="${CARD_ID_PREFIX}"] textarea[aria-label="Note"], [id^="sop-panel-note-"] textarea[aria-label="Note"]`);

/** How long letters typed right after the answer are kept for the note box, at most. */
const TYPE_AHEAD_MS = 1500;

/** R105: a note that asks Claude. */
const CLAUDE_NOTE = /^\s*@claude(?![\p{L}\p{N}_])/iu;
/** The note's words could still turn out to be "@Claude …": nothing yet, "@", "@cl". */
function couldAskClaude(text: string): boolean {
  const t = text.trimStart().toLowerCase();
  return t === '' || (t.startsWith('@') && '@claude'.startsWith(t));
}
/** How long the question waits, unseen, for the note's first letters (R105). Any pause this long shows it. */
const CLAUDE_WAIT_MS = 2500;
/** The note box being written in now, when it has the caret. */
const noteBeingWritten = (): HTMLTextAreaElement | null => {
  const box = openNoteBox();
  return box !== null && document.activeElement === box ? box : null;
};

/** The question shows at most this many of the note's letters (the end, where the owner is typing). */
const HELD_SHOWN = 160;

/**
 * No lost letters (R96, TB7 held letters): while the question is open, and between the answer and the moment the note box has
 * the caret (the question takes a moment to close), each letter typed goes into the note box at once, as typing would. The
 * question holds the keyboard, not the letters: they are the note's from the first key, so the note keeps them the way it keeps
 * every letter of the box (the drafts journal on a saved PDF, the save-pending record while a save is on its way, and this tab
 * only while the question is open or after No, as the spec says). Only while a note box is open. `asking` is true while the
 * question is open (R100: then Enter answers nothing).
 */
const typedAhead = { active: false, asking: false, until: 0 };

/** The question shows the note's letters (R100). It reads them through this. */
const heldListeners = new Set<() => void>();
function subscribeHeld(cb: () => void): () => void {
  heldListeners.add(cb);
  return () => heldListeners.delete(cb);
}
const notifyHeld = (): void => {
  for (const cb of heldListeners) cb();
};
/**
 * The note as the question shows it: the box's letters, which hold every letter typed since it opened. The question often opens on
 * a note's first letter (R96; since R105, whenever the box has the caret first), so without the box's own letters the owner would
 * read "Your note: point note" and think the "A" was lost.
 */
const noteSoFar = (): string => (typedAhead.asking ? (openNoteBox()?.value ?? '') : '');

/** The question opened: from now until it is answered, what is typed goes into the note box (R96). */
function holdTyping(): void {
  typedAhead.active = true;
  typedAhead.asking = true;
  typedAhead.until = Infinity;
  notifyHeld();
}

function startTypeAhead(): void {
  typedAhead.active = true;
  typedAhead.asking = false;
  typedAhead.until = performance.now() + TYPE_AHEAD_MS;
  notifyHeld();
  setTimeout(() => {
    const box = openNoteBox();
    if (typedAhead.active && box !== null) putCaretAtEnd(box);
    typedAhead.active = false;
  }, TYPE_AHEAD_MS);
}

function putCaretAtEnd(box: HTMLTextAreaElement): void {
  box.focus({ preventScroll: true });
  box.setSelectionRange(box.value.length, box.value.length);
}

/** Changes the box's text as typing would (an input event, so the note keeps it at once), with the caret at the end. */
function typeIntoBox(box: HTMLTextAreaElement, edit: (text: string) => string): void {
  // The element's own value setter, past React's tracker, so React sees the input event as a change.
  Reflect.set(HTMLTextAreaElement.prototype, 'value', edit(box.value), box);
  box.setSelectionRange(box.value.length, box.value.length);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  notifyHeld();
}

/** A key that types a character (a letter, a digit, Space, punctuation; AltGr characters too), not a shortcut. */
function typesCharacter(e: KeyboardEvent): boolean {
  const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  return e.key.length === 1 && !e.metaKey && (!(e.ctrlKey || e.altKey) || altGraph);
}

/** Before every other key handler of the page (it is added first): a letter typed while the box waits goes into it. */
function catchTypedAhead(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (typedAhead.asking) {
    // R100: the question is open. Only a click, or Enter or Space on a button the owner moved to with Tab, answers it; Esc
    // (the dialog's own) means No. Enter anywhere else answers nothing: it is how a note is sent, so it is not a Save.
    const onButton = document.activeElement instanceof HTMLButtonElement && document.activeElement.closest('[role="dialog"]') !== null;
    if (onButton && (e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.altKey && !e.metaKey) return; // the button's own press
    const box = openNoteBox();
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && box !== null) typeIntoBox(box, (t) => `${t}\n`); // a new line of the note
      return;
    }
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (box !== null) typeIntoBox(box, (t) => [...t].slice(0, -1).join('')); // one character, an emoji too
      return;
    }
    if (!typesCharacter(e)) return;
    // Letters never press a button. With a note box waiting, they are the note's letters, and the question shows them.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (box !== null) typeIntoBox(box, (t) => t + e.key);
    return;
  }
  if (!typedAhead.active) return;
  const box = openNoteBox();
  if (box === null || performance.now() > typedAhead.until || document.activeElement === box) {
    typedAhead.active = false; // no box waits, or it has the caret now: this key goes where it goes, as usual
    return;
  }
  if (!typesCharacter(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // not a reading key or a mark key: it is a letter of the note
  typeIntoBox(box, (t) => t + e.key);
}

function giveBackToNoteBox(): void {
  const tryFocus = (): void => {
    if (document.querySelector('[role="dialog"]') !== null) return; // still closing
    const box = openNoteBox();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return; // the box has it, or something took it on purpose
    if (box === null) return;
    putCaretAtEnd(box);
  };
  for (const ms of [0, 30, 80, 160, 320]) setTimeout(tryFocus, ms);
}

/** The note box takes the caret as the question closes. */
function focusOnClose(): HTMLTextAreaElement | null {
  return openNoteBox();
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
  const asking = save !== null && state?.kind === 'asking';
  // R105: while a note being written could still be "@Claude …", the question waits unseen ('wait'), then shows ('show'). Decided as
  // the question opens, before it is drawn, so it never takes the caret from a note that asks Claude.
  const hold = useRef<{ asking: boolean; mode: 'wait' | 'show' }>({ asking: false, mode: 'show' });
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // A failed save keeps the question open (the App's note says it failed); the rejection is handled there.
  const answered = useRef(false);
  if (hold.current.asking !== asking) {
    const box = asking ? noteBeingWritten() : null;
    const forClaude = asking && claudeNoteWaiting.active(); // a sent @Claude note waits on this question (claude-note.ts)
    hold.current = { asking, mode: forClaude || (box !== null && couldAskClaude(box.value)) ? 'wait' : 'show' };
    if (asking) answered.current = false;
  }
  const open = asking && hold.current.mode === 'show';
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
  const answer = (yes: boolean): void => {
    if (save === null || answered.current) return;
    answered.current = true;
    if (openNoteBox() !== null) startTypeAhead();
    else {
      typedAhead.asking = false;
      typedAhead.active = false;
    }
    void save.answerAsk(yes).catch(() => {});
    giveBackToNoteBox();
  };
  // R105: the question waits, unseen, while the note's first letters are typed into the box. "@Claude" answers it No; anything else
  // shows it, as does Enter, Esc, Tab, a click elsewhere, the caret leaving the box, or a pause.
  const waiting = asking && hold.current.mode === 'wait';
  // A sent @Claude note waits on this question: No, quietly, whether the question is seen yet or not.
  useEffect(() => {
    if (!asking || save === null) return;
    const no = () => {
      if (!claudeNoteWaiting.active() || answered.current) return;
      answered.current = true;
      typedAhead.asking = false;
      void save.answerAsk(false).catch(() => {});
    };
    no();
    return claudeNoteWaiting.subscribe(no);
  }, [asking, save]);
  useEffect(() => {
    if (!waiting || save === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = () => {
      if (hold.current.mode !== 'wait') return;
      hold.current = { ...hold.current, mode: 'show' };
      redraw();
    };
    const pause = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(show, CLAUDE_WAIT_MS);
    };
    const onInput = () => {
      const box = openNoteBox();
      const text = box?.value ?? '';
      if (CLAUDE_NOTE.test(text)) {
        // No, quietly: nothing is kept (the note stays in this tab), and the thread will say why Claude does not answer.
        if (answered.current) return;
        answered.current = true;
        void save.answerAsk(false).catch(() => {});
        return;
      }
      if (!couldAskClaude(text)) show();
      else pause();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab') return;
      // Enter would send the note, Esc close it, Tab leave it: the question comes first, as before (R100: Enter answers nothing).
      e.preventDefault();
      e.stopImmediatePropagation();
      show();
    };
    const onPointer = (e: PointerEvent) => {
      const box = openNoteBox();
      if (box === null || !(e.target instanceof Node) || !box.contains(e.target)) show();
    };
    const onLeave = () => requestAnimationFrame(() => (noteBeingWritten() === null ? show() : undefined));
    pause();
    document.addEventListener('input', onInput);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusout', onLeave, true);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('input', onInput);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('focusout', onLeave, true);
    };
  }, [waiting, save]);
  // R96: from the moment it opens, typing goes into the note box.
  useEffect(() => {
    if (!open) return;
    answered.current = false;
    holdTyping();
    return () => {
      if (typedAhead.asking) typedAhead.asking = false;
    };
  }, [open]);
  // R100: what was typed while it is open shows in it, so the owner sees the letters were kept (and that Enter did not send).
  const shown = useSyncExternalStore(subscribeHeld, noteSoFar);
  // R105: the question showed before the note's words were known (the box took the caret late), and the note asks Claude: No.
  useEffect(() => {
    if (!open || answered.current) return;
    if (CLAUDE_NOTE.test(shown)) answer(false);
    // `answer` is made anew each draw; the note's letters are what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shown]);
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
        {shown.trim() !== '' && (
          <p className={styles.heldNote} aria-live="polite">
            <span className={styles.heldLabel}>Your note: </span>
            {/* The end of a long note: that is where the owner is typing. */}
            {shown.length > HELD_SHOWN ? `…${shown.slice(-HELD_SHOWN)}` : shown}
          </p>
        )}
      </div>
    </Dialog>
  );
}
