import { Chip } from '@sop/ui';
import styles from './ScanHint.module.css';

/** The hint's words: short on the pill, with the detail in its tooltip (TB4: the long form overlapped Comment and Notes). */
const SCAN_LABEL = 'Scanned page';
/** Phase 7.5: the hint shows only when this scan's text is not being read: the owner turned it off, or it could not run. */
const SCAN_DETAIL = {
  off: 'Reading text on scans is off. Turn it on in Settings → Reading, or click to open this page in Chrome’s viewer.',
  failed: 'The text on this scan couldn’t be read here. Click to open this page in Chrome’s viewer to select it.',
} as const;

export interface ScanHintProps {
  /** Whether the page in view is a scan. The region stays mounted, so a screen reader reads the hint when it appears. */
  shown: boolean;
  /** Why its text is not being read (the hover says it). */
  why?: keyof typeof SCAN_DETAIL;
  onOpenInChrome: () => void;
}

/**
 * Shown while the page in view is a scan whose text is not being read (Phase 7: reading is off in Settings, or the reader
 * could not run): selecting its text needs Chrome's viewer then. While the text is being read the header's "Reading text"
 * chip says so instead (viewer/ocr/OcrChip.tsx). A quiet GM3 assist chip at the right end of the toolbar
 * pill, where Drive's signed-in viewer keeps its extra actions; it never covers the page, and never a control: it takes
 * only the room the pill has left, as "Scanned page", then its icon alone, then nothing (ScanHint.module.css). The
 * header's "Open in Chrome's viewer" and File → Open in Chrome's viewer are always there.
 */
export function ScanHint({ shown, why = 'off', onOpenInChrome }: ScanHintProps) {
  return (
    <div className={styles.hint} role="status">
      {shown && (
        <Chip
          tone="neutral"
          icon="document_scanner"
          label={SCAN_LABEL}
          tooltip={SCAN_DETAIL[why]}
          aria-label={SCAN_DETAIL[why]}
          onClick={onOpenInChrome}
          className={styles.chip}
        />
      )}
    </div>
  );
}
