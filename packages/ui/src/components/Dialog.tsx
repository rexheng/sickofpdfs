import { Dialog as RadixDialog } from 'radix-ui';
import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cx } from './classes';
import styles from './Dialog.module.css';
import { lastInputWasPointer } from './input-modality';
import { useInheritedTheme } from './theme';

export interface DialogAction {
  label: string;
  onClick: () => void;
  /** The main action: a filled button. The others are text buttons. */
  primary?: boolean;
  /** Greyed out: there is nothing to do yet (Save before a key is chosen). */
  disabled?: boolean;
}

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  /** Right-aligned, in this order (put the primary action last). */
  actions: DialogAction[];
  onOpenChange(this: void, open: boolean): void;
  /**
   * Name the dialog with a `title` attribute instead of aria-labelledby. For a dialog whose title contains the label of
   * a field inside it (the PDF password dialog's "password"): a lookup of a control by its label then finds the field
   * alone. Screen readers announce the same name. The content carries an empty title, so no tooltip shows over it.
   */
  nameFromTitleAttribute?: boolean;
  /**
   * Put the focus on the primary action when the dialog opens from the keyboard (Enter then does it), instead of on the
   * first action. Opened with the pointer, Enter does it too. For a question whose main answer is safe, such as "Print
   * with marks".
   */
  focusPrimary?: boolean;
  /**
   * Asked as the dialog closes: the element that takes the focus now (the viewer's note box that a question was asked
   * for), instead of the one that had it before the dialog opened. Null keeps the usual return.
   */
  focusOnClose?: () => HTMLElement | null;
}

/** A text field takes the focus wherever the dialog was opened from: typing goes straight into it. */
const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)';

/** The controls Tab reaches, in order (Radix's own list, without the ones that cannot take the focus). */
const TABBABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A GM3 basic dialog: title, body and actions on --dialog-bg (white on light pages, #282a2c in the dark viewer
 * chrome), radius 28 px, over a 32% scrim. It traps focus, closes on Escape and on a click outside (both through
 * onOpenChange(false)), and puts focus back where it was.
 *
 * Focus rings show for keyboard use only (TB4). Opened from the keyboard, the first action (or the primary one) takes
 * the focus with its ring, as keyboard users expect. Opened with the pointer, the dialog itself takes it: no button
 * wears a ring the owner did not choose (a ringed "No" beside a filled "Save" read as two choices), and the first Tab
 * then reaches the first control, ring and all. A dialog with a text field always gives the field the focus.
 */
export function Dialog({ open, title, children, actions, onOpenChange, nameFromTitleAttribute = false, focusPrimary = false, focusOnClose }: DialogProps) {
  // An empty title stops the dialog's own title attribute from showing as a tooltip over its content.
  const quiet = nameFromTitleAttribute ? { title: '' } : {};
  // The dialog has no trigger, so a hidden probe where it is placed tells it the theme of that place.
  const { ref, theme } = useInheritedTheme<HTMLSpanElement>();
  // Radix gives focus back to a Dialog.Trigger; this dialog is opened by state, so it remembers the opener itself.
  const opener = useRef<HTMLElement | null>(null);
  const primary = useRef<HTMLButtonElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const primaryAction = actions.find((a) => a.primary === true);
  // While the dialog itself has the focus (opened with the pointer): Enter is the safe primary answer where there is one,
  // and Shift+Tab reaches the last control (the focus trap would otherwise keep it on the dialog).
  const onSurfaceKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' && focusPrimary && primaryAction !== undefined) {
      event.preventDefault();
      primaryAction.onClick();
    } else if (event.key === 'Tab' && event.shiftKey) {
      const last = [...event.currentTarget.querySelectorAll<HTMLElement>(TABBABLE)].at(-1);
      if (last === undefined) return;
      event.preventDefault();
      last.focus();
    }
  };
  return (
    <>
      <span ref={ref} hidden />
      <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className={styles.scrim} />
          <RadixDialog.Content
            ref={surface}
            className={styles.dialog}
            data-theme={theme}
            aria-modal="true"
            aria-describedby={undefined}
            {...(nameFromTitleAttribute ? { 'aria-labelledby': undefined, title } : {})}
            onKeyDown={onSurfaceKey}
            onOpenAutoFocus={(event) => {
              opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              const content = surface.current;
              if (lastInputWasPointer() && content !== null && content.querySelector(FIELD) === null) {
                event.preventDefault();
                content.focus({ preventScroll: true });
                return;
              }
              if (focusPrimary && primary.current !== null) {
                event.preventDefault();
                primary.current.focus();
              }
            }}
            onCloseAutoFocus={(event) => {
              const next = focusOnClose?.() ?? null;
              if (next?.isConnected === true) {
                event.preventDefault();
                opener.current = null;
                next.focus({ preventScroll: true });
                return;
              }
              if (opener.current?.isConnected !== true) return;
              event.preventDefault();
              opener.current.focus();
              opener.current = null;
            }}
          >
            <RadixDialog.Title className={styles.title} {...quiet}>
              {title}
            </RadixDialog.Title>
            <div className={styles.body} {...quiet}>
              {children}
            </div>
            {actions.length > 0 && (
              <div className={styles.actions} {...quiet}>
                {actions.map((action) => (
                  <button
                    key={action.label}
                    ref={action.primary === true ? primary : undefined}
                    type="button"
                    className={cx(styles.action, action.primary === true && styles.primary)}
                    disabled={action.disabled === true}
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
