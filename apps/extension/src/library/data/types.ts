// What the library pages read and change, and nothing else: the contract §5 library queries. Pages never talk to the
// store directly, so the in-memory fake (fake.ts) and the real store (store-data.ts) are interchangeable.
import type { DocumentId, DocumentRow, LocationRow } from '@sop/core';

// ---- contract §5 shapes (apps/extension/src/store/store-api.ts, which S9 adds) ----------------------------------------
// Written out here, word for word, because S9 lands after this slice. When it does, these three become re-exports of
// store-api.ts's own (a one-line change in this file).

export interface LibraryQuery {
  view: 'all' | 'recent' | 'starred' | 'trash';
  sort: { by: 'title' | 'lastOpened' | 'added' | 'pages'; dir: 'asc' | 'desc' };
  filter?: { starred?: boolean; hasNotes?: boolean; readFrom?: number; readTo?: number; kind?: DocumentRow['kind'][] };
  limit: number;
  cursor?: string;
}

export interface LibraryItem {
  doc: DocumentRow;
  firstOpened: number;
  lastOpened: number;
  readingMs: number;
  noteCount: number;
  location: LocationRow | null;
}

export interface LibraryPage {
  items: LibraryItem[];
  nextCursor: string | null;
  total: number;
}

// ---- what the pages use --------------------------------------------------------------------------------------------

/** One change the library should react to. `forgotten`: documents that are gone for good (their thumbnails go too). */
export interface LibraryChange {
  forgotten: DocumentId[];
}

export interface LibraryData {
  listDocuments(this: void, q: LibraryQuery): Promise<LibraryPage>;
  setStarred(this: void, documentId: DocumentId, on: boolean): Promise<void>;
  trashDocument(this: void, documentId: DocumentId): Promise<void>;
  restoreDocument(this: void, documentId: DocumentId): Promise<void>;
  /**
   * Gives a reading a new title (the row menu's Rename). Not in contract §5: null while the store has no such method,
   * and the menu then leaves Rename out.
   */
  setTitle: ((documentId: DocumentId, title: string) => Promise<void>) | null;
  /** The saved copy of a library PDF (the blob store), for its first-page thumbnail; null when no copy is kept. */
  savedPdf(this: void, documentId: DocumentId): Promise<Blob | null>;
  /** Whether the library still holds this document (a trashed one counts). */
  hasDocument(this: void, documentId: DocumentId): Promise<boolean>;
  /** Calls `cb` after any change to what the library shows, from any tab. Returns the function that stops it. */
  onChange(this: void, cb: (change: LibraryChange) => void): () => void;
}
