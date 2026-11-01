import '../../tokens/comments.css';
import { cx } from '../classes';
import { Tooltip } from '../Tooltip';
import styles from './MovedLabel.module.css';

export interface MovedLabelProps {
  /** "Show where it was": the viewer shows the place the note was made on. Without it, only the label shows. */
  onShowOriginal?: () => void;
  /** Keep "Show where it was" in view (the active card). Otherwise it appears on hover or keyboard focus. */
  revealed?: boolean;
  className?: string;
}

/**
 * The quiet "Moved" label of contracts D7: the text under this note changed (a new version or a stamped re-download),
 * so the note was placed on the closest match. A close-match placement is never silent (Hypothesis #7571).
 * "Show where it was" appears on hover.
 */
export function MovedLabel({ onShowOriginal, revealed = false, className }: MovedLabelProps) {
  return (
    <div className={cx(styles.row, revealed && styles.revealed, className)}>
      <Tooltip label="The text changed, so this note is on the closest match">
        <span className={styles.label}>Moved</span>
      </Tooltip>
      {onShowOriginal !== undefined && (
        <button type="button" className={styles.action} onClick={() => onShowOriginal()}>
          Show where it was
        </button>
      )}
    </div>
  );
}

/** "Couldn't place": the note's passage is not in this copy of the PDF, so nothing is drawn on the page for it. */
export function UnplacedLabel({ className }: { className?: string }) {
  return (
    <div className={cx(styles.row, className)}>
      <Tooltip label="This text isn't in this copy of the PDF">
        <span className={styles.label}>Couldn't place</span>
      </Tooltip>
    </div>
  );
}
