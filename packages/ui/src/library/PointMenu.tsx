import '../tokens/tokens.css';
import { DropdownMenu as RadixDropdownMenu, Portal as RadixPortal } from 'radix-ui';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { cx } from '../components/classes';
import { type MenuItemDef, MenuItems } from '../components/Menu';
import menuStyles from '../components/Menu.module.css';
import styles from './PointMenu.module.css';

export interface PointMenuProps {
  /** Where the menu opens, in viewport px: the pointer for a right-click, under the ⋮ button otherwise. null: closed. */
  at: { x: number; y: number } | null;
  items: MenuItemDef[];
  /** Escape, a click outside, or after a row ran. The component is controlled: set `at` to null in reply. */
  onClose(this: void): void;
  /** The menu's accessible name. */
  label: string;
  /** `start`: the menu's left edge at the point (a right-click). `end`: its right edge (under a ⋮ button). */
  align?: 'start' | 'end' | undefined;
}

/**
 * Drive's light menu (02 section 4.9: #f0f4f9, 32 px rows, at least 320 px wide, radius 4, elevation 2) opened at a
 * point, for a row's right-click and its ⋮ button. The chosen row runs once the menu has left the page, so an action
 * that moves the focus (a dialog) keeps it; otherwise the focus goes back to where it was (the row).
 */
export function PointMenu({ at, items, onClose, label, align = 'start' }: PointMenuProps) {
  const open = at !== null;
  // The anchor keeps its last point while the menu closes, so the menu never jumps to 0,0 on the way out.
  const lastAt = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  if (at !== null) lastAt.current = at;
  const point = at ?? lastAt.current;

  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  const pending = useRef<(() => void) | null>(null);
  const runOnDetach = useCallback((el: HTMLDivElement | null) => {
    if (el !== null) return;
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);
  const rows = items.map((i): MenuItemDef => (i.kind === 'item' ? { ...i, onSelect: () => (pending.current = i.onSelect) } : i));

  return (
    <RadixDropdownMenu.Root open={open} onOpenChange={(next) => !next && onClose()} modal>
      <RadixPortal.Root asChild>
        <RadixDropdownMenu.Trigger asChild>
          <span className={styles.anchor} style={{ left: point.x, top: point.y }} aria-hidden="true" />
        </RadixDropdownMenu.Trigger>
      </RadixPortal.Root>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          ref={runOnDetach}
          className={cx(menuStyles.content, menuStyles.dropdown)}
          data-theme="light"
          aria-label={label}
          aria-labelledby={undefined}
          side="bottom"
          align={align}
          sideOffset={2}
          collisionPadding={8}
          loop
          onContextMenu={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const target = returnTo.current;
            returnTo.current = null;
            const active = document.activeElement;
            if (target?.isConnected === true && (active === null || active === document.body)) target.focus({ preventScroll: true });
          }}
        >
          <MenuItems items={rows} kind="dropdown" />
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}
