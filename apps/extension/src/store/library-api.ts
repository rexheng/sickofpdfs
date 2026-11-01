// What the library pages and the search box ask of the database (contracts §5): lists, Recent, Starred, Trash, search, notes,
// reading history, and the writes behind the star and the Trash.
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends LibraryApi`, and the object it returns spreads
// `createLibraryApi(db, deps, readers)`. `protocol.ts` serves `LIBRARY_API_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - Trashed and unsaved documents never appear in a list, a search or the Notes page (the Trash view is the one exception).
// - Search text never reaches MATCH as typed: `ftsQuery` is the only way in (fts-query.ts).
// - Every write is one transaction, and its change event is published only after it commits.
// - The store stamps `hlc` on every synced write and leaves `rev` alone (sync owns it).
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import type { Author, CommentId, CommentRow, DocumentId, DocumentRow, HlcStamp, LocationRow, PageHit, ThreadId, ThreadRow } from '@sop/core';
import { commentFromRow, threadFromRow } from './annotations';
import type { StoreChange } from './change-bus';
import { ftsQuery, isTooBroad } from './fts-query';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';
import { purgeTrashRows } from './trash-purge';

// ---- shapes (contracts §5) --------------------------------------------------------------------------------------------------

/** Narrowing for lists and search. Every field is optional; an empty `kind` list means no restriction. */
export interface LibraryFilter {
  starred?: boolean;
  hasNotes?: boolean;
  /** Last read on or after this time (Unix ms). */
  readFrom?: number;
  /** Last read on or before this time (Unix ms). */
  readTo?: number;
  kind?: DocumentRow['kind'][];
}

export type LibraryView = 'all' | 'recent' | 'starred' | 'trash';
export type LibrarySortBy = 'title' | 'lastOpened' | 'added' | 'pages';

export interface LibraryQuery {
  view: LibraryView;
  sort: { by: LibrarySortBy; dir: 'asc' | 'desc' };
  filter?: LibraryFilter;
  limit: number;
  /** From the previous answer's `nextCursor`, with the same view, sort and filter. */
  cursor?: string;
}

export interface LibraryItem {
  doc: DocumentRow;
  firstOpened: number;
  lastOpened: number;
  readingMs: number;
  /** Live notes: threads that are not deleted and hold at least one sent comment with text. */
  noteCount: number;
  /** Where it was seen most recently. */
  location: LocationRow | null;
}

export type SearchKind = 'reading' | 'page' | 'note';

export type SearchHit =
  | { kind: 'reading'; documentId: DocumentId; title: string; snippet: string; rank: number }
  | ({ kind: 'page' } & PageHit)
  | { kind: 'note'; documentId: DocumentId; threadId: ThreadId; commentId: CommentId; author: Author; pageIndex: number | null; snippet: string; rank: number };

export interface SearchQuery {
  text: string;
  /** Look in this document only. */
  documentId?: DocumentId;
  /** Which kinds of hit. Default all three. */
  kinds?: SearchKind[];
  /** Narrows the readings the hits may come from (starred, has notes, date read, type). */
  filter?: LibraryFilter;
  /** The most hits in total. When there are more kinds than room, each kind gets a fair share. */
  limit: number;
}

export interface NoteItem {
  thread: ThreadRow;
  /** The thread's sent comments that are live and have text, oldest first. */
  comments: CommentRow[];
  /** The reading's title, or a readable stand-in when it has none. */
  title: string;
}

export interface ReadingState {
  lastPosition: { page: number; offset: number; zoom: number } | null;
  readingMs: number;
  /** Page indexes, ascending. */
  pagesVisited: number[];
  openCount: number;
}

export interface ReadingReport {
  /** When this was recorded (Unix ms). The reading's "last opened" moves up to it. */
  at: number;
  /** Reading time since the last report, in ms. */
  msDelta: number;
  position: { page: number; offset: number; zoom: number };
  pagesVisited: number[];
}

export interface LibraryApi {
  /**
   * One page of readings. `view` picks the set (all, recent, starred, or Trash), `sort` and `filter` order and narrow it.
   * `total` counts the whole set, not only this page. Pass `nextCursor` back to get the next page.
   */
  listDocuments(q: LibraryQuery): Promise<{ items: LibraryItem[]; nextCursor: string | null; total: number }>;
  /** Readings, notes and pages that match, grouped in that order. */
  search(q: SearchQuery): Promise<SearchHit[]>;
  /**
   * Threads across all readings, newest activity first. `author` keeps threads where that author wrote a comment.
   * `trashed` lists the threads in Trash instead (newest removal first).
   */
  listNotes(o: { author?: Author; limit: number; cursor?: string; trashed?: boolean }): Promise<{ items: NoteItem[]; nextCursor: string | null }>;
  /** Adds reading time, moves the resume spot, and marks pages as visited. Only for readings the library holds. */
  recordReading(documentId: DocumentId, o: ReadingReport): Promise<void>;
  getReading(documentId: DocumentId): Promise<ReadingState | null>;
  setStarred(documentId: DocumentId, on: boolean): Promise<void>;
  /** Moves a reading to Trash. Its notes stay with it. Trashing again keeps the first removal time. */
  trashDocument(documentId: DocumentId): Promise<void>;
  restoreDocument(documentId: DocumentId): Promise<void>;
  /**
   * Gives a reading a new title (the library's Rename, ruling R76). Spaces at the ends are trimmed and runs of white space
   * become one; an empty title, or one over `MAX_TITLE_CHARS`, is refused. A trashed reading can be renamed too.
   */
  setTitle(documentId: DocumentId, title: string): Promise<void>;
  /**
   * Forgets completely every reading that has been in Trash since before `olderThan` (Unix ms), and blanks the text of notes
   * that have been in Trash that long (trash-purge.ts).
   */
  purgeTrash(olderThan: number): Promise<void>;
}

/** The method names `protocol.ts` serves and `client.ts` proxies. */
export const LIBRARY_API_METHODS = [
  'listDocuments',
  'search',
  'listNotes',
  'recordReading',
  'getReading',
  'setStarred',
  'trashDocument',
  'restoreDocument',
  'setTitle',
  'purgeTrash',
] as const satisfies readonly (keyof LibraryApi)[];

/** The longest title a reading can be given. */
export const MAX_TITLE_CHARS = 300;

/** The methods that only read: their answers are not kept for replays. */
export const LIBRARY_READ_METHODS = ['listDocuments', 'search', 'listNotes', 'getReading'] as const satisfies readonly (keyof LibraryApi)[];

export interface LibraryDeps {
  now(): number;
  hlc: { tick(): HlcStamp };
  publish(c: StoreChange): void;
  deleteBlob?(id: DocumentId): Promise<void>;
}

/** How Task 28's store turns a row into the shared shapes. Passed in so this file does not import `store-api.ts`. */
export interface RowReaders {
  document(r: Record<string, SqlValue>): DocumentRow;
  location(r: Record<string, SqlValue>): LocationRow;
}

export type LibraryErrorCode = 'bad-input' | 'read-only' | 'document-missing';

/** The same shape as Task 28's `StoreError`: the message starts with the code. */
export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  constructor(code: LibraryErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
    this.code = code;
  }
}

function fail(code: LibraryErrorCode, message: string): never {
  throw new LibraryError(code, message);
}

function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ---- small helpers ---------------------------------------------------------------------------------------------------------

type Row = Record<string, SqlValue>;

const HEX64 = /^[0-9a-f]{64}$/;
/** The most readings or notes one page returns. */
const MAX_PAGE = 200;
/** The most hits one search returns. */
const MAX_HITS = 500;
/** One report cannot add more reading time than this. */
const MAX_MS_DELTA = 24 * 60 * 60 * 1000;
const KINDS: ReadonlySet<string> = new Set(['paper', 'book', 'slides', 'other']);
const VIEWS: ReadonlySet<string> = new Set(['all', 'recent', 'starred', 'trash']);
const SORTS: ReadonlySet<string> = new Set(['title', 'lastOpened', 'added', 'pages']);
const SEARCH_KINDS: readonly SearchKind[] = ['reading', 'note', 'page'];

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function text(r: Row, col: string): string {
  const v = r[col];
  if (typeof v !== 'string') throw new Error(`column ${col} is not text`);
  return v;
}
function num(r: Row, col: string): number {
  const v = r[col];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`column ${col} is not a number`);
}
function numOrNull(r: Row, col: string): number | null {
  return r[col] == null ? null : num(r, col);
}
function textOrNull(r: Row, col: string): string | null {
  return r[col] == null ? null : text(r, col);
}

function checkId(v: unknown, what = 'the document id'): asserts v is DocumentId {
  if (typeof v !== 'string' || !HEX64.test(v)) fail('bad-input', `${what} is not a SHA-256 (64 lower-case hex characters)`);
}

/** A readable name for a reading: its title, or else the last part of the link it was seen at. Never empty. */
export function readableTitle(title: string | null, link: string | null): string {
  const t = title?.trim();
  if (t) return t;
  if (link) {
    try {
      const url = new URL(link);
      const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
        .replace(/\.pdf$/i, '')
        .replace(/[_+-]+/g, ' ')
        .trim();
      if (last) return last;
      if (url.hostname) return url.hostname;
    } catch {
      // Not a link: fall through.
    }
  }
  return 'Untitled PDF';
}

/** `[p. 4](cite:1)` and `[source](web:2)` in a Claude reply read as their link text in a snippet. */
function plainSnippet(s: string): string {
  return s.replace(/\[([^\]]*)\]\((?:cite|web):\d+\)/g, '$1');
}

// ---- cursors ---------------------------------------------------------------------------------------------------------------

const bytesToBase64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function base64UrlToBytes(s: string): Uint8Array {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** An opaque cursor: where the last row of a page sat in the sort, plus enough to refuse a cursor from a different query. */
function encodeCursor(tag: string, key: string | number, id: string): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify([tag, key, id])));
}
function decodeCursor(cursor: string, tag: string): { key: string | number; id: string } {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(cursor)));
    if (Array.isArray(v) && v.length === 3 && v[0] === tag && typeof v[2] === 'string') {
      const key: unknown = v[1];
      if (typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key))) return { key, id: v[2] };
    }
  } catch {
    // Falls through to the error below.
  }
  fail('bad-input', 'the page marker is not valid for this list');
}

// ---- the filter, as SQL ----------------------------------------------------------------------------------------------------

/** A live note: a thread that is not deleted or unsent and holds a sent, live comment with text. */
const LIVE_COMMENT = `c.deleted_at IS NULL AND c.draft_of_tab IS NULL AND c.body <> ''`;
const HAS_LIVE_COMMENT = (thread: string) => `EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = ${thread}.id AND ${LIVE_COMMENT})`;
const LIVE_THREAD = (t: string) => `${t}.deleted_at IS NULL AND ${t}.draft_of_tab IS NULL AND ${HAS_LIVE_COMMENT(t)}`;

/** `d` is documents, `h` is history (a LEFT JOIN). Adds the filter's conditions and their bound values. */
function addFilter(f: LibraryFilter | undefined, where: string[], bind: SqlValue[]): void {
  if (f === undefined) return;
  if (typeof f !== 'object' || f === null) fail('bad-input', 'the filter is not a filter');
  if (f.starred !== undefined) {
    if (typeof f.starred !== 'boolean') fail('bad-input', 'starred is true or false');
    where.push(f.starred ? 'd.starred = 1' : 'd.starred = 0');
  }
  if (f.hasNotes !== undefined) {
    if (typeof f.hasNotes !== 'boolean') fail('bad-input', 'hasNotes is true or false');
    const has = `EXISTS (SELECT 1 FROM threads t WHERE t.document_id = d.id AND ${LIVE_THREAD('t')})`;
    where.push(f.hasNotes ? has : `NOT ${has}`);
  }
  if (f.readFrom !== undefined) {
    if (!isTime(f.readFrom)) fail('bad-input', 'readFrom is not a time');
    where.push('h.last_opened >= ?');
    bind.push(f.readFrom);
  }
  if (f.readTo !== undefined) {
    if (!isTime(f.readTo)) fail('bad-input', 'readTo is not a time');
    where.push('h.last_opened <= ?');
    bind.push(f.readTo);
  }
  if (f.kind !== undefined) {
    if (!Array.isArray(f.kind) || !f.kind.every((k) => typeof k === 'string' && KINDS.has(k))) fail('bad-input', 'kind is a list of paper, book, slides or other');
    if (f.kind.length > 0) {
      where.push(`d.kind IN (SELECT value FROM json_each(?))`);
      bind.push(JSON.stringify(f.kind));
    }
  }
}

// ---- the sort ---------------------------------------------------------------------------------------------------------------

/** The sort key of a reading, as SQL over `d` (documents) and `h` (history). Never null, so a cursor can always compare. */
function sortKey(by: LibrarySortBy, dir: 'asc' | 'desc'): string {
  switch (by) {
    case 'title':
      // Untitled readings come last in either direction.
      return `CASE WHEN d.title IS NULL OR trim(d.title) = '' THEN ${dir === 'asc' ? 'char(1114111)' : `''`} ELSE lower(trim(d.title)) END`;
    case 'lastOpened':
      return 'coalesce(h.last_opened, d.created_at)';
    case 'added':
      return 'd.created_at';
    case 'pages':
      return 'd.page_count';
  }
}

// ---- the store -------------------------------------------------------------------------------------------------------------

export function createLibraryApi(db: SqlDb, deps: LibraryDeps, readers: RowReaders): LibraryApi {
  // sqlite-wasm refuses an empty bind list on a statement without parameters, so none is passed then.
  const binding = (bind: readonly SqlValue[]): SqlValue[] | undefined => (bind.length > 0 ? [...bind] : undefined);
  const select = (sql: string, bind: readonly SqlValue[] = []): Row[] => db.selectObjects(sql, binding(bind));
  const one = (sql: string, bind: readonly SqlValue[] = []): Row | undefined => select(sql, bind)[0];
  const run = (sql: string, bind: readonly SqlValue[] = []): void => void db.exec({ sql, bind: binding(bind) });

  const assertWritable = (): void => {
    if (isReadOnly(db)) fail('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
  };
  const publish = (changes: StoreChange[]): void => {
    for (const c of changes) {
      try {
        deps.publish(c);
      } catch {
        // Other tabs catch up on their next read.
      }
    }
  };

  /** The most recent location of each document, by id. */
  const latestLocations = (ids: readonly string[]): Map<string, LocationRow> => {
    const out = new Map<string, LocationRow>();
    if (ids.length === 0) return out;
    for (const r of select(
      `SELECT * FROM locations WHERE document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id, last_seen DESC, id`,
      [JSON.stringify(ids)],
    )) {
      const id = text(r, 'document_id');
      if (!out.has(id)) out.set(id, readers.location(r));
    }
    return out;
  };

  // ---- lists ----

  const listDocuments: LibraryApi['listDocuments'] = (q) =>
    attempt(() => {
      if (typeof q !== 'object' || q === null) fail('bad-input', 'no query');
      if (!VIEWS.has(q.view)) fail('bad-input', 'the view is all, recent, starred or trash');
      if (typeof q.sort !== 'object' || q.sort === null || !SORTS.has(q.sort.by) || (q.sort.dir !== 'asc' && q.sort.dir !== 'desc')) {
        fail('bad-input', 'sort by title, lastOpened, added or pages, asc or desc');
      }
      if (!isInt(q.limit) || q.limit < 1) fail('bad-input', 'the limit is a whole number of 1 or more');
      const limit = Math.min(q.limit, MAX_PAGE);
      const { by, dir } = q.sort;

      const where: string[] = [];
      const bind: SqlValue[] = [];
      if (q.view === 'trash') where.push('d.deleted_at IS NOT NULL');
      else where.push('d.deleted_at IS NULL');
      if (q.view === 'starred') where.push('d.starred = 1');
      addFilter(q.filter, where, bind);

      const from = 'FROM documents d LEFT JOIN history h ON h.document_id = d.id';
      const total = Number(db.selectValue(`SELECT count(*) ${from} WHERE ${where.join(' AND ')}`, binding(bind)) ?? 0);

      const key = sortKey(by, dir);
      const tag = `doc:${q.view}:${by}:${dir}`;
      const pageWhere = [...where];
      const pageBind = [...bind];
      if (q.cursor !== undefined) {
        if (typeof q.cursor !== 'string') fail('bad-input', 'the page marker is not text');
        const c = decodeCursor(q.cursor, tag);
        if (typeof c.key !== (by === 'title' ? 'string' : 'number')) fail('bad-input', 'the page marker is not valid for this list');
        pageWhere.push(`(${key}, d.id) ${dir === 'asc' ? '>' : '<'} (?, ?)`);
        pageBind.push(c.key, c.id);
      }
      const rows = select(
        `SELECT d.*, h.first_opened AS h_first, h.last_opened AS h_last, h.reading_ms AS h_ms, ${key} AS sk
         ${from} WHERE ${pageWhere.join(' AND ')}
         ORDER BY sk ${dir.toUpperCase()}, d.id ${dir.toUpperCase()} LIMIT ?`,
        [...pageBind, limit + 1],
      );
      const more = rows.length > limit;
      const page = rows.slice(0, limit);

      const ids = page.map((r) => text(r, 'id'));
      const notes = new Map<string, number>();
      if (ids.length > 0) {
        for (const r of select(
          `SELECT t.document_id AS document_id, count(*) AS n FROM threads t
           WHERE t.document_id IN (SELECT value FROM json_each(?)) AND ${LIVE_THREAD('t')} GROUP BY t.document_id`,
          [JSON.stringify(ids)],
        )) {
          notes.set(text(r, 'document_id'), num(r, 'n'));
        }
      }
      const locations = latestLocations(ids);

      const items: LibraryItem[] = page.map((r) => {
        const doc = readers.document(r);
        return {
          doc,
          firstOpened: numOrNull(r, 'h_first') ?? doc.createdAt,
          lastOpened: numOrNull(r, 'h_last') ?? doc.createdAt,
          readingMs: numOrNull(r, 'h_ms') ?? 0,
          noteCount: notes.get(doc.id) ?? 0,
          location: locations.get(doc.id) ?? null,
        };
      });
      const last = page[page.length - 1];
      const nextCursor = more && last ? encodeCursor(tag, by === 'title' ? text(last, 'sk') : num(last, 'sk'), text(last, 'id')) : null;
      return { items, nextCursor, total };
    });

  // ---- search ----

  const search: LibraryApi['search'] = (q) =>
    attempt(() => {
      if (typeof q !== 'object' || q === null) fail('bad-input', 'no query');
      const kinds: readonly unknown[] = q.kinds ?? SEARCH_KINDS;
      if (!Array.isArray(kinds) || !kinds.every((k) => SEARCH_KINDS.some((known) => known === k))) fail('bad-input', 'kinds are reading, page or note');
      if (q.documentId !== undefined) checkId(q.documentId);
      const limit = isInt(q.limit) ? Math.min(q.limit, MAX_HITS) : 0;
      // A last term of one or two letters is a whole word, not a prefix: a short prefix matches a large part of the index, and
      // the store answers one request at a time.
      const match = isTooBroad(q.text) ? null : ftsQuery(q.text, { minPrefixChars: 3 });
      if (match === null || limit <= 0 || kinds.length === 0) return [];

      // The documents a hit may come from: live, in the scope asked for, and passing the filter.
      const where = ['d.deleted_at IS NULL'];
      const bind: SqlValue[] = [];
      if (q.documentId !== undefined) {
        where.push('d.id = ?');
        bind.push(q.documentId);
      }
      addFilter(q.filter, where, bind);
      const scope = where.join(' AND ');
      const joinDocs = (idColumn: string): string => `JOIN documents d ON d.id = ${idColumn} LEFT JOIN history h ON h.document_id = d.id`;

      const titleOf = (title: string | null, documentId: string): string => readableTitle(title, locationRaw(documentId));
      const rawCache = new Map<string, string | null>();
      const locationRaw = (documentId: string): string | null => {
        if (!rawCache.has(documentId)) {
          const r = one('SELECT raw FROM locations WHERE document_id = ? ORDER BY last_seen DESC, id LIMIT 1', [documentId]);
          rawCache.set(documentId, r ? text(r, 'raw') : null);
        }
        return rawCache.get(documentId) ?? null;
      };

      const readings = (): SearchHit[] =>
        select(
          `SELECT d.id AS document_id, d.title AS title,
                  highlight(documents_fts, 1, '<b>', '</b>') AS h_title, highlight(documents_fts, 2, '<b>', '</b>') AS h_authors,
                  bm25(documents_fts, 0.0, 8.0, 2.0) AS rank
           FROM documents_fts ${joinDocs('documents_fts.document_id')}
           WHERE documents_fts MATCH ? AND ${scope}
           ORDER BY rank, d.id LIMIT ?`,
          [match, ...bind, limit],
        ).map((r) => {
          const documentId = text(r, 'document_id') as DocumentId;
          const title = titleOf(textOrNull(r, 'title'), documentId);
          const hTitle = text(r, 'h_title');
          const hAuthors = text(r, 'h_authors');
          // Show the words that matched: the title if it has them, else the authors, else just the title.
          const snippet = hTitle.includes('<b>') ? hTitle : hAuthors.includes('<b>') ? hAuthors : title;
          return { kind: 'reading', documentId, title, snippet, rank: num(r, 'rank') };
        });

      // Ranking and snippets are done in two steps. A snippet is costly (it re-reads the text), and a common word matches
      // thousands of pages, so the first step ranks cheaply and picks the best few, and the second makes snippets for those.
      const snippetsFor = (table: 'comments_fts' | 'page_text_fts', column: number, rowids: number[]): Map<number, string> => {
        const out = new Map<number, string>();
        if (rowids.length === 0) return out;
        // For pages the index's rowid is the page row's rowid, so the index is probed once per wanted page. Asking the index for
        // "this match, and rowid in the list" instead walks every match of a short prefix.
        const sql =
          table === 'page_text_fts'
            ? `SELECT p.rowid AS rid, snippet(page_text_fts, ${column}, '<b>', '</b>', '…', 16) AS snippet
               FROM page_text p JOIN page_text_fts ON page_text_fts.rowid = p.rowid
               WHERE p.rowid IN (SELECT value FROM json_each(?)) AND page_text_fts MATCH ?`
            : `SELECT comments_fts.rowid AS rid, snippet(comments_fts, ${column}, '<b>', '</b>', '…', 16) AS snippet FROM comments_fts
               WHERE comments_fts MATCH ? AND comments_fts.rowid IN (SELECT value FROM json_each(?))`;
        const bind = table === 'page_text_fts' ? [JSON.stringify(rowids), match] : [match, JSON.stringify(rowids)];
        for (const r of select(sql, bind)) out.set(num(r, 'rid'), text(r, 'snippet'));
        return out;
      };

      const notes = (): SearchHit[] => {
        const top = select(
          `SELECT comments_fts.rowid AS rid, c.id AS comment_id, c.thread_id AS thread_id, c.author AS author, t.page_index AS page_index,
                  d.id AS document_id, bm25(comments_fts, 0.0, 0.0, 1.0) AS rank
           FROM comments_fts
           JOIN comments c ON c.id = comments_fts.comment_id
           JOIN threads t ON t.id = c.thread_id
           ${joinDocs('c.document_id')}
           WHERE comments_fts MATCH ? AND c.deleted_at IS NULL AND c.draft_of_tab IS NULL
             AND t.deleted_at IS NULL AND t.draft_of_tab IS NULL AND ${scope}
           ORDER BY rank, c.id LIMIT ?`,
          [match, ...bind, limit],
        );
        const snippets = snippetsFor('comments_fts', 2, top.map((r) => num(r, 'rid')));
        return top.map((r) => ({
          kind: 'note',
          documentId: text(r, 'document_id') as DocumentId,
          threadId: text(r, 'thread_id') as ThreadId,
          commentId: text(r, 'comment_id') as CommentId,
          author: text(r, 'author') as Author,
          pageIndex: numOrNull(r, 'page_index'),
          snippet: plainSnippet(snippets.get(num(r, 'rid')) ?? ''),
          rank: num(r, 'rank'),
        }));
      };

      /**
       * The best pages for the query, best first. A common word matches most pages of a big library, and a join per match is
       * what costs, so the best few are picked from the index alone (by rank), and only then checked against the scope (not in
       * Trash, the filter, the document). If too few pass, the net is cast wider and the pick is made again.
       */
      const rankedPages = (): { rid: number; documentId: string; pageIndex: number; rank: number }[] => {
        if (q.documentId !== undefined) {
          // One document: only index entries between its first and last page row can be its pages, so the index is not
          // walked for the rest of the library. (Its pages are normally one run of rows; the join below is what makes it exact.)
          const span = one('SELECT min(rowid) AS lo, max(rowid) AS hi FROM page_text WHERE document_id = ?', [q.documentId]);
          if (!span || span.lo == null || span.hi == null) return [];
          return select(
            `SELECT page_text_fts.rowid AS rid, p.document_id AS document_id, p.page_index AS page_index, bm25(page_text_fts) AS rank
             FROM page_text_fts JOIN page_text p ON p.rowid = page_text_fts.rowid
             ${joinDocs('p.document_id')}
             WHERE page_text_fts MATCH ? AND page_text_fts.rowid BETWEEN ? AND ? AND ${scope}
             ORDER BY rank, p.page_index LIMIT ?`,
            [match, num(span, 'lo'), num(span, 'hi'), ...bind, limit],
          ).map((r) => ({ rid: num(r, 'rid'), documentId: text(r, 'document_id'), pageIndex: num(r, 'page_index'), rank: num(r, 'rank') }));
        }
        // A filter lets few pages through, so start with a wider net. Each round multiplies it by 16.
        for (let net = Math.max(limit * (q.filter === undefined ? 4 : 16), 40); ; net *= 16) {
          const candidates = select(`SELECT rowid AS rid, bm25(page_text_fts) AS rank FROM page_text_fts WHERE page_text_fts MATCH ? ORDER BY rank LIMIT ?`, [match, net]);
          if (candidates.length === 0) return [];
          const allowed = new Map<number, { documentId: string; pageIndex: number }>();
          for (const r of select(
            `SELECT p.rowid AS rid, p.document_id AS document_id, p.page_index AS page_index FROM page_text p ${joinDocs('p.document_id')}
             WHERE p.rowid IN (SELECT value FROM json_each(?)) AND ${scope}`,
            [JSON.stringify(candidates.map((c) => num(c, 'rid'))), ...bind],
          )) {
            allowed.set(num(r, 'rid'), { documentId: text(r, 'document_id'), pageIndex: num(r, 'page_index') });
          }
          const kept = candidates.flatMap((c) => {
            const hit = allowed.get(num(c, 'rid'));
            return hit ? [{ rid: num(c, 'rid'), ...hit, rank: num(c, 'rank') }] : [];
          });
          // Done when enough passed, or when every match has been looked at.
          if (kept.length >= limit || candidates.length < net) {
            return kept.sort((a, b) => a.rank - b.rank || (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0) || a.pageIndex - b.pageIndex).slice(0, limit);
          }
        }
      };

      const pages = (): SearchHit[] => {
        const top = rankedPages();
        const snippets = snippetsFor('page_text_fts', 0, top.map((r) => r.rid));
        return top.map((r) => ({
          kind: 'page',
          documentId: r.documentId as DocumentId,
          pageIndex: r.pageIndex,
          snippet: snippets.get(r.rid) ?? '',
          rank: r.rank,
        }));
      };

      const found: Record<SearchKind, SearchHit[]> = {
        reading: kinds.includes('reading') ? readings() : [],
        note: kinds.includes('note') ? notes() : [],
        page: kinds.includes('page') ? pages() : [],
      };
      // Share the room fairly, one hit at a time in turn, so a flood of one kind cannot push out the others.
      const take: Record<SearchKind, number> = { reading: 0, note: 0, page: 0 };
      let room = limit;
      for (let round = 0; room > 0; round++) {
        let progressed = false;
        for (const k of SEARCH_KINDS) {
          if (room > 0 && round < found[k].length) {
            take[k] += 1;
            room -= 1;
            progressed = true;
          }
        }
        if (!progressed) break;
      }
      return SEARCH_KINDS.flatMap((k) => found[k].slice(0, take[k]));
    });

  // ---- notes ----

  const listNotes: LibraryApi['listNotes'] = (o) =>
    attempt(() => {
      if (typeof o !== 'object' || o === null) fail('bad-input', 'no query');
      if (!isInt(o.limit) || o.limit < 1) fail('bad-input', 'the limit is a whole number of 1 or more');
      if (o.author !== undefined && o.author !== 'me' && o.author !== 'claude') fail('bad-input', 'the author is me or claude');
      const limit = Math.min(o.limit, MAX_PAGE);
      const trashed = o.trashed === true;
      const tag = `notes:${trashed ? 'trash' : 'live'}:${o.author ?? 'any'}`;

      const bind: SqlValue[] = [];
      const where = [`d.deleted_at IS NULL`, `t.draft_of_tab IS NULL`, trashed ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL', HAS_LIVE_COMMENT('t')];
      if (o.author !== undefined) {
        where.push(`EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = t.id AND c.author = ? AND ${LIVE_COMMENT})`);
        bind.push(o.author);
      }
      // Newest activity first: the latest sent comment. In Trash: the most recently removed first.
      const key = trashed ? 't.deleted_at' : `(SELECT max(c.created_at) FROM comments c WHERE c.thread_id = t.id AND ${LIVE_COMMENT})`;

      const outer: string[] = [];
      const outerBind: SqlValue[] = [];
      if (o.cursor !== undefined) {
        if (typeof o.cursor !== 'string') fail('bad-input', 'the page marker is not text');
        const c = decodeCursor(o.cursor, tag);
        if (typeof c.key !== 'number') fail('bad-input', 'the page marker is not valid for this list');
        outer.push('WHERE (sk, id) < (?, ?)');
        outerBind.push(c.key, c.id);
      }
      const rows = select(
        `SELECT * FROM (
           SELECT t.*, ${key} AS sk, d.title AS doc_title,
                  (SELECT l.raw FROM locations l WHERE l.document_id = d.id ORDER BY l.last_seen DESC, l.id LIMIT 1) AS doc_link
           FROM threads t JOIN documents d ON d.id = t.document_id
           WHERE ${where.join(' AND ')})
         ${outer.join(' ')} ORDER BY sk DESC, id DESC LIMIT ?`,
        [...bind, ...outerBind, limit + 1],
      );
      const more = rows.length > limit;
      const page = rows.slice(0, limit);

      const byThread = new Map<string, CommentRow[]>();
      if (page.length > 0) {
        for (const r of select(
          `SELECT c.* FROM comments c WHERE c.thread_id IN (SELECT value FROM json_each(?)) AND ${LIVE_COMMENT} ORDER BY c.created_at, c.rowid`,
          [JSON.stringify(page.map((r) => text(r, 'id')))],
        )) {
          try {
            const comment = commentFromRow(r);
            byThread.set(comment.threadId, [...(byThread.get(comment.threadId) ?? []), comment]);
          } catch {
            // A comment whose JSON cannot be read stays in the database untouched and is left out of the list.
          }
        }
      }
      const items: NoteItem[] = [];
      for (const r of page) {
        try {
          items.push({
            thread: threadFromRow(r),
            comments: byThread.get(text(r, 'id')) ?? [],
            title: readableTitle(textOrNull(r, 'doc_title'), textOrNull(r, 'doc_link')),
          });
        } catch {
          // As above, for a thread.
        }
      }
      const last = page[page.length - 1];
      return { items, nextCursor: more && last ? encodeCursor(tag, num(last, 'sk'), text(last, 'id')) : null };
    });

  // ---- reading history ----

  /** pages_visited: bit i of the blob is page i, least significant bit first within each byte. */
  const readBits = (blob: SqlValue | undefined): number[] => {
    if (!(blob instanceof Uint8Array)) return [];
    const pages: number[] = [];
    for (let byte = 0; byte < blob.length; byte++) {
      for (let bit = 0; bit < 8; bit++) if ((blob[byte] >> bit) & 1) pages.push(byte * 8 + bit);
    }
    return pages;
  };
  const writeBits = (pages: Iterable<number>): Uint8Array => {
    let max = -1;
    const all = [...pages];
    for (const p of all) max = Math.max(max, p);
    const out = new Uint8Array(Math.ceil((max + 1) / 8));
    for (const p of all) out[p >> 3] |= 1 << (p & 7);
    return out;
  };

  const recordReading: LibraryApi['recordReading'] = (documentId, o) =>
    attempt(() => {
      assertWritable();
      checkId(documentId);
      if (typeof o !== 'object' || o === null) fail('bad-input', 'no report');
      if (!isTime(o.at)) fail('bad-input', 'the time is not a time');
      if (typeof o.msDelta !== 'number' || !Number.isFinite(o.msDelta) || o.msDelta < 0) fail('bad-input', 'the reading time is not a number of milliseconds');
      const p = o.position;
      if (typeof p !== 'object' || p === null || !isInt(p.page) || p.page < 0) fail('bad-input', 'the position needs a page');
      if (typeof p.offset !== 'number' || !Number.isFinite(p.offset)) fail('bad-input', 'the position needs an offset');
      if (typeof p.zoom !== 'number' || !Number.isFinite(p.zoom) || p.zoom <= 0) fail('bad-input', 'the position needs a zoom');
      if (!Array.isArray(o.pagesVisited) || !o.pagesVisited.every((n) => isInt(n) && n >= 0)) fail('bad-input', 'pagesVisited is a list of page indexes');
      const msDelta = Math.min(Math.round(o.msDelta), MAX_MS_DELTA);

      db.savepoint(() => {
        const doc = one('SELECT page_count FROM documents WHERE id = ?', [documentId]);
        if (!doc) fail('document-missing', 'history is only kept for saved documents');
        const pageCount = num(doc, 'page_count');
        const visited = new Set<number>(o.pagesVisited.filter((n) => n < pageCount));
        const position = JSON.stringify({
          page: Math.min(p.page, Math.max(pageCount - 1, 0)),
          offset: Math.min(Math.max(p.offset, 0), 1),
          zoom: p.zoom,
        });
        const cur = one('SELECT last_opened, reading_ms, pages_visited FROM history WHERE document_id = ?', [documentId]);
        if (!cur) {
          run(
            `INSERT INTO history (document_id, first_opened, last_opened, open_count, reading_ms, last_position, pages_visited, rev, hlc)
             VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?)`,
            [documentId, o.at, o.at, msDelta, position, writeBits(visited), deps.hlc.tick()],
          );
        } else {
          for (const n of readBits(cur.pages_visited)) visited.add(n);
          // A report older than the last open (another tab opened it since) adds its time and pages but does not move the spot.
          const newest = o.at >= num(cur, 'last_opened');
          run(
            `UPDATE history SET reading_ms = reading_ms + ?, last_opened = max(last_opened, ?), pages_visited = ?,
               last_position = CASE WHEN ? THEN ? ELSE last_position END, hlc = ? WHERE document_id = ?`,
            [msDelta, o.at, writeBits(visited), newest ? 1 : 0, position, deps.hlc.tick(), documentId],
          );
        }
        // A report every few seconds must not pile up in the outbox: only the newest queued upsert of this row is needed.
        run(
          `DELETE FROM outbox WHERE table_name = 'history' AND row_id = ? AND op = 'upsert'
             AND seq < (SELECT max(seq) FROM outbox WHERE table_name = 'history' AND row_id = ?)`,
          [documentId, documentId],
        );
      });
      publish([{ table: 'history', ids: [documentId], op: 'upsert', documentId }]);
    });

  const getReading: LibraryApi['getReading'] = (documentId) =>
    attempt(() => {
      if (typeof documentId !== 'string' || !HEX64.test(documentId)) return null;
      const r = one('SELECT * FROM history WHERE document_id = ?', [documentId]);
      if (!r) return null;
      let lastPosition: ReadingState['lastPosition'] = null;
      const raw = textOrNull(r, 'last_position');
      if (raw !== null) {
        try {
          const v = JSON.parse(raw) as Record<string, unknown>;
          if (isInt(v.page) && typeof v.offset === 'number' && typeof v.zoom === 'number') lastPosition = { page: v.page, offset: v.offset, zoom: v.zoom };
        } catch {
          // An unreadable spot reads as none: the reading opens at the start.
        }
      }
      return { lastPosition, readingMs: num(r, 'reading_ms'), pagesVisited: readBits(r.pages_visited), openCount: num(r, 'open_count') };
    });

  // ---- star and Trash ----

  /** Changes one column set of a document and publishes it. Does nothing, and publishes nothing, when `change` says so. */
  const updateDocument = (documentId: string, change: (row: Row) => { sql: string; bind: SqlValue[] } | null): Promise<void> =>
    attempt(() => {
      assertWritable();
      checkId(documentId);
      let changed = false;
      db.savepoint(() => {
        const row = one('SELECT starred, deleted_at, title FROM documents WHERE id = ?', [documentId]);
        if (!row) fail('document-missing', 'only saved documents can be changed');
        const step = change(row);
        if (step === null) return;
        run(`UPDATE documents SET ${step.sql}, updated_at = ?, hlc = ? WHERE id = ?`, [...step.bind, deps.now(), deps.hlc.tick(), documentId]);
        changed = true;
      });
      if (changed) publish([{ table: 'documents', ids: [documentId], op: 'upsert', documentId }]);
    });

  const setStarred: LibraryApi['setStarred'] = (documentId, on) => {
    if (typeof on !== 'boolean') return Promise.reject(new LibraryError('bad-input', 'starred is true or false'));
    return updateDocument(documentId, (row) => (num(row, 'starred') === (on ? 1 : 0) ? null : { sql: 'starred = ?', bind: [on ? 1 : 0] }));
  };
  const trashDocument: LibraryApi['trashDocument'] = (documentId) =>
    updateDocument(documentId, (row) => (row.deleted_at != null ? null : { sql: 'deleted_at = ?', bind: [deps.now()] }));
  const restoreDocument: LibraryApi['restoreDocument'] = (documentId) =>
    updateDocument(documentId, (row) => (row.deleted_at == null ? null : { sql: 'deleted_at = NULL', bind: [] }));

  const setTitle: LibraryApi['setTitle'] = (documentId, title) => {
    if (typeof title !== 'string') return Promise.reject(new LibraryError('bad-input', 'a title is text'));
    // eslint-disable-next-line no-control-regex -- control characters never belong in a title
    const clean = title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean === '') return Promise.reject(new LibraryError('bad-input', 'a title needs some words'));
    if (Array.from(clean).length > MAX_TITLE_CHARS) return Promise.reject(new LibraryError('bad-input', `a title is at most ${MAX_TITLE_CHARS} characters`));
    return updateDocument(documentId, (row) => (row.title === clean ? null : { sql: 'title = ?', bind: [clean] }));
  };

  const purgeTrash: LibraryApi['purgeTrash'] = async (olderThan) => {
    assertWritable();
    if (!isTime(olderThan)) throw new LibraryError('bad-input', 'olderThan is not a time');
    await purgeTrashRows(db, deps, olderThan);
  };

  return { listDocuments, search, listNotes, recordReading, getReading, setStarred, trashDocument, restoreDocument, setTitle, purgeTrash };
}
