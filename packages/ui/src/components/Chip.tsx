import type { ComponentPropsWithRef } from 'react';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { cx } from './classes';
import styles from './Chip.module.css';
import { Tooltip } from './Tooltip';

export interface ChipProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'onClick' | 'disabled'> {
  label: string;
  /**
   * Words after the label, with their own separator (" · bank statement", ": view only"), that a narrow place may leave
   * out (`[data-chip-detail] { display: none }`); the label alone must still say the state. Shown, they are part of the
   * chip's name.
   */
  detail?: string;
  icon?: IconName;
  /**
   * saved: tonal (secondary-container), the "Saved to library" state.
   * attention: outlined with primary text, asks for a decision ("Not sure: Save?").
   * neutral: outlined with muted text ("Not saved").
   */
  tone: 'neutral' | 'saved' | 'attention';
  tooltip?: string;
  onClick?: () => void;
  disabled?: boolean;
}

/** The GM3 chip: 32 px tall, radius 8 px, Google Sans Text 14/20 500, a 2 px focus ring. */
export function Chip({ label, detail, icon, tone, tooltip, onClick, disabled = false, className, ...rest }: ChipProps) {
  const chip = (
    <button
      type="button"
      {...rest}
      className={cx(styles.chip, styles[tone], icon !== undefined && styles.withIcon, className)}
      disabled={disabled}
      onClick={onClick}
    >
      {icon !== undefined && <Icon name={icon} size={20} />}
      <span className={styles.label}>
        {label}
        {detail !== undefined && <span data-chip-detail="">{detail}</span>}
      </span>
    </button>
  );
  return tooltip === undefined ? chip : <Tooltip label={tooltip}>{chip}</Tooltip>;
}
