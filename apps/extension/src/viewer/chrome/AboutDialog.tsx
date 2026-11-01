import { Dialog } from '@sop/ui';
import styles from './AboutDialog.module.css';

export interface AboutDialogProps {
  open: boolean;
  onOpenChange(this: void, open: boolean): void;
}

/** When the first page of this PDF was fully drawn, in ms since the tab started (the `sop:first-page` speed mark). */
function firstPageMs(): number | null {
  const entry = performance.getEntriesByName('sop:first-page')[0];
  return entry === undefined ? null : Math.round(entry.startTime);
}

/** Help → About sickofpdfs: what it is, its version, and how fast this PDF's first page appeared. */
export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const manifest = chrome.runtime.getManifest();
  const firstPage = open ? firstPageMs() : null;
  return (
    <Dialog open={open} title="About sickofpdfs" onOpenChange={onOpenChange} actions={[{ label: 'Close', onClick: () => onOpenChange(false) }]}>
      {manifest.description !== undefined && <p className={styles.line}>{manifest.description}</p>}
      <p className={styles.line}>Version {manifest.version}</p>
      {firstPage !== null && <p className={styles.line}>First page drawn in {firstPage} ms</p>}
    </Dialog>
  );
}
