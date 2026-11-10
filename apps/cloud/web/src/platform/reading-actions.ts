// The web's version of apps/extension/src/library/components/reading-actions.ts (swapped in by vite.config.ts): what the library
// does with a reading. The one change: Open goes to the reading's page in the web library (its notes, and its page text), for
// every reading, since every reading in the cloud has a page here.
import type { MenuItemDef } from '@sop/ui';
import type { LibraryItem } from '@ext/library/data/types';
import { goTo, readingHref } from './web-route';

/** The link a reading was opened from (a web link or a file on this computer); null when none is known. */
export function readingLink(item: LibraryItem): string | null {
  return item.location?.raw ?? null;
}

/** Opens a reading's page in the web library. Always true: every reading the library lists has one. */
export function openReading(item: LibraryItem): Promise<boolean> {
  goTo(readingHref(item.doc.id));
  return Promise.resolve(true);
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
  rename(this: void): void;
  copyLink(this: void): void;
  trash(this: void): void;
  restore(this: void): void;
  /** S18: the reading's tags (or every selected reading's). Absent where there are no tags. */
  tags?: (() => void) | undefined;
  /** S18: About this PDF, the details panel. */
  about?: (() => void) | undefined;
}

/** The row menu (plan S7): Open, Star, Rename, Tags, About this PDF (S18), Copy link, Move to Trash. In Trash: Restore. */
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
      onSelect: a.open,
    },
    { kind: 'separator' },
    { kind: 'item', id: 'star', label: starred ? 'Remove from Starred' : 'Add to Starred', icon: 'star', onSelect: () => a.star(!starred) },
    { kind: 'item', id: 'rename', label: 'Rename', icon: 'edit', onSelect: a.rename },
    ...(a.tags !== undefined ? [{ kind: 'item', id: 'tags', label: 'Tags…', icon: 'sell', onSelect: a.tags } as const] : []),
    ...(a.about !== undefined ? [{ kind: 'item', id: 'about', label: 'About this PDF', icon: 'info', shortcut: 'I', onSelect: a.about } as const] : []),
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
