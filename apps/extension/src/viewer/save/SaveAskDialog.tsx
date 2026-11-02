// The question the first mark asks on a PDF judged not learning (spec: "Your first mark on a PDF judged not learning
// asks: 'Save this PDF to keep your notes?'"). Save saves it; No keeps the notes in memory until the tab closes. The first
// line says why it is asking: what the PDF looks like, or the owner's own earlier choice (S11).
import { HARD_BLOCK_REASON } from '@sop/core';
import { Dialog } from '@sop/ui';
import { FORGOTTEN_REASON, NEVER_SAVE_REASON } from '../filter/async-filter';
import { CARD_ID_PREFIX } from '../notes/CardColumn';
import cards from '../ui/cards.module.css';
import type { SaveControllerImpl } from './save-controller';
import { useSaveView } from './StatusChip';

/**
 * The question can open as a note box does (the first note on a PDF judged not learning asks before any typing). While it
 * is open it holds the keyboard, so the note box could not take it. As the question closes, the box gets the caret
 * (`focusOnClose`), and again if the box is drawn anew as the save lands; never over a field that has it already.
 */
const openNoteBox = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>(`[id^="${CARD_ID_PREFIX}"] textarea`);

function giveBackToNoteBox(): void {
  const tryFocus = (): void => {
    if (document.querySelector('[role="dialog"]') !== null) return; // still closing
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return; // something took it on purpose
    const box = openNoteBox();
    if (box === null) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  };
  for (const ms of [0, 30, 80, 160, 320]) setTimeout(tryFocus, ms);
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
  if (save === null || state === null) return null;
  // A failed save keeps the question open (the App's note says it failed); the rejection is handled there.
  const answer = (yes: boolean) => {
    void save.answerAsk(yes).catch(() => {});
    giveBackToNoteBox();
  };
  return (
    <Dialog
      open={state.kind === 'asking'}
      title="Save this PDF to keep your notes?"
      actions={[
        { label: 'No', onClick: () => answer(false) },
        // The spec's own words: "Save this PDF to keep your notes?" Yes saves it; No keeps the notes in this tab only.
        { label: 'Yes', primary: true, onClick: () => answer(true) },
      ]}
      onOpenChange={(open) => !open && answer(false)}
      // A note box waiting for this answer takes the caret back as the question closes (and again, if it is drawn anew).
      focusOnClose={openNoteBox}
    >
      <p className={cards.body}>{whyAsking(save.whyNotSaved ?? undefined, save.decision?.ownerSave !== undefined)}</p>
      <p className={cards.body}>If you choose No, your notes stay only until you close this tab.</p>
    </Dialog>
  );
}
