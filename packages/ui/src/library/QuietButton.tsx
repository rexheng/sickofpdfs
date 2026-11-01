import '../tokens/tokens.css';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../components/classes';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import styles from './QuietButton.module.css';

export interface QuietButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  label: string;
  icon: IconName;
}

/**
 * Drive's grey text button with a leading icon, as its table header's "Sort" (02 section 4.6): 40 px, radius 20,
 * padding 0 16 0 12, Google Sans Flex 14 500 in #444746. It passes its props and ref on (a DropdownMenu trigger).
 */
export function QuietButton({ label, icon, className, ...rest }: QuietButtonProps) {
  return (
    <button type="button" {...rest} className={cx(styles.button, className)}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}
