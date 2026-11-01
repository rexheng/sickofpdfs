import '../tokens/tokens.css';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../components/classes';
import { Icon } from '../icons/Icon';
import styles from './FilterChip.module.css';

export interface FilterChipProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  label: string;
  /** On: #c2e7ff with #001d35 text, as Drive draws a chip with a choice in it. */
  selected: boolean;
  /**
   * `menu`: it opens a list of choices, so it ends with a drop-down arrow (pass it as a DropdownMenu trigger).
   * `toggle`: it switches one filter on and off (aria-pressed) and shows a check while on.
   */
  kind: 'menu' | 'toggle';
}

/**
 * Drive's filter chip (02 section 4.5): 32 px, radius 8, a 1 px #747775 outline, Google Sans 14/20 500 in #444746,
 * 8 px apart. It passes its props and ref on to the <button>.
 */
export function FilterChip({ label, selected, kind, className, ...rest }: FilterChipProps) {
  return (
    <button
      type="button"
      {...rest}
      aria-pressed={kind === 'toggle' ? selected : undefined}
      className={cx(styles.chip, selected && styles.selected, kind === 'toggle' && selected && styles.checked, className)}
    >
      {kind === 'toggle' && selected && <Icon name="check" size={20} />}
      <span className={styles.label}>{label}</span>
      {kind === 'menu' && <Icon name="arrow_drop_down" size={20} />}
    </button>
  );
}
