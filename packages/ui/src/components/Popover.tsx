import { Popover as RadixPopover } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cx } from './classes';
import type { DialogAction } from './Dialog';
import styles from './Popover.module.css';
import { useInheritedTheme } from './theme';

export interface PopoverProps {
  /** One element that can hold a ref and take event props: the button that opens it. */
  trigger: ReactElement;
  open: boolean;
  onOpenChange(this: void, open: boolean): void;
  title: string;
  children: ReactNode;
  /** Right-aligned, in this order (put the main action last: it is a filled tonal button). */
  actions: DialogAction[];
}

/** Gap between the trigger and the card. */
const SIDE_OFFSET = 8;

/**
 * A small card that opens under its trigger, for a short choice that belongs to it ("Backup is on hold": the reason, then "Not now"
 * and "Back up anyway"). GM3 rich tooltip shape [inf, GM3 defaults with Drive's colours]: surface-container (the library menus'
 * #f0f4f9), radius 12 px, elevation 2, 16 px in from the sides; a 14/20 500 title, 14/20 body in on-surface-variant, text-button
 * actions right-aligned. No scrim. It traps nothing: Escape, a click outside and each action close it, and focus goes back to the trigger.
 */
export function Popover({ trigger, open, onOpenChange, title, children, actions }: PopoverProps) {
  const { ref, theme, refresh } = useInheritedTheme<HTMLElement>();
  return (
    <RadixPopover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) refresh();
        onOpenChange(next);
      }}
    >
      <RadixPopover.Trigger asChild ref={ref}>
        {trigger}
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className={styles.card} data-theme={theme} side="bottom" align="end" sideOffset={SIDE_OFFSET} collisionPadding={16} aria-label={title}>
          <p className={styles.title}>{title}</p>
          <div className={styles.body}>{children}</div>
          {actions.length > 0 && (
            <div className={styles.actions}>
              {actions.map((action) => (
                <button key={action.label} type="button" className={cx(styles.action, action.primary === true && styles.primary)} onClick={action.onClick}>
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
