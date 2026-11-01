import styles from './Icon.module.css';
import type { IconName } from './names';

export interface IconProps {
  name: IconName;
  /** The box in px; also picks the optical size of the glyph. Drive uses 20 in toolbars and menus, 24 elsewhere. */
  size?: 20 | 24;
  /** FILL 1: the solid form, used for the selected state of an item. */
  filled?: boolean;
  className?: string;
}

/**
 * A Material Symbols Outlined icon. It is decoration: the control that holds it needs its own accessible name
 * (aria-label, or visible text).
 */
export function Icon({ name, size = 24, filled = false, className }: IconProps) {
  const classes = [styles.icon, size === 20 ? styles.s20 : styles.s24, filled ? styles.filled : undefined, className];
  return (
    <span className={classes.filter(Boolean).join(' ')} aria-hidden="true">
      {name}
    </span>
  );
}
