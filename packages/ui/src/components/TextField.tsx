import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cx } from './classes';
import styles from './TextField.module.css';

export interface TextFieldProps
  extends Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'type' | 'width' | 'aria-label'> {
  value: string;
  onChange(this: void, v: string): void;
  /** The accessible name. It is not drawn: the field sits next to its own visible words ("Page"). */
  label: string;
  /** "search" gives role searchbox and shows the label as the placeholder. */
  type?: 'text' | 'search' | 'password';
  /** Width in px; without it the field fills the space it is given. */
  width?: number;
  /** Draws the error outline and sets aria-invalid. */
  invalid?: boolean;
  /** Enter was pressed (not while an input method is composing). */
  onEnter?(this: void, e: KeyboardEvent): void;
}

/**
 * A 1 px outlined text box, radius 4 px (Drive's page box in the viewer toolbar, 02 section 4.10). Focus draws a 2 px
 * primary outline. In a PillToolbar it is the compact 24 px form with centred text; elsewhere it is 40 px tall.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { value, onChange, label, type = 'text', width, invalid = false, onEnter, className, style, onKeyDown, ...rest },
  ref,
) {
  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      value={value}
      aria-label={label}
      aria-invalid={invalid ? true : undefined}
      placeholder={rest.placeholder ?? (type === 'search' ? label : undefined)}
      className={cx(styles.field, className)}
      style={width === undefined ? style : { ...style, inlineSize: width }}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) onEnter?.(event.nativeEvent);
      }}
    />
  );
});
