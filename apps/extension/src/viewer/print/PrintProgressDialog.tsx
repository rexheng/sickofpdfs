import { Dialog } from '@sop/ui';
import styles from './PrintProgressDialog.module.css';
import './print.css';

export interface PrintProgressDialogProps {
  /** Pages ready so far, and the total. */
  done: number;
  total: number;
  /** Stops the work and closes the dialog. Escape and a click outside do the same. */
  onCancel(this: void): void;
}

/**
 * "Preparing to print…": shown while the pages are drawn for the print copy (print.ts), with how far it is and a Cancel.
 * (It also loads print.css, which shows the copy and hides the viewer when the page is printed.)
 */
export function PrintProgressDialog({ done, total, onCancel }: PrintProgressDialogProps) {
  return (
    <Dialog open title="Preparing to print…" actions={[{ label: 'Cancel', onClick: onCancel }]} onOpenChange={(open) => !open && onCancel()}>
      <p className={styles.line}>
        {done} of {total} {total === 1 ? 'page' : 'pages'} ready
      </p>
      <div role="progressbar" aria-label="Pages ready to print" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className={styles.track}>
        <div className={styles.fill} style={{ inlineSize: `${total === 0 ? 0 : (done / total) * 100}%` }} />
      </div>
    </Dialog>
  );
}
