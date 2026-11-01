import { TextButton } from '@sop/ui';
import styles from './ScanHint.module.css';

export interface ScanHintProps {
  onOpenInChrome: () => void;
}

/**
 * Shown while the page in view is a scan (no text layer): selecting its text needs Chrome's viewer, which reads scans
 * (owner decision, 2026-11-01). A quiet pill at the bottom of the page area. Placeholder look: Task 23 styles it with
 * the viewer chrome.
 */
export function ScanHint({ onOpenInChrome }: ScanHintProps) {
  return (
    <div className={styles.hint} role="status">
      <TextButton label="This is a scan – open in Chrome's viewer to select text" icon="open_in_new" onClick={onOpenInChrome} />
    </div>
  );
}
