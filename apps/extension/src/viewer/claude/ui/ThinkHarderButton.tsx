// "Think harder" under the newest everyday answer of a thread (spec "Model and cost"; plan §4 F): one click asks the same
// question again with the owner's Think harder model (Opus 5.5 by default). The new reply comes below, labelled "Thought
// harder"; the first one stays. Hovering says which model answers and about what it costs (cost-words.ts), so a bigger
// bill is never a surprise.
import { Icon, Tooltip } from '@sop/ui';
import { costWords } from './cost-words';
import styles from './ThinkHarderButton.module.css';

export interface ThinkHarderButtonProps {
  /** The Think harder model's name ("Claude Opus 5.5"); null before setup. */
  model: string | null;
  /** About what it costs, in dollars; null when there is no estimate. */
  usd?: number | null;
  /** Greyed out while another reply in the thread is being written. */
  disabled?: boolean;
  onClick(this: void): void;
}

/** The tooltip: "Ask again with Claude Opus 5.5 · about 5¢". */
export function thinkHarderTip(model: string | null, usd: number | null | undefined): string {
  const who = model === null ? 'Ask again with your Think harder model' : `Ask again with ${model}`;
  return usd === null || usd === undefined || !Number.isFinite(usd) ? who : `${who} · ${costWords(usd)}`;
}

export function ThinkHarderButton({ model, usd = null, disabled = false, onClick }: ThinkHarderButtonProps) {
  return (
    <Tooltip label={thinkHarderTip(model, usd)}>
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
