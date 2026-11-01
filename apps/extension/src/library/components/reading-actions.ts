// What the library does with a reading: open it, copy its link, and the row menu.
import type { MenuItemDef } from '@sop/ui';
import type { LibraryItem } from '../data/types';

/** The link a reading was opened from (a web link or a file on this computer); null when none is known. */
export function readingLink(item: LibraryItem): string | null {
  return item.location?.raw ?? null;
}

/**
 * Opens a reading in a new tab from its link; the takeover shows it in the viewer, which finds its notes by its
 * fingerprint. False when the reading has no link to open.
 */
export async function openReading(item: LibraryItem): Promise<boolean> {
  const link = readingLink(item);
  if (link === null) return false;
  await chrome.tabs.create({ url: link });
  return true;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface ReadingMenuActions {
  open(this: void): void;
  star(this: void, on: boolean): void;
  /** null: the store cannot rename yet, so Rename is left out. */
  rename: (() => void) | null;
  copyLink(this: void): void;
  trash(this: void): void;
  restore(this: void): void;
}

/** The row menu (plan S7): Open, Star, Rename, Copy link, Move to Trash. In Trash: Restore. */
export function readingMenu(item: LibraryItem, a: ReadingMenuActions): MenuItemDef[] {
  if (item.doc.deletedAt !== null) {
    return [{ kind: 'item', id: 'restore', label: 'Restore', icon: 'restore_from_trash', onSelect: a.restore }];
  }
  const link = readingLink(item);
  const starred = item.doc.starred;
  return [
    {
      kind: 'item',
      id: 'open',
      label: 'Open',
      icon: 'open_in_new',
      disabled: link === null,
      disabledReason: 'this PDF has no saved link',
      onSelect: a.open,
    },
    { kind: 'separator' },
    { kind: 'item', id: 'star', label: starred ? 'Remove from Starred' : 'Add to Starred', icon: 'star', onSelect: () => a.star(!starred) },
    ...(a.rename === null ? [] : [{ kind: 'item' as const, id: 'rename', label: 'Rename', icon: 'edit' as const, onSelect: a.rename }]),
    {
      kind: 'item',
      id: 'copy-link',
      label: 'Copy link',
      icon: 'link',
      disabled: link === null,
      disabledReason: 'this PDF has no saved link',
      onSelect: a.copyLink,
    },
    { kind: 'separator' },
    { kind: 'item', id: 'trash', label: 'Move to Trash', icon: 'delete', onSelect: a.trash },
  ];
}
