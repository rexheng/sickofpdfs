import type { ComponentPropsWithRef } from 'react';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { cx } from './classes';
import styles from './IconButton.module.css';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'onClick' | 'disabled'> {
  icon: IconName;
  /** The accessible name and the tooltip text. */
  label: string;
  onClick?: () => void;
  /** 32: toolbar pill and menus, 20 px icon. 40: header, rail and top bar, 24 px icon. */
  size?: 32 | 40;
  /**
   * The glyph size when it differs from the size's own: Drive's viewer header has a 24 px close (or back) icon in a
   * 32 px button, and a 20 px "open in new tab" icon in a 40 px one (02 section 4.10).
   */
  iconSize?: 20 | 24;
  /** Set it to make a toggle button (aria-pressed). True draws the selected state and the filled icon. */
  pressed?: boolean;
  disabled?: boolean;
  /** Shown in the tooltip: "Download (Ctrl+S)". */
  shortcut?: string;
  /**
   * Why the button is off, when it is off for a real reason ("400% is the largest size"). The tooltip then says
   * "Zoom in: 400% is the largest size" instead of the shortcut, and screen readers read it as the description.
   */
  disabledReason?: string | undefined;
}

/**
 * Drive's round icon button (02 section 4.10), with a tooltip. It passes other button props and its ref on to the
 * <button>, so it can be the trigger of a DropdownMenu.
 */
export function IconButton({ icon, label, onClick, size = 32, iconSize, pressed, disabled = false, shortcut, disabledReason, className, ...rest }: IconButtonProps) {
  const why = disabled && disabledReason !== undefined ? disabledReason : undefined;
  return (
    <Tooltip label={why === undefined ? label : `${label}: ${why}`} {...(why === undefined && shortcut !== undefined ? { shortcut } : {})}>
      <button
        type="button"
        {...rest}
        className={cx(styles.button, size === 40 ? styles.s40 : styles.s32, className)}
        aria-label={label}
        aria-pressed={pressed}
        aria-description={why}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={icon} size={iconSize ?? (size === 40 ? 24 : 20)} filled={pressed === true} />
      </button>
    </Tooltip>
  );
}
