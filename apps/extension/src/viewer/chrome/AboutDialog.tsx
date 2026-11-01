import { Dialog } from '@sop/ui';
import styles from './AboutDialog.module.css';

export interface AboutDialogProps {
  open: boolean;
  onOpenChange(this: void, open: boolean): void;
}

/**
 * Help → About sickofpdfs: what it is and its version, in plain words. (The first-page timing stays a performance
 * mark for the speed checks; it is not something the owner needs to read.)
 */
export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const manifest = chrome.runtime.getManifest();
  return (
    <Dialog open={open} title="About sickofpdfs" onOpenChange={onOpenChange} actions={[{ label: 'Close', onClick: () => onOpenChange(false) }]}>
      {manifest.description !== undefined && <p className={styles.line}>{manifest.description}</p>}
      <p className={styles.line}>Version {manifest.version}</p>
    </Dialog>
  );
}
