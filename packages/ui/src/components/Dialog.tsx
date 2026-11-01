import { Dialog as RadixDialog } from 'radix-ui';
import { type ReactNode, useRef } from 'react';
import { cx } from './classes';
import styles from './Dialog.module.css';
import { useInheritedTheme } from './theme';

export interface DialogAction {
  label: string;
  onClick: () => void;
  /** The main action: a filled button. The others are text buttons. */
  primary?: boolean;
}

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** Right-aligned, in this order (put the primary action last). */
  actions: DialogAction[];
  onOpenChange(this: void, open: boolean): void;
}

/**
 * A GM3 basic dialog: title, body and actions on --dialog-bg (white on light pages, #282a2c in the dark viewer
 * chrome), radius 28 px, over a 32% scrim. It traps focus, closes on Escape and on a click outside (both through
 * onOpenChange(false)), and puts focus back where it was.
 */
export function Dialog({ open, title, children, actions, onOpenChange }: DialogProps) {
  // The dialog has no trigger, so a hidden probe where it is placed tells it the theme of that place.
  const { ref, theme } = useInheritedTheme<HTMLSpanElement>();
  // Radix gives focus back to a Dialog.Trigger; this dialog is opened by state, so it remembers the opener itself.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <>
      <span ref={ref} hidden />
      <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className={styles.scrim} />
          <RadixDialog.Content
            className={styles.dialog}
            data-theme={theme}
            aria-modal="true"
            aria-describedby={undefined}
            onOpenAutoFocus={() => {
              opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }}
            onCloseAutoFocus={(event) => {
              if (opener.current?.isConnected !== true) return;
              event.preventDefault();
              opener.current.focus();
              opener.current = null;
            }}
          >
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            <div className={styles.body}>{children}</div>
            {actions.length > 0 && (
              <div className={styles.actions}>
                {actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className={cx(styles.action, action.primary === true && styles.primary)}
                    onClick={action.onClick}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </>
  );
}
