// What Home, Notes and Settings (plan S14) read and change, besides the readings: notes across the library, the reading
// history, the synced settings, and the notes export. `LibraryData` extends this, so the fake (fake-pages.ts) and the store
// (here) stay interchangeable, as for S7's pages.
import type { Author, DocumentId, DocumentRow, LocationRow, ThreadRow } from '@sop/core';
import { makeZip } from 'client-zip';
import { notesFiles } from '../../backup/layout';
import { readLibrary } from '../../backup/read-library';
import type { StoreClient } from '../../store/client';
import type { NoteItem, ReadingState } from '../../store/library-api';
import { VIEWER_PATH } from '../../shared/viewer-url';

export type { NoteItem, ReadingState } from '../../store/library-api';

export interface NotesQuery {
  /** Threads where this author wrote: "Mine" ('me') or "Claude". */
  author?: Author;
  limit: number;
  cursor?: string;
  /** The notes in Trash (deleted, kept 30 days) instead of the live ones. */
  trashed?: boolean;
}

/** Enough of a reading to open it: its row and where it was last seen. */
export interface ReadingSource {
  doc: DocumentRow;
  location: LocationRow | null;
}

export interface PagesData {
  /** Notes across every reading, newest activity first (contract §5 `listNotes`). Trashed readings' notes are not listed. */
  listNotes(this: void, q: NotesQuery): Promise<{ items: NoteItem[]; nextCursor: string | null }>;
  /** Where the owner stopped in a reading, and how long they have read it. Null when it has no history yet. */
  getReading(this: void, documentId: DocumentId): Promise<ReadingState | null>;
  /** Takes a note out of Trash: it is back on its reading, in every tab. */
  restoreNote(this: void, thread: ThreadRow): Promise<void>;
  /** A reading's row and newest place, to open it from a note; null when the library no longer holds it. */
  readingSource(this: void, documentId: DocumentId): Promise<ReadingSource | null>;
  /** A synced setting (contracts §5 "Synced settings keys"), or null when it was never set. */
  getSetting(this: void, key: string): Promise<unknown>;
  setSetting(this: void, key: string, value: unknown): Promise<void>;
  /** Adds an entry to a list setting (`filter.allow`) in one step; the store refuses what R91 refuses. The list now stored. */
  addToSettingList(this: void, key: string, entry: string): Promise<string[]>;
  /** Writes every reading's notes as Markdown files (S3's format), one per reading, into a zip. Answers how many files. */
  exportNotes(this: void, sink: WritableStream<Uint8Array>): Promise<number>;
}

/** The pages' data from the store. */
export function createStorePagesData(client: StoreClient): PagesData {
  return {
    listNotes: (q) => client.listNotes(q),
    getReading: (id) => client.getReading(id),
    restoreNote: (thread) => client.writeAnnotations([{ table: 'threads', op: 'restore', row: thread }]),
    async readingSource(id) {
      const doc = await client.getDocument(id);
      if (doc === null) return null;
      const places = await client.listLocations(id).catch(() => []);
      const location = places.reduce<LocationRow | null>((best, l) => (best === null || l.lastSeen > best.lastSeen ? l : best), null);
      return { doc, location };
    },
    getSetting: (key) => client.getSetting(key),
    setSetting: (key, value) => client.setSetting(key, value),
    addToSettingList: (key, entry) => client.addToSettingList(key, entry),
    async exportNotes(sink) {
      const files = notesFiles(await readLibrary(client), { viewerBase: chrome.runtime.getURL(VIEWER_PATH) });
      await zipNotes(files, Date.now()).pipeTo(sink);
      return files.length;
    },
  };
}

/** The notes files as a zip, in a folder of their own so unzipping makes no mess. */
export function zipNotes(files: readonly { path: string; markdown: string }[], now: number): ReadableStream<Uint8Array> {
  const at = new Date(now);
  return makeZip(
    files.map((f) => ({ name: `sickofpdfs-notes/${f.path.replace(/^notes\//, '')}`, lastModified: at, input: f.markdown })),
    { buffersAreUTF8: true },
  );
}
