import '../tokens/tokens.css';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../components/classes';
import { Icon } from '../icons/Icon';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'children' | 'role'> {
  checked: boolean;
  onChange(this: void, checked: boolean): void;
}

/**
 * The GM3 switch, for a setting that is on or off (Settings): a 52 × 32 track. Off, it is outlined in #747775 with a
 * 16 px handle; on, it is filled in primary with a 24 px white handle that shows a check. Name it with `aria-label` or
 * `aria-labelledby` (the row's words). Space and Enter switch it, as a button does.
 */
export function Switch({ checked, onChange, className, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      {...rest}
      role="switch"
      aria-checked={checked}
      className={cx(styles.switch, checked && styles.on, className)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.handle} aria-hidden="true">
        {checked && <Icon name="check" size={20} className={styles.check} />}
      </span>
    </button>
  );
}
