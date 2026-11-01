import type { MarkColor } from '@sop/core';
import { DropdownMenu as RadixDropdownMenu, Portal as RadixPortal } from 'radix-ui';
import { type KeyboardEvent, useCallback, useLayoutEffect, useRef } from 'react';
import { cx } from './classes';
import { ColorSwatches, markColorForKey } from './ColorSwatches';
import styles from './ContextMenu.module.css';
import { type MenuItemDef, MenuItems } from './Menu';
import menuStyles from './Menu.module.css';

export interface ContextMenuProps {
  /**
   * Where the menu opens, in viewport px (clientX / clientY): the pointer for a right-click, or the end of the
   * selection for the menu key and Shift+F10. null means closed. The component never opens by itself.
   */
  at: { x: number; y: number } | null;
  /** The rows, as in DropdownMenu and MenuBar (icons, shortcut hints, checks, separators, disabled rows). A chosen
   * row's onSelect runs just after the menu has closed. */
  items: MenuItemDef[];
  /** The colour row at the top. `value` is the current colour (checked). A pick closes the menu, then runs `onPick`. */
  swatches?: { value: MarkColor; onPick(this: void, c: MarkColor): void };
  /**
   * The menu wants to close: Escape, Tab, a click or right-click outside, or after an item or a colour ran. Set `at`
   * to null in reply; the component is controlled.
   */
  onClose(this: void): void;
  /** The menu's accessible name. */
  label?: string;
}

/** Keys with a name that a row's hint may be, and that then run the row from anywhere in the menu, as a letter does. */
const NAMED_KEYS: ReadonlySet<string> = new Set(['Delete']);

/** Radix's own context-menu placement: the menu's top-left corner 2 px right of the pointer, so the release of the
 * right button never lands on the first item. It flips to the left of the pointer, and slides up until its bottom
 * meets the pointer, when there is no room. */
const POINTER_GAP = 2;

/**
 * The right-click mark-up menu (plan S6): Drive's dark viewer menu (#282a2c, 288 px, 36 px rows, ruling R15, owner
 * decision), opened at a point. It is always dark, whatever the page's theme, because the whole viewer is.
 *
 * - Rows come from Task 14's MenuItems, so they match the File menu exactly: 20 px icon 12 px in, label 48 px in,
 *   shortcut hint right-aligned, 17 px separators, disabled rows at 38%.
 * - `swatches` adds the colour row (ColorSwatches) above the rows.
 * - Keyboard: Up and Down, Home and End, Enter and Space, Escape and typeahead as in every Radix menu. The keys 1 to 5
 *   pick a colour from anywhere in the menu, and a one-letter hint (H), or the hint Delete, runs its row. Both are consumed
 *   (preventDefault and stopPropagation), so the viewer's own shortcut handler never sees them a second time.
 *   Chords such as Ctrl+U are left to the viewer.
 * - It is modal, like a native context menu: a click outside only closes it, and the page does not scroll under it.
 *   A right-click outside closes it too, and the viewer gets that right-click, so it can open the menu there.
 * - The chosen row or colour runs as the menu's element leaves the page: in the same task as the click or key, right
 *   after the render that closes the menu (about 7 ms after the click in a production build). A modal Radix menu traps
 *   focus while it is mounted, so an action that moves focus, such as Comment opening the note box, would otherwise be
 *   undone. Keep the viewer's open/closed state small, so that closing re-renders little.
 * - Focus goes back to where it was when the menu closes, unless the chosen action moved it.
 * - The document's text selection survives: pressing on the menu never starts a new selection.
 */
export function ContextMenu({ at, items, swatches, onClose, label = 'Mark up' }: ContextMenuProps) {
  const open = at !== null;
  // The anchor keeps its last point while the menu closes, so the content never jumps to 0,0 on the way out.
  const lastAt = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  if (at !== null) lastAt.current = at;
  const point = at ?? lastAt.current;

  // What had focus before the menu took it. Read in a layout effect: Radix moves focus into the menu after that.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  // The chosen action. It runs when the content element is detached: the focus trap can only send focus back into the
  // menu, and a detached menu cannot take it, so the action is free to move focus. (Radix's onCloseAutoFocus would be
  // safe too, but it comes about two frames later, which the 50 ms mark budget cannot spare.)
  const pending = useRef<(() => void) | null>(null);
  const choose = (action: () => void) => {
    pending.current = action;
  };
  const runPendingOnDetach = useCallback((el: HTMLDivElement | null) => {
    if (el !== null) return;
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);
  const rows = items.map((i): MenuItemDef => (i.kind === 'item' ? { ...i, onSelect: () => choose(i.onSelect) } : i));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const color = swatches === undefined ? null : markColorForKey(e);
    let action: (() => void) | null = null;
    if (swatches !== undefined && color !== null) {
      action = () => swatches.onPick(color);
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key.length === 1 || NAMED_KEYS.has(e.key))) {
      const key = e.key.toLowerCase();
      const row = items.find(
        (i) => i.kind === 'item' && i.disabled !== true && i.shortcut !== undefined && i.shortcut.toLowerCase() === key && (key.length === 1 || NAMED_KEYS.has(i.shortcut)),
      );
      if (row?.kind === 'item') action = row.onSelect;
    }
    if (action === null) return;
    e.preventDefault();
    e.stopPropagation();
    choose(action);
    onClose();
  };

  return (
    <RadixDropdownMenu.Root open={open} onOpenChange={(next) => !next && onClose()} modal>
      <RadixPortal.Root asChild>
        <RadixDropdownMenu.Trigger asChild>
          <span className={styles.anchor} style={{ left: point.x, top: point.y }} aria-hidden="true" />
        </RadixDropdownMenu.Trigger>
      </RadixPortal.Root>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          ref={runPendingOnDetach}
          className={cx(menuStyles.content, menuStyles.dropdown)}
          data-theme="dark"
          aria-label={label}
          // The anchor is a hidden point, so it cannot name the menu
          aria-labelledby={undefined}
          side="right"
          sideOffset={POINTER_GAP}
          align="start"
          collisionPadding={8}
          loop
          onKeyDown={onKeyDown}
          // A press inside the menu must not collapse the page's selection (the marks act on it)
          onMouseDown={(e) => e.preventDefault()}
          // No browser menu on top of ours
          onContextMenu={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const target = returnFocusTo.current;
            returnFocusTo.current = null;
            const active = document.activeElement;
            if (target?.isConnected === true && (active === null || active === document.body)) {
              target.focus({ preventScroll: true });
            }
          }}
        >
          {swatches !== undefined && <ColorSwatches value={swatches.value} onPick={(c) => choose(() => swatches.onPick(c))} />}
          <MenuItems items={rows} kind="dropdown" />
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}
