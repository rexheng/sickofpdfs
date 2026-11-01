import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactElement } from 'react';
import { useInheritedTheme } from './theme';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  label: string;
  /** Shown after the label in brackets, as Drive does: "Download (Ctrl+S)". */
  shortcut?: string;
  /** One element that can hold a ref and take event props: a button, or a component that passes them on. */
  children: ReactElement;
}

/** Gap between the anchor and the tooltip, as measured in Drive (02 section 4.9: "about 4 px below the anchor"). */
const SIDE_OFFSET = 4;

/**
 * Drive's tooltip (02 sections 4.9 and 4.10): 12/16 text on the inverse surface, 4 px below the anchor. Light pages
 * get #303030 with #f2f2f2 text; the dark viewer chrome gets #e3e3e3 with #303030 text. It shows on hover and on
 * keyboard focus, and hides on Escape.
 */
export function Tooltip({ label, shortcut, children }: TooltipProps) {
  const { ref, theme, refresh } = useInheritedTheme<HTMLElement>();
  const text = shortcut === undefined ? label : `${label} (${shortcut})`;
  return (
    <RadixTooltip.Provider delayDuration={500} skipDelayDuration={300} disableHoverableContent>
      <RadixTooltip.Root onOpenChange={(open) => open && refresh()}>
        <RadixTooltip.Trigger asChild ref={ref}>
          {children}
        </RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className={styles.tooltip}
            data-theme={theme}
            side="bottom"
            sideOffset={SIDE_OFFSET}
            collisionPadding={8}
          >
            {text}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
