import { Chip } from '@sop/ui';
import styles from './ScanHint.module.css';

/** The hint's words: short on the pill, with the detail in its tooltip (TB4: the long form overlapped Comment and Notes). */
const SCAN_LABEL = 'Scanned page';
const SCAN_DETAIL = 'Scanned page: open it in Chrome’s viewer to select its text';

export interface ScanHintProps {
  /** Whether the page in view is a scan. The region stays mounted, so a screen reader reads the hint when it appears. */
  shown: boolean;
  onOpenInChrome: () => void;
}

/**
 * Shown while the page in view is a scan (no text layer): selecting its text needs Chrome's viewer, which reads scans
 * (owner decision, 2026-11-01, until text recognition lands). A quiet GM3 assist chip at the right end of the toolbar
 * pill, where Drive's signed-in viewer keeps its extra actions; it never covers the page, and never a control: it takes
 * only the room the pill has left, as "Scanned page", then its icon alone, then nothing (ScanHint.module.css). The
 * header's "Open in Chrome's viewer" and File → Open in Chrome's viewer are always there.
 */
export function ScanHint({ shown, onOpenInChrome }: ScanHintProps) {
  return (
    <div className={styles.hint} role="status">
      {shown && (
        <Chip
          tone="neutral"
          icon="document_scanner"
          label={SCAN_LABEL}
          tooltip={SCAN_DETAIL}
          aria-label={SCAN_DETAIL}
          onClick={onOpenInChrome}
          className={styles.chip}
        />
      )}
    </div>
  );
}
