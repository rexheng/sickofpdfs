import type { ComponentPropsWithRef } from 'react';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { cx } from './classes';
import styles from './TextButton.module.css';

export interface TextButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'onClick' | 'disabled'> {
  label: string;
  /** A leading 20 px icon, such as `arrow_back` for "Back to page". */
  icon?: IconName;
  onClick?: () => void;
  disabled?: boolean;
}

/**
 * GM3 text button as Drive draws it: 40 px pill, Google Sans Flex 14/20 500 in the primary colour (#0b57d0 light,
 * #a8c7fa dark). It passes other button props and its ref on, so it can be a DropdownMenu trigger.
 */
export function TextButton({ label, icon, onClick, disabled = false, className, ...rest }: TextButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(styles.button, icon !== undefined && styles.withIcon, className)}
      disabled={disabled}
      onClick={onClick}
    >
      {icon !== undefined && <Icon name={icon} size={20} />}
      <span className={styles.label}>{label}</span>
    </button>
  );
}
