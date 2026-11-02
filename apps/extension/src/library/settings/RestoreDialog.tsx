// The restore dialog (S17): after the owner picks a folder, it says plainly what the backup holds before anything changes, or why it
// can't be restored ("Update sickofpdfs first"). Restore is the main button: it never deletes anything, so Enter may press it.
import { Dialog, type DialogAction } from '@sop/ui';
import type { RefusalReason, RestorePreview } from '../../backup/restore';
import styles from './RestoreSection.module.css';

export type RestoreDialogState =
  | { stage: 'checking'; folderName: string }
  | { stage: 'preview'; folderName: string; preview: Extract<RestorePreview, { ok: true }> }
  | { stage: 'refused'; folderName: string; reason: RefusalReason; message: string };

export interface RestoreDialogProps {
  state: RestoreDialogState | null;
  onRestore(this: void): void;
  onCancel(this: void): void;
  /** "Choose another folder": shows the picker again (it is a click). */
  onChooseAgain(this: void): void;
}

const madeOn = (t: number): string => new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(t);

/** "1 reading you removed here will be left out." (R88) */
const willLeaveOut = (n: number): string => `${n} ${n === 1 ? 'reading' : 'readings'} you removed here will be left out, with ${n === 1 ? 'its' : 'their'} notes.`;

export function RestoreDialog({ state, onRestore, onCancel, onChooseAgain }: RestoreDialogProps) {
  const open = state !== null;
  let title = 'Restore from backup';
  let actions: DialogAction[] = [{ label: 'Cancel', onClick: onCancel }];
  let body = null;

  if (state?.stage === 'checking') {
    body = (
      <>
        <p className={styles.dialogText}>Checking the backup in “{state.folderName}”…</p>
        <div className={styles.track} role="progressbar" aria-label="Checking the backup">
          <div className={`${styles.fill} ${styles.moving}`} />
        </div>
      </>
    );
  } else if (state?.stage === 'preview') {
    const p = state.preview;
    actions = [
      { label: 'Cancel', onClick: onCancel },
      { label: 'Restore', primary: true, onClick: onRestore },
    ];
    body = (
      <>
        <p className={styles.dialogLead}>This backup holds {p.words}.</p>
        <p className={styles.dialogText}>
          It was made on {madeOn(p.createdAt)}, in “{state.folderName}”.
        </p>
        {p.leftOut > 0 && <p className={styles.dialogText}>{willLeaveOut(p.leftOut)}</p>}
        <p className={styles.dialogText}>
          Restoring adds what your library is missing and keeps everything you have now. Nothing is deleted. If a note was changed in both places, you keep both
          versions.
        </p>
      </>
    );
  } else if (state?.stage === 'refused') {
    title = state.reason === 'too-new' ? 'This backup is from a newer sickofpdfs' : 'This backup can’t be restored';
    actions =
      state.reason === 'no-backup' || state.reason === 'unreadable'
        ? [
            { label: 'Close', onClick: onCancel },
            { label: 'Choose another folder', primary: true, onClick: onChooseAgain },
          ]
        : [{ label: 'OK', primary: true, onClick: onCancel }];
    body = <p className={styles.dialogText}>{state.message}</p>;
  }

  return (
    <Dialog open={open} title={title} actions={actions} focusPrimary onOpenChange={(next) => !next && onCancel()}>
      {body}
    </Dialog>
  );
}
