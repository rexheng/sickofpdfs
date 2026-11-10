// "Think harder" under the newest everyday answer of a thread (spec "Model and cost"; plan §4 F): one click asks the same
// question again with the owner's Think harder model (Opus 5.5 by default). The new reply comes below, labelled "Thought
// harder"; the first one stays. R107: the card names no model and no cost. What a question costs is in Settings → Claude,
// and a Think harder question that costs more than the owner's limit asks first, with the amount (ClaudeConfirmDialog).
import { Icon, Tooltip } from '@sop/ui';
import styles from './ThinkHarderButton.module.css';

export interface ThinkHarderButtonProps {
  /** Greyed out while another reply in the thread is being written. */
  disabled?: boolean;
  onClick(this: void): void;
}

/** The tooltip, in plain words. */
export const THINK_HARDER_TIP = 'Ask again, thinking more carefully';

export function ThinkHarderButton({ disabled = false, onClick }: ThinkHarderButtonProps) {
  return (
    <Tooltip label={THINK_HARDER_TIP}>
      <button
        type="button"
        className={styles.button}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        <Icon name="psychology" size={20} className={styles.icon} />
        <span>Think harder</span>
      </button>
    </Tooltip>
  );
}
