// The question the first mark asks on a PDF judged not learning (spec: "Your first mark on a PDF judged not learning
// asks: 'Save this PDF to keep your notes?'"). Save saves it; No keeps the notes in memory until the tab closes. The first
// line says why it is asking: what the PDF looks like, or the owner's own earlier choice (S11).
import { Dialog } from '@sop/ui';
import { HARD_BLOCK_REASON } from '@sop/core';
import cards from '../ui/cards.module.css';
import { FORGOTTEN_REASON, NEVER_SAVE_REASON } from '../filter/async-filter';
import type { SaveControllerImpl } from './save-controller';
import { useSaveView } from './StatusChip';

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
  const answer = (yes: boolean) => void save.answerAsk(yes).catch(() => {});
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
    >
      <p className={cards.body}>{whyAsking(save.whyNotSaved ?? undefined, save.decision?.ownerSave !== undefined)}</p>
      <p className={cards.body}>If you choose No, your notes stay only until you close this tab.</p>
    </Dialog>
  );
}
