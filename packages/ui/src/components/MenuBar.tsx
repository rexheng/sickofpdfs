import { Menubar as RadixMenubar } from 'radix-ui';
import { cx } from './classes';
import { isCompact, type MenuDef, MenuItems } from './Menu';
import menuStyles from './Menu.module.css';
import styles from './MenuBar.module.css';
import { useInheritedTheme } from './theme';

export interface MenuBarProps {
  menus: MenuDef[];
}

/**
 * The viewer's "File View Tools Help" bar (02 section 4.10): 24 px buttons in Google Sans Flex 14. The open menu's
 * button turns #37393b with square bottom corners, and its menu opens flush below it. Keyboard: Left and Right move
 * between buttons and between open menus, Up and Down move through items, Escape closes and puts focus back on the
 * button.
 */
export function MenuBar({ menus }: MenuBarProps) {
  const { ref, theme, refresh } = useInheritedTheme<HTMLDivElement>();
  return (
    <RadixMenubar.Root ref={ref} className={styles.bar} loop onValueChange={(value) => value !== '' && refresh()}>
      {menus.map((menu) => (
        <RadixMenubar.Menu key={menu.id} value={menu.id}>
          <RadixMenubar.Trigger className={styles.trigger}>{menu.label}</RadixMenubar.Trigger>
          <RadixMenubar.Portal>
            <RadixMenubar.Content
              className={cx(menuStyles.content, menuStyles.menubar, isCompact(menu.items) && menuStyles.compact)}
              data-theme={theme}
              align="start"
              sideOffset={0}
              collisionPadding={8}
              loop
            >
              <MenuItems items={menu.items} kind="menubar" />
            </RadixMenubar.Content>
          </RadixMenubar.Portal>
        </RadixMenubar.Menu>
      ))}
    </RadixMenubar.Root>
  );
}
