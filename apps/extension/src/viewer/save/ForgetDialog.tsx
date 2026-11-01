// "Forget this PDF" (File menu, Ctrl+Shift+Delete) and the saved chip's "Remove from library…" (R73): one flow (R75).
// - With notes or marks, it asks first, and offers "Never save this file".
// - With none, it forgets at once and offers "Never save this file" afterwards.
// - Then it says what happened: "Removed from your library and your backups." (or that the backup folder could not be
//   reached, and the next backup run finishes the job).
import { Dialog } from '@sop/ui';
import { useEffect, useState } from 'react';
import cards from '../ui/cards.module.css';
import type { BackupScrubResult } from './backup-scrub';
import type { ForgetOutcome, SaveControllerImpl } from './save-controller';
import { Choice } from './Choice';

export const FORGET_TITLE = 'Forget this PDF?';
/** R75: what the dialog says once the PDF and its backups are clean. */
export const REMOVED_EVERYWHERE = 'Removed from your library and your backups.';
export const NEVER_SAVE_LABEL = 'Never save this file';

export interface ForgetDialogProps {
  save: SaveControllerImpl;
  open: boolean;
  onClose: () => void;
}

type Step =
  | { kind: 'counting' }
  | { kind: 'confirm'; marks: number; notes: number }
  | { kind: 'working' }
  | { kind: 'done'; outcome: ForgetOutcome; offerNever: boolean }
  | { kind: 'failed'; neverSave: boolean };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Its 2 marks and 1 note will be deleted too." */
export function whatGoes(marks: number, notes: number): string {
  const parts = [...(marks > 0 ? [plural(marks, 'mark', 'marks')] : []), ...(notes > 0 ? [plural(notes, 'note', 'notes')] : [])];
  return parts.length === 0 ? '' : `Its ${parts.join(' and ')} will be deleted too.`;
}

/** The first line after a Forget: where it is gone from. */
export function removedLine(backups: BackupScrubResult): string {
  switch (backups) {
    case 'cleaned':
      return REMOVED_EVERYWHERE;
    case 'no-backup':
      return 'Removed from your library.';
    case 'pending':
      return 'Removed from your library. Your backup folder can’t be reached right now, so it will be removed from your backups the next time a backup runs.';
  }
}

export function ForgetDialog({ save, open, onClose }: ForgetDialogProps) {
  const [step, setStep] = useState<Step>({ kind: 'counting' });
  const [never, setNever] = useState(false);

  const forget = (neverSave: boolean, offerNever: boolean): void => {
    setStep({ kind: 'working' });
    save.forget({ neverSave }).then(
      (outcome) => setStep({ kind: 'done', outcome, offerNever }),
      () => setStep({ kind: 'failed', neverSave }),
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
        else forget(false, true);
      },
      // It could not count them: ask, as if there were notes.
      () => live && setStep({ kind: 'confirm', marks: 0, notes: 0 }),
    );
    return () => {
      live = false;
    };
    // `forget` only reads `save`, which is a dependency
  }, [open, save]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (): void => {
    if (step.kind === 'done' && step.offerNever && never) void save.neverSave().catch(() => {});
    onClose();
  };

  const neverBox = <Choice type="checkbox" label={NEVER_SAVE_LABEL} checked={never} onChange={setNever} />;

  switch (step.kind) {
    case 'counting':
      return null;
    case 'confirm':
      return (
        <Dialog
          open={open}
          title={FORGET_TITLE}
          actions={[
            { label: 'Cancel', onClick: onClose },
            { label: 'Forget', primary: true, onClick: () => forget(never, false) },
          ]}
          onOpenChange={(o) => !o && onClose()}
        >
          <p className={cards.body}>It will be removed from your library and your backups. {whatGoes(step.marks, step.notes)}</p>
          <p className={cards.body}>This can’t be undone.</p>
          {neverBox}
        </Dialog>
      );
    case 'working':
      return (
        <Dialog open={open} title="Forgetting this PDF…" actions={[]} onOpenChange={(o) => !o && onClose()}>
          <p className={cards.body}>Removing it from your library and your backups…</p>
        </Dialog>
      );
    case 'done':
      return (
        <Dialog open={open} title="PDF forgotten" actions={[{ label: 'Done', primary: true, onClick: finish }]} onOpenChange={(o) => !o && finish()}>
          <p className={cards.body}>{removedLine(step.outcome.backups)}</p>
          {step.outcome.neverSave === 'kept' && <p className={cards.body}>It won’t be saved again on this computer.</p>}
          {step.outcome.neverSave === 'failed' && <p className={cards.body}>“Never save this file” couldn’t be kept. Try again later.</p>}
          {step.offerNever && neverBox}
        </Dialog>
      );
    case 'failed':
      return (
        <Dialog
          open={open}
          title="Couldn’t forget this PDF"
          actions={[
            { label: 'Close', onClick: onClose },
            { label: 'Try again', primary: true, onClick: () => forget(step.neverSave, false) },
          ]}
          onOpenChange={(o) => !o && onClose()}
        >
          <p className={cards.body}>It is still in your library, with its notes. Try again.</p>
        </Dialog>
      );
  }
}
