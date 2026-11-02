// Several readings selected (Ctrl+click or Shift+click): Drive's selection bar takes the filter chips' place, with how
// many are selected and what can be done to all of them at once.
import { IconButton } from '@sop/ui';
import { QuietButton } from '@sop/ui/library';
import styles from './SelectionBar.module.css';

export interface SelectionBarProps {
  count: number;
  onClear(this: void): void;
  /** Tags for every selected reading; absent where there are no tags. */
  onTags?: (() => void) | undefined;
  onStar?: (() => void) | undefined;
  onTrash?: (() => void) | undefined;
}

export function SelectionBar({ count, onClear, onTags, onStar, onTrash }: SelectionBarProps) {
  return (
    <div className={styles.bar} role="toolbar" aria-label={`${count} selected`}>
      <IconButton icon="close" size={32} label="Clear the selection" onClick={onClear} />
      <span className={styles.count}>{count} selected</span>
      <span className={styles.actions}>
        {onTags !== undefined && <QuietButton icon="sell" label="Tags" onClick={onTags} />}
        {onStar !== undefined && <IconButton icon="star" size={32} label="Add to Starred" onClick={onStar} />}
        {onTrash !== undefined && <IconButton icon="delete" size={32} label="Move to Trash" onClick={onTrash} />}
      </span>
    </div>
  );
}
