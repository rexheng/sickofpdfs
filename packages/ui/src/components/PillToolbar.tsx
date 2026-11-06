import type { KeyboardEvent, ReactNode } from 'react';
import styles from './PillToolbar.module.css';

export interface PillToolbarProps {
  /** The toolbar's accessible name, such as "Document". */
  label: string;
  children: ReactNode;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Drive's toolbar pill (02 section 4.10), 40 px in the compact viewer (TB6; Drive's is 48): #333537 in the dark chrome,
 * fully rounded, 4 px 8 px padding, items 8 px apart, text in Google Sans Text 14/20 500 on-surface-variant. Text that
 * starts the pill (Drive's "Page") wants a further 16 px start margin, and 8 px more before the next separator, as in Drive.
 *
 * Every control stays a Tab stop. Left and Right also move between controls, except inside a text field, where they
 * move the caret.
 */
export function PillToolbar({ label, children }: PillToolbarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.target instanceof HTMLInputElement || event.defaultPrevented) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const at = controls.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    const next = controls[(at + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length];
    event.preventDefault();
    next?.focus();
  };
  return (
    <div role="toolbar" aria-label={label} aria-orientation="horizontal" className={styles.pill} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/** A 1x12 px outline-variant rule between groups of the pill. */
export function ToolbarSeparator() {
  return <div role="separator" aria-orientation="vertical" className={styles.separator} />;
}
