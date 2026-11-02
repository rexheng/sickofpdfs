// What "About this PDF" (R92) reads and writes: the reading's row, where it came from, its reading history, its related
// readings, and "Your context", which is the reading's document note (a note on the whole document). The library and the
// viewer both build it over the store; the original file is never changed.
import type { CommentId, CommentRow, DocumentId, DocumentRow, LocationRow, ThreadId, ThreadRow } from '@sop/core';
import type { StoreChange } from '../../store/change-bus';
import type { StoreClient } from '../../store/client';
import type { ReadingState } from '../../store/library-api';
import { shownTitle } from '../../shared/shown-title';

export interface AboutDetails {
  doc: DocumentRow;
  /** Where it was opened from, newest first. */
  locations: LocationRow[];
  /** Reading time, pages visited and opens; null before it was first read. */
  reading: ReadingState | null;
  /** First and last opened (Unix ms), from the history; the save time stands in before it was first read. */
  firstOpened: number;
  lastOpened: number;
}

export interface RelatedReading {
  id: DocumentId;
  title: string;
  authors: readonly string[];
  year: number | null;
  /** Kept as a file in the library, so it opens even when its link is gone. */
  blobStored: boolean;
  /** The last link it was opened from, to open it when there is no saved copy. */
  link: string | null;
}

/** The reading's document note, as "Your context" shows it: the first live note on the whole document. */
export interface DocumentNote {
  thread: ThreadRow;
  /** Its first comment, written by the owner: the context's words. */
  comment: CommentRow;
  /** Every other live comment in the thread (replies), which are left as they are. */
  others: CommentRow[];
}

export interface AboutData {
  details(this: void, documentId: DocumentId): Promise<AboutDetails | null>;
  /** The `n` readings closest in meaning, closest first. */
  related(this: void, documentId: DocumentId, n?: number): Promise<RelatedReading[]>;
  documentNote(this: void, documentId: DocumentId): Promise<DocumentNote | null>;
  /**
   * Writes "Your context": a new document note, or the note's new words. Emptying it moves the note to Trash (Notes →
   * Trash keeps it 30 days), as emptying any note does. Answers the note as it now is. A new note is made with `fresh`'s ids
   * when given: the ids its words were journaled under (context-journal.ts), so a crash copy and the note are one note.
   */
  saveDocumentNote(
    this: void,
    documentId: DocumentId,
    text: string,
    current: DocumentNote | null,
    fresh?: { threadId: ThreadId; commentId: CommentId } | null,
  ): Promise<DocumentNote | null>;
  setTitle(this: void, documentId: DocumentId, title: string): Promise<void>;
  /** Calls `cb` after a change to this reading: its row, places, history, notes or tags. */
  onReadingChange(this: void, documentId: DocumentId, cb: () => void): () => void;
}

/** The store changes that can change what the details show. */
const ABOUT_TABLES: ReadonlySet<StoreChange['table']> = new Set(['documents', 'aliases', 'locations', 'history', 'threads', 'comments', 'tags', 'reading_tags', 'auto_tag_removed']);

type AboutStore = Pick<StoreClient, 'getDocument' | 'listLocations' | 'getReading' | 'related' | 'listAnnotations' | 'writeAnnotations' | 'setTitle' | 'onChange'>;

/** The first live document note and its first comment by the owner. */
export function findDocumentNote(threads: readonly ThreadRow[], comments: readonly CommentRow[]): DocumentNote | null {
  const notes = threads.filter((t) => t.anchor.kind === 'document' && t.deletedAt === null && t.draftOfTab === null).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const thread of notes) {
    const live = comments.filter((c) => c.threadId === thread.id && c.deletedAt === null && c.draftOfTab === null).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const first = live[0];
    if (first !== undefined && first.author === 'me') return { thread, comment: first, others: live.slice(1) };
  }
  return null;
}

/** The longest context kept: a short note on why the owner is reading this. */
export const MAX_CONTEXT = 2000;

export function createStoreAboutData(client: AboutStore): AboutData {
  const details = async (id: DocumentId): Promise<AboutDetails | null> => {
    const doc = await client.getDocument(id);
    if (doc === null) return null;
    const [locations, reading] = await Promise.all([client.listLocations(id).catch(() => []), client.getReading(id).catch(() => null)]);
    locations.sort((a, b) => b.lastSeen - a.lastSeen);
    return { doc, locations, reading, firstOpened: reading?.firstOpened ?? doc.createdAt, lastOpened: reading?.lastOpened ?? doc.createdAt };
  };

  return {
    details,
    async related(id, n = 5) {
      const ids = await client.related(id, n);
      const rows = await Promise.all(
        ids.map(async (rid): Promise<RelatedReading | null> => {
          const doc = await client.getDocument(rid).catch(() => null);
          if (doc === null || doc.deletedAt !== null) return null;
          const link = (await client.listLocations(rid).catch(() => [])).sort((a, b) => b.lastSeen - a.lastSeen)[0]?.raw ?? null;
          return { id: rid, title: shownTitle(doc.title, link), authors: doc.authors, year: doc.year, blobStored: doc.blobStored, link };
        }),
      );
      return rows.filter((r): r is RelatedReading => r !== null);
    },
    async documentNote(id) {
      const { threads, comments } = await client.listAnnotations(id);
      return findDocumentNote(threads, comments);
    },
    async saveDocumentNote(id, raw, current, fresh) {
      const text = raw.slice(0, MAX_CONTEXT);
      const now = Date.now();
      if (text.trim() === '') {
        if (current === null) return null;
        // As in the viewer: emptying the note's first comment removes the note, with its replies; it waits in Trash.
        await client.writeAnnotations([
          { table: 'threads', op: 'soft-delete', row: { ...current.thread, deletedAt: now, updatedAt: now } },
          ...[current.comment, ...current.others].map((c) => ({ table: 'comments' as const, op: 'soft-delete' as const, row: { ...c, deletedAt: now } })),
        ]);
        return null;
      }
      if (current !== null) {
        if (current.comment.body === text) return current;
        const comment: CommentRow = { ...current.comment, body: text, editedAt: now };
        await client.writeAnnotations([{ table: 'comments', op: 'upsert', row: comment }]);
        return { ...current, comment };
      }
      const thread: ThreadRow = {
        id: fresh?.threadId ?? (crypto.randomUUID() as ThreadId),
        documentId: id,
        anchor: { kind: 'document' },
        pageIndex: null,
        sortKey: null,
        placement: 'placed',
        draftOfTab: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        rev: 0,
        hlc: '',
      };
      const comment: CommentRow = {
        id: fresh?.commentId ?? (crypto.randomUUID() as CommentId),
        threadId: thread.id,
        documentId: id,
        author: 'me',
        body: text,
        draftOfTab: null,
        meta: {},
        createdAt: now,
        editedAt: null,
        deletedAt: null,
        rev: 0,
        hlc: '',
      };
      await client.writeAnnotations([
        { table: 'threads', op: 'upsert', row: thread },
        { table: 'comments', op: 'upsert', row: comment },
      ]);
      return { thread, comment, others: [] };
    },
    setTitle: (id, title) => client.setTitle(id, title),
    onReadingChange(id, cb) {
      return client.onChange((c) => {
        if (!ABOUT_TABLES.has(c.table)) return;
        if (c.documentId !== undefined && c.documentId !== id && c.table !== 'documents') return;
        if (c.table === 'documents' && !c.ids.includes(id)) return;
        cb();
      });
    },
  };
}
