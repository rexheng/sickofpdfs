import { Chip } from '@sop/ui';
import styles from './ScanHint.module.css';

export interface ScanHintProps {
  /** Whether the page in view is a scan. The region stays mounted, so a screen reader reads the hint when it appears. */
  shown: boolean;
  onOpenInChrome: () => void;
}

/**
 * Shown while the page in view is a scan (no text layer): selecting its text needs Chrome's viewer, which reads scans
 * (owner decision, 2026-11-01, until text recognition lands). A quiet GM3 assist chip at the right end of the toolbar
 * pill, where Drive's signed-in viewer keeps its extra actions; it never covers the page.
 */
export function ScanHint({ shown, onOpenInChrome }: ScanHintProps) {
  return (
    <div className={styles.hint} role="status">
      {shown && (
        <Chip
          tone="neutral"
          icon="document_scanner"
          label="Scanned page: open in Chrome to select text"
          onClick={onOpenInChrome}
          className={styles.chip}
        />
      )}
    </div>
  );
}
