// What the library does with a reading: open it, copy its link, and the row menu.
import type { MenuItemDef } from '@sop/ui';
import { buildViewerUrl } from '../../shared/viewer-url';
import type { LibraryItem } from '../data/types';
import { readingTitle } from './format';

/** The link a reading was opened from (a web link or a file on this computer); null when none is known. */
export function readingLink(item: LibraryItem): string | null {
  return item.location?.raw ?? null;
}

/**
 * Opens a reading in a new tab: from its link, where the takeover shows it in the viewer, which finds its notes by its
 * fingerprint; or, for one that has no link (an Upload), from its saved copy, through a blob: link that lives as long as
 * this library tab (until S15's `?doc=` opens saved copies itself). False when there is neither.
 */
export async function openReading(item: LibraryItem, savedPdf: (id: LibraryItem['doc']['id']) => Promise<Blob | null>): Promise<boolean> {
  const link = readingLink(item);
  if (link !== null) {
    await chrome.tabs.create({ url: link });
    return true;
  }
  const copy = item.doc.blobStored ? await savedPdf(item.doc.id) : null;
  if (copy === null) return false;
  const name = /\.pdf$/i.test(readingTitle(item)) ? readingTitle(item) : `${readingTitle(item)}.pdf`;
  await chrome.tabs.create({ url: buildViewerUrl({ source: URL.createObjectURL(copy), back: null, page: null, name }) });
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
  rename(this: void): void;
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
  const openable = link !== null || item.doc.blobStored;
  const starred = item.doc.starred;
  return [
    {
      kind: 'item',
      id: 'open',
      label: 'Open',
      icon: 'open_in_new',
      disabled: !openable,
      disabledReason: 'this PDF has no saved link or copy',
      onSelect: a.open,
    },
    { kind: 'separator' },
    { kind: 'item', id: 'star', label: starred ? 'Remove from Starred' : 'Add to Starred', icon: 'star', onSelect: () => a.star(!starred) },
    { kind: 'item', id: 'rename', label: 'Rename', icon: 'edit', onSelect: a.rename },
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
