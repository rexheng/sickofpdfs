import '../tokens/tokens.css';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../components/classes';
import { Icon } from '../icons/Icon';
import styles from './NewButton.module.css';

export interface NewButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  label?: string;
}

/**
 * Drive's "+ New" button (02 section 4.3): 56 px tall, 16 px corners, white with elevation 1 (2 on hover), a 24 px
 * `add` icon and the label 12 px after it. It passes its props and ref on, so it can be a DropdownMenu trigger.
 */
export function NewButton({ label = 'New', className, ...rest }: NewButtonProps) {
  return (
    <button type="button" {...rest} className={cx(styles.button, className)}>
      <Icon name="add" size={24} />
      <span>{label}</span>
    </button>
  );
}
