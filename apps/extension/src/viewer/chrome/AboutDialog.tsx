import { Dialog } from '@sop/ui';
import styles from './AboutDialog.module.css';

export interface AboutDialogProps {
  open: boolean;
  onOpenChange(this: void, open: boolean): void;
}

/** The notices file the build writes (scripts/third-party-notices.mjs): the licences of everything open-source inside. */
const NOTICES_PATH = 'THIRD_PARTY_NOTICES.txt';

/**
 * Help → About sickofpdfs: what it is and its version, in plain words, and a link to the open-source licences. (The
 * first-page timing stays a performance mark for the speed checks; it is not something the owner needs to read.)
 */
export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  const manifest = chrome.runtime.getManifest();
  return (
    <Dialog open={open} title="About sickofpdfs" onOpenChange={onOpenChange} actions={[{ label: 'Close', onClick: () => onOpenChange(false) }]}>
      {manifest.description !== undefined && <p className={styles.line}>{manifest.description}</p>}
      <p className={styles.line}>Version {manifest.version}</p>
      <p className={styles.line}>
        <a className={styles.link} href={chrome.runtime.getURL(NOTICES_PATH)} target="_blank" rel="noopener noreferrer">
          Open-source licences
        </a>
      </p>
    </Dialog>
  );
}
