// The menu of a figure or an area (Phase 2, S16): S6's dark ContextMenu at the pointer (right-click), or at the
// region's top-right corner (the menu key, Shift+F10). Comment and Copy image; an area also has Remove area. Ask Claude
// and Explain this figure join it in Phase 4.
import { ContextMenu, type MenuItemDef } from '@sop/ui';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { formatCombo } from '../chrome/menus';
import type { FigureController, FigureState } from './controller';
import '../annotations/modal-layers.css';

function itemsFor(menu: NonNullable<FigureState['menu']>, c: FigureController): MenuItemDef[] {
  const { region } = menu;
  const items: MenuItemDef[] = [
    { kind: 'item', id: 'comment', label: 'Comment', icon: 'add_comment', shortcut: formatCombo('Ctrl+Alt+M'), disabled: !c.editable(), onSelect: () => c.comment(region) },
    { kind: 'item', id: 'copy-image', label: 'Copy image', icon: 'content_copy', shortcut: formatCombo('Ctrl+C'), onSelect: () => c.copy(region) },
  ];
  if (region.kind === 'area') {
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', id: 'remove-area', label: 'Remove area', icon: 'delete', shortcut: 'Delete', disabled: !c.editable(), onSelect: () => c.removeArea(region.markId) });
  }
  return items;
}

export function FigureMenu({ controller }: { controller: FigureController }) {
  const menu = useSyncExternalStore(controller.subscribe, () => controller.state().menu);
  // While the menu closes it keeps the rows it opened with.
  const [shown, setShown] = useState(menu);
  if (menu !== null && menu !== shown) setShown(menu);
  const items = useMemo(() => (shown === null ? [] : itemsFor(shown, controller)), [shown, controller]);
  const label = shown?.region.kind === 'area' ? 'Area' : 'Figure';
  return <ContextMenu at={menu?.at ?? null} items={items} label={label} onClose={controller.closeMenu} />;
}
