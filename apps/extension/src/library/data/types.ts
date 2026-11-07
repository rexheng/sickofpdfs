// What the library pages read and change, and nothing else: the contract §5 library queries. Pages never talk to the
// store directly, so the in-memory fake (fake.ts) and the real store (store-data.ts) are interchangeable.
import type { DocumentId } from '@sop/core';
import type { PaletteStore } from '../../shared/palette';
import type { LibraryApi, LibraryQuery } from '../../store/library-api';
import type { AboutData } from '../about/about-data';
import type { CoursesData } from '../courses/courses-data';
import type { TagsData } from '../tags/tags-data';
import type { PagesData } from './pages-data';

// ---- contract §5 shapes: the store's own (S9) ------------------------------------------------------------------------

export type { LibraryItem, LibraryQuery } from '../../store/library-api';

export type LibraryPage = Awaited<ReturnType<LibraryApi['listDocuments']>>;

// ---- what the pages use --------------------------------------------------------------------------------------------

/** One change the library should react to. `forgotten`: documents that are gone for good (their thumbnails go too). */
export interface LibraryChange {
  forgotten: DocumentId[];
}

/** What became of one uploaded file. */
export type UploadOutcome = 'saved' | 'already-saved' | 'not-pdf' | 'needs-password' | 'failed';

/** The readings (S7) and, through PagesData, what Home, Notes and Settings use (S14). */
export interface LibraryData extends PagesData {
  listDocuments(this: void, q: LibraryQuery): Promise<LibraryPage>;
  setStarred(this: void, documentId: DocumentId, on: boolean): Promise<void>;
  trashDocument(this: void, documentId: DocumentId): Promise<void>;
  restoreDocument(this: void, documentId: DocumentId): Promise<void>;
  /** Gives a reading a new title (the row menu's Rename; contract §5 `setTitle`, ruling R76). */
  setTitle(this: void, documentId: DocumentId, title: string): Promise<void>;
  /**
   * "+ New" → Upload PDF (ruling R76): saves a picked file into the library, as the owner's own choice, without opening it.
   * Nothing is written for a file that is not a PDF or cannot be opened.
   */
  savePickedPdf(this: void, file: File): Promise<UploadOutcome>;
  /** The saved copy of a library PDF (the blob store), for its first-page thumbnail; null when no copy is kept. */
  savedPdf(this: void, documentId: DocumentId): Promise<Blob | null>;
  /** Whether the library still holds this document (a trashed one counts). */
  hasDocument(this: void, documentId: DocumentId): Promise<boolean>;
  /** Calls `cb` after any change to what the library shows, from any tab. Returns the function that stops it. */
  onChange(this: void, cb: (change: LibraryChange) => void): () => void;
  /** What the Ctrl+K palette searches (S15): the store. Absent where there is no search (the sample library). */
  palette?: PaletteStore;
  /** Tags, groups and related readings (S18, R92). Absent in the sample library, which has no tags. */
  tags?: TagsData;
  /** About this PDF (S18, R92). Absent in the sample library. */
  about?: AboutData;
  /** The Courses page (8.5b). Absent in the sample library, which has no courses. */
  courses?: CoursesData;
}
