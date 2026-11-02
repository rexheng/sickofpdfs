import '../tokens/tokens.css';
import { cx } from '../components/classes';
import { Icon } from '../icons/Icon';
import styles from './SectionHeading.module.css';

export interface SectionHeadingProps {
  label: string;
  /** How many items the group holds, shown after the label. */
  count: number | null;
  collapsed: boolean;
  onToggle(this: void): void;
  /** The list's own heading style (padding, divider). */
  className?: string;
}

/**
 * A group's heading that folds the group away and back: a chevron, the label and the count, as Drive's folded sections
 * on Home. It is a row of the grid with one row header, so a screen reader names the group and says whether it is open.
 */
export function SectionHeading({ label, count, collapsed, onToggle, className }: SectionHeadingProps) {
  return (
    <div role="row" className={cx(styles.row, className)}>
      <div role="rowheader" className={styles.cell}>
        <button type="button" className={styles.button} aria-expanded={!collapsed} onClick={onToggle}>
          <span className={cx(styles.chevron, collapsed && styles.folded)}>
            <Icon name="keyboard_arrow_down" size={20} />
          </span>
          <span className={styles.label}>{label}</span>
          {count !== null && <span className={styles.count}>{count}</span>}
        </button>
      </div>
    </div>
  );
}
