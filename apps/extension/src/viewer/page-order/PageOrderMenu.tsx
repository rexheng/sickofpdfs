// R108: the thumbnails' right-click menu (also Shift+F10 and the menu key on a focused thumbnail), where a Drive or
// Slides user looks for it: move the page (or the picked pages) up, down, to the start or to the end, and put every page
// back in its first order. Drive's dark viewer menu (ContextMenu), so it matches the mark-up menu.
import { positionOfPage } from '@sop/core';
import { ContextMenu, type MenuItemDef } from '@sop/ui';
import type { PageOrderController } from './controller';

export interface PageMenuAt {
  /** The pages it acts on (original indices, in the order shown). */
  pages: number[];
  at: { x: number; y: number };
}

export interface PageOrderMenuProps {
  open: PageMenuAt | null;
  pages: PageOrderController;
  pageCount: number;
  onClose(this: void): void;
}

export function PageOrderMenu({ open, pages, pageCount, onClose }: PageOrderMenuProps) {
  const items = open === null ? [] : menuItems(open.pages, pages, pageCount);
  const label = open === null ? 'Page' : open.pages.length === 1 ? `Page ${positionOfPage(pages.order(), open.pages[0]) + 1}` : `${open.pages.length} pages`;
  return <ContextMenu at={open?.at ?? null} items={items} onClose={onClose} label={label} />;
}

function menuItems(moving: number[], pages: PageOrderController, pageCount: number): MenuItemDef[] {
  const order = pages.order();
  const at = moving.map((p) => positionOfPage(order, p));
  const first = Math.min(...at);
  const last = Math.max(...at);
  // Already together at the start (or the end): moving there would change nothing.
  const together = last - first + 1 === moving.length;
  const atStart = together && first === 0;
  const atEnd = together && last === pageCount - 1;
  return [
    { kind: 'item', id: 'pages.up', label: 'Move up', icon: 'arrow_upward', shortcut: 'Alt+Up', disabled: atStart, onSelect: () => void pages.nudge(moving, -1) },
    { kind: 'item', id: 'pages.down', label: 'Move down', icon: 'arrow_downward', shortcut: 'Alt+Down', disabled: atEnd, onSelect: () => void pages.nudge(moving, 1) },
    { kind: 'item', id: 'pages.start', label: 'Move to start', disabled: atStart, onSelect: () => void pages.move(moving, 0) },
    { kind: 'item', id: 'pages.end', label: 'Move to end', disabled: atEnd, onSelect: () => void pages.move(moving, pageCount) },
    { kind: 'separator' },
    {
      kind: 'item',
      id: 'pages.reset',
      label: 'Reset page order',
      icon: 'settings_backup_restore',
      disabled: order === null,
      ...(order === null ? { disabledReason: 'the pages are in their first order' } : {}),
      onSelect: () => void pages.reset(),
    },
  ];
}
