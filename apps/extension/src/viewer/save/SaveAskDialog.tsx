// The question the first mark asks on a PDF judged not learning (spec: "Your first mark on a PDF judged not learning
// asks: 'Save this PDF to keep your notes?'"). Save saves it; No keeps the notes in memory until the tab closes. The first
// line says why it is asking: what the PDF looks like, or the owner's own earlier choice (S11).
import { HARD_BLOCK_REASON } from '@sop/core';
import { Dialog } from '@sop/ui';
import { FORGOTTEN_REASON, NEVER_SAVE_REASON } from '../filter/async-filter';
import { CARD_ID_PREFIX } from '../notes/CardColumn';
import cards from '../ui/cards.module.css';
import type { SaveControllerImpl } from './save-controller';
import { useEffect } from 'react';
import { useSaveView } from './StatusChip';

/**
 * The question can open as a note box does (the first note on a PDF judged not learning asks before any typing). While it
 * is open it holds the keyboard, so the note box could not take it. As the question closes, the box gets the caret
 * (`focusOnClose`), and again if the box is drawn anew as the save lands; never over a field that has it already.
 */
const openNoteBox = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>(`[id^="${CARD_ID_PREFIX}"] textarea`);

/** How long letters typed right after the answer are kept for the note box, at most. */
const TYPE_AHEAD_MS = 1500;

/**
 * No lost letters: between the answer and the moment the note box has the caret (the question takes a moment to close),
 * the letters typed are kept here and put into the box, in order, once it has it. Only while a note box waits for them.
 */
const typedAhead = { active: false, until: 0, text: '' };

function startTypeAhead(): void {
  typedAhead.active = true;
  typedAhead.until = performance.now() + TYPE_AHEAD_MS;
  typedAhead.text = '';
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

/** Before every other key handler of the page (it is added first): a letter typed while the box waits is kept for it. */
function catchTypedAhead(e: KeyboardEvent): void {
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
  const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  if (e.key.length !== 1 || e.metaKey || ((e.ctrlKey || e.altKey) && !altGraph)) return;
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
  // Added when the viewer starts, before the page's own key handlers, so it sees a typed-ahead letter first.
  useEffect(() => {
    window.addEventListener('keydown', catchTypedAhead, true);
    return () => window.removeEventListener('keydown', catchTypedAhead, true);
  }, []);
  if (save === null || state === null) return null;
  // A failed save keeps the question open (the App's note says it failed); the rejection is handled there.
  const answer = (yes: boolean) => {
    if (openNoteBox() !== null) startTypeAhead();
    void save.answerAsk(yes).catch(() => {});
    giveBackToNoteBox();
  };
  return (
    <Dialog
      open={state.kind === 'asking'}
      title="Save this PDF to keep your notes?"
      actions={[
        { label: 'No', onClick: () => answer(false) },
        { label: 'Save', primary: true, onClick: () => answer(true) },
      ]}
      onOpenChange={(open) => !open && answer(false)}
      // A note box waiting for this answer takes the caret back as the question closes (and again, if it is drawn anew).
      focusOnClose={focusOnClose}
    >
      <p className={cards.body}>{whyAsking(save.whyNotSaved ?? undefined, save.decision?.ownerSave !== undefined)}</p>
      <p className={cards.body}>If you choose No, your notes stay only until you close this tab.</p>
    </Dialog>
  );
}
