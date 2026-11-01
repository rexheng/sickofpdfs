// "Forget this PDF" (File menu, Ctrl+Shift+Delete) and the saved chip's "Remove from library…" (R73): one flow (R75).
// - With notes or marks (notes still being typed count), it asks first: "It will be removed from your library and your
//   backups", what goes with it, and a "Never save this file" box.
// - With none, it forgets at once: there is nothing of the owner's to lose (plan S11: "asks first if there are notes").
// - Then a note says what happened, in the backup writer's words (S13): "Removed from your library and your backups", or
//   that the backup folder could not be reached and the next backup cleans it, or "Removed from your library".
import { Dialog } from '@sop/ui';
import { useEffect, useState } from 'react';
import type { ViewerUi } from '../commands';
import cards from '../ui/cards.module.css';
import { Choice } from './Choice';
import type { ForgetOutcome, SaveControllerImpl } from './save-controller';

export const FORGET_TITLE = 'Forget this PDF?';
export const NEVER_SAVE_LABEL = 'Never save this file';
const FORGET_FAILED = 'Couldn’t forget this PDF. It is still in your library. Try again.';

export interface ForgetDialogProps {
  save: SaveControllerImpl;
  open: boolean;
  onClose: () => void;
  /** Its `showNote`: what happened, once the PDF is forgotten. */
  ui: Pick<ViewerUi, 'showNote'>;
}

type Step = { kind: 'counting' } | { kind: 'confirm'; marks: number; notes: number } | { kind: 'idle' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Its 2 marks and 1 note will be deleted too." */
export function whatGoes(marks: number, notes: number): string {
  const parts = [...(marks > 0 ? [plural(marks, 'mark', 'marks')] : []), ...(notes > 0 ? [plural(notes, 'note', 'notes')] : [])];
  return parts.length === 0 ? '' : `Its ${parts.join(' and ')} will be deleted too.`;
}

/** What a Forget did, as one or two short sentences for the note. */
export function forgottenNote(outcome: ForgetOutcome): string {
  const m = outcome.backups.message;
  const first = /[.!?]$/.test(m) ? m : `${m}.`;
  if (outcome.neverSave === 'kept') return `${first} It won’t be saved again.`;
  if (outcome.neverSave === 'failed') return `${first} “Never save this file” couldn’t be kept.`;
  return first;
}

export function ForgetDialog({ save, open, onClose, ui }: ForgetDialogProps) {
  const [step, setStep] = useState<Step>({ kind: 'counting' });
  const [never, setNever] = useState(false);

  /** Forgets, closes, and says what happened. */
  const forget = (neverSave: boolean): void => {
    setStep({ kind: 'idle' });
    onClose();
    save.forget({ neverSave }).then(
      (outcome) => ui.showNote(forgottenNote(outcome)),
      () => ui.showNote(FORGET_FAILED),
    );
  };

  useEffect(() => {
    if (!open) return;
    let live = true;
    setStep({ kind: 'counting' });
    setNever(false);
    save.contents().then(
      (c) => {
        if (!live) return;
        if (c.marks + c.notes > 0) setStep({ kind: 'confirm', ...c });
        else forget(false);
      },
      // It could not count them: ask, as if there were notes.
      () => live && setStep({ kind: 'confirm', marks: 0, notes: 0 }),
    );
    return () => {
      live = false;
    };
    // `forget` only reads `save`, `onClose` and `ui`, which do not change while the dialog is open
  }, [open, save]); // eslint-disable-line react-hooks/exhaustive-deps

  if (step.kind !== 'confirm') return null;
  return (
    <Dialog
      open={open}
      title={FORGET_TITLE}
      actions={[
        { label: 'Cancel', onClick: onClose },
        { label: 'Forget', primary: true, onClick: () => forget(never) },
      ]}
      onOpenChange={(o) => !o && onClose()}
    >
      <p className={cards.body}>It will be removed from your library and your backups. {whatGoes(step.marks, step.notes)}</p>
      <p className={cards.body}>This can’t be undone.</p>
      <Choice type="checkbox" label={NEVER_SAVE_LABEL} checked={never} onChange={setNever} />
    </Dialog>
  );
}
