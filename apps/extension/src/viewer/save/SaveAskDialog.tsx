// The question the first mark asks on a PDF judged not learning (spec: "Your first mark on a PDF judged not learning
// asks: 'Save this PDF to keep your notes?'"). Save saves it; No keeps the notes in memory until the tab closes.
import { Dialog } from '@sop/ui';
import cards from '../ui/cards.module.css';
import type { SaveControllerImpl } from './save-controller';
import { useSaveView } from './StatusChip';

export interface SaveAskDialogProps {
  save: SaveControllerImpl | null;
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
        { label: 'Save', primary: true, onClick: () => answer(true) },
      ]}
      onOpenChange={(open) => !open && answer(false)}
    >
      <p className={cards.body}>It doesn’t look like a learning PDF, so it isn’t in your library yet.</p>
      <p className={cards.body}>If you choose No, your notes stay only until you close this tab.</p>
    </Dialog>
  );
}
