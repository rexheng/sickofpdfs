import { DropdownMenu as RadixDropdownMenu, Menubar as RadixMenubar } from 'radix-ui';
import type { ReactElement } from 'react';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { cx } from './classes';
import styles from './Menu.module.css';
import { useInheritedTheme } from './theme';

export type MenuItemDef =
  | {
      kind: 'item';
      id: string;
      label: string;
      icon?: IconName;
      /** Right-aligned and muted, as Drive writes them: "Ctrl+S", "Ctrl+P", "D". */
      shortcut?: string;
      disabled?: boolean;
      /** Set it (true or false) to make a checkbox item: the icon slot shows a check when true and is empty when false. */
      checked?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' };

export interface MenuDef {
  id: string;
  label: string;
  items: MenuItemDef[];
}

/**
 * Separators only ever sit between groups: one at the start or the end of a menu, or two in a row, is dropped.
 */
export function tidySeparators(items: readonly MenuItemDef[]): MenuItemDef[] {
  const out: MenuItemDef[] = [];
  for (const item of items) {
    if (item.kind === 'separator' && (out.length === 0 || out.at(-1)?.kind === 'separator')) continue;
    out.push(item);
  }
  if (out.at(-1)?.kind === 'separator') out.pop();
  return out;
}

/** "Ctrl+S" as aria-keyshortcuts writes it ("Control+S"). */
function ariaShortcut(shortcut: string): string {
  return shortcut.replace(/\bCtrl\b/gu, 'Control');
}

/** A menu that has no icons, checks or shortcuts is a short list of labels (zoom levels): it gets the compact form. */
export function isCompact(items: readonly MenuItemDef[]): boolean {
  return !items.some((i) => i.kind === 'item' && (i.icon !== undefined || i.checked !== undefined || i.shortcut !== undefined));
}

const PARTS = {
  dropdown: {
    Item: RadixDropdownMenu.Item,
    CheckboxItem: RadixDropdownMenu.CheckboxItem,
    Separator: RadixDropdownMenu.Separator,
  },
  menubar: {
    Item: RadixMenubar.Item,
    CheckboxItem: RadixMenubar.CheckboxItem,
    Separator: RadixMenubar.Separator,
  },
} as const;

/** The rows of a menu, shared by DropdownMenu and MenuBar. */
export function MenuItems({ items, kind }: { items: readonly MenuItemDef[]; kind: keyof typeof PARTS }) {
  const { Item, CheckboxItem, Separator } = PARTS[kind];
  const rows = tidySeparators(items);
  // One icon column for the whole menu, so every label starts at the same x (48 px in, as in Drive).
  const iconColumn = rows.some((i) => i.kind === 'item' && (i.icon !== undefined || i.checked !== undefined));
  return rows.map((item, index) => {
    if (item.kind === 'separator') return <Separator key={`separator-${index}`} className={styles.separator} />;
    // A checkbox item uses the icon slot for its check only (empty when unchecked), as in Docs' View menu.
    const leading = item.checked === undefined ? item.icon : item.checked ? 'check' : undefined;
    const body = (
      <>
        {iconColumn && (
          <span className={styles.icon}>{leading !== undefined && <Icon name={leading} size={20} />}</span>
        )}
        <span className={styles.label}>{item.label}</span>
        {item.shortcut !== undefined && (
          <span className={styles.shortcut} aria-hidden="true">
            {item.shortcut}
          </span>
        )}
      </>
    );
    const shared = {
      className: styles.item,
      disabled: item.disabled === true,
      textValue: item.label,
      'aria-keyshortcuts': item.shortcut === undefined ? undefined : ariaShortcut(item.shortcut),
      onSelect: () => item.onSelect(),
    };
    return item.checked === undefined ? (
      <Item key={item.id} {...shared}>
        {body}
      </Item>
    ) : (
      <CheckboxItem key={item.id} {...shared} checked={item.checked}>
        {body}
      </CheckboxItem>
    );
  });
}

export interface DropdownMenuProps {
  /** One element that can hold a ref and take event props: IconButton, TextButton or a <button>. */
  trigger: ReactElement;
  items: MenuItemDef[];
  align?: 'start' | 'end';
}

/** Gap between a dropdown and its trigger. Menu-bar menus sit flush under their button instead. */
const DROPDOWN_OFFSET = 4;

/**
 * A Drive menu opened from a button: light library menus are #f0f4f9 with 32 px rows and at least 320 px wide; the
 * dark viewer menus are #282a2c with 36 px rows and at least 288 px wide (02 sections 4.9 and 4.10, ruling R15).
 */
export function DropdownMenu({ trigger, items, align = 'start' }: DropdownMenuProps) {
  const { ref, theme, refresh } = useInheritedTheme<HTMLElement>();
  return (
    <RadixDropdownMenu.Root onOpenChange={(open) => open && refresh()}>
      <RadixDropdownMenu.Trigger asChild ref={ref}>
        {trigger}
      </RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          className={cx(styles.content, styles.dropdown, isCompact(items) && styles.compact)}
          data-theme={theme}
          align={align}
          sideOffset={DROPDOWN_OFFSET}
          collisionPadding={8}
          loop
        >
          <MenuItems items={items} kind="dropdown" />
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}
