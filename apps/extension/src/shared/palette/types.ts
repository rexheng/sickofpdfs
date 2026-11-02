// The shapes the search palette (Ctrl+K) shares between the viewer and the library.
import type { DocumentId, ThreadId } from '@sop/core';
import type { IconName } from '@sop/ui';
import type { StoreClient } from '../../store/client';

/** What the palette asks of the library store. A `StoreClient` has all of it. */
export type PaletteStore = Pick<StoreClient, 'search' | 'getDocument' | 'listLocations' | 'listDocuments'>;

/** Where Enter takes the reader. */
export type PaletteTarget =
  /** A reading, at the spot it was left at. */
  | { kind: 'reading'; documentId: DocumentId }
  /** A page of a reading, at the first of the words that were typed. */
  | { kind: 'page'; documentId: DocumentId; pageIndex: number; terms: readonly string[] }
  /** A note, at its thread. `pageIndex` is where the search found it, when it is on a page. */
  | { kind: 'note'; documentId: DocumentId; threadId: ThreadId; pageIndex: number | null };

/** A command, or a place to go: one row of the palette's last group. */
export interface PaletteCommand {
  id: string;
  label: string;
  icon?: IconName;
  /** The keys, as people read them ("Ctrl+F"); shown at the right of the row. */
  keys?: string;
  run(this: void): void;
}

/** A named group of commands (the viewer's "Commands", the library's "Go to"). */
export interface PaletteCommandGroup {
  heading: string;
  commands: readonly PaletteCommand[];
}

/**
 * Part of a line of text: the words that matched are `bold`. The palette draws these as <b> elements and plain text, so
 * nothing from a PDF or a note ever reaches innerHTML.
 */
export interface TextPart {
  text: string;
  bold: boolean;
}
