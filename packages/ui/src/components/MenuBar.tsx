import { Menubar as RadixMenubar } from 'radix-ui';
import { useCallback, useRef } from 'react';
import { cx } from './classes';
import { lastInputWasPointer } from './input-modality';
import { isCompact, type MenuDef, type MenuItemDef, MenuItems } from './Menu';
import menuStyles from './Menu.module.css';
import styles from './MenuBar.module.css';
import { useInheritedTheme } from './theme';

export interface MenuBarProps {
  menus: MenuDef[];
  /**
   * Where the focus goes when the bar's menu was closed with the pointer (an item clicked, or a click outside), instead
   * of back to its button: no focus ring is left on "File", and Space and the arrows move the pages again. Closed from
   * the keyboard (Escape, Enter), the button keeps the focus, with its ring.
   */
  returnFocus?: () => void;
}

/** How long after its menu has gone an action waits for Radix's close focus event before it runs anyway. */
const LATE_ACTION_MS = 250;

/**
 * The viewer's "File View Tools Help" bar (02 section 4.10): 24 px buttons in Google Sans Flex 14. The open menu's
 * button turns #37393b with square bottom corners, and its menu opens flush below it. Keyboard: Left and Right move
 * between buttons and between open menus, Up and Down move through items, Escape closes and puts focus back on the
 * button.
 *
 * A chosen item's action runs once the menu has closed and Radix has put the focus back on the menu's button, so an
 * action that moves the focus (Tools → Go to page focuses the page box; Help opens a dialog, which then gives the
 * focus back to that button when it closes) keeps it.
 */
export function MenuBar({ menus, returnFocus }: MenuBarProps) {
  const { ref, theme, refresh } = useInheritedTheme<HTMLDivElement>();
  const pending = useRef<(() => void) | null>(null);
  // The open menu's id, '' when none: moving from File to View closes File's menu too, but the bar stays open.
  const openMenu = useRef('');
  const runPending = useCallback(() => {
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);
  // Backstop: if the close focus event never comes, the action still runs shortly after the menu is gone.
  const onDetach = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === null && pending.current !== null) setTimeout(runPending, LATE_ACTION_MS);
    },
    [runPending],
  );
  const deferred = (items: MenuItemDef[]): MenuItemDef[] =>
    items.map((i) =>
      i.kind === 'item'
        ? {
            ...i,
            onSelect: () => {
              pending.current = i.onSelect;
            },
          }
        : i,
    );
  return (
    <RadixMenubar.Root
      ref={ref}
      className={styles.bar}
      loop
      onValueChange={(value) => {
        openMenu.current = value;
        if (value !== '') refresh();
      }}
    >
      {menus.map((menu) => (
        <RadixMenubar.Menu key={menu.id} value={menu.id}>
          <RadixMenubar.Trigger className={styles.trigger}>{menu.label}</RadixMenubar.Trigger>
          <RadixMenubar.Portal>
            <RadixMenubar.Content
              ref={onDetach}
              className={cx(menuStyles.content, menuStyles.menubar, isCompact(menu.items) && menuStyles.compact)}
              data-theme={theme}
              align="start"
              sideOffset={0}
              collisionPadding={8}
              loop
              // Radix's own handler (after this one) focuses the menu's button. Closed with the pointer, the focus then
              // moves on to returnFocus's place; the chosen action runs after that, so it can move the focus itself.
              onCloseAutoFocus={() => {
                if (returnFocus !== undefined && openMenu.current === '' && lastInputWasPointer()) queueMicrotask(returnFocus);
                if (pending.current !== null) queueMicrotask(runPending);
              }}
            >
              <MenuItems items={deferred(menu.items)} kind="menubar" />
            </RadixMenubar.Content>
          </RadixMenubar.Portal>
        </RadixMenubar.Menu>
      ))}
    </RadixMenubar.Root>
  );
}
