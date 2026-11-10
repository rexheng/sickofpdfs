// The library store: every read and write of the local SQLite database. It runs inside the store worker (one owner,
// requests one at a time) and in Node tests over an in-memory database.
//
// Rules this file keeps:
// - Every write is one transaction, and its change event is published only after it commits.
// - Nothing is written for a document the library does not hold: every write checks `documents` first, and the foreign
//   keys back that up. `findStampAlias` only reads.
// - The store stamps `hlc` on every synced write and leaves `rev` alone (sync owns it).
// - `forgetDocument` really deletes: the rows, every outbox entry naming them, and the deleted words in the indexes (R13).
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.

import {
  type Anchor,
  type MarkId,
  type ThreadId,
  ALIAS_THRESHOLD,
  canonicalLink,
  canonicalLocation,
  cleanLink,
  isStampAlias,
  locationId,
  stampedTextSimilarity,
  type DocumentId,
  type DocumentRow,
  type Hlc,
  type LocationId,
  type LocationKind,
  type LocationRow,
  type PageHit,
  type Sha256,
  type StoreStats,
} from '@sop/core';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { type AnnotationsApi, createAnnotationsApi } from './annotations';
import { type BackupApi, createBackupApi } from './backup-api';
import type { StoreChange } from './change-bus';
import { ftsQuery } from './fts-query';
import { createCoursesApi, type CoursesApi, forgetCoursePlacements } from './courses-api';
import { forgetPageOrders } from './page-order-rows';
import { createLibraryApi, type LibraryApi } from './library-api';
import { createRestoreApi, type RestoreApi } from './restore-api';
import { createLookupsApi, type LookupsApi } from './lookups-api';
import { createPassageVectorsApi, type PassageVectorsApi } from './passage-vectors';
import { createSettingsApi, type SettingsApi } from './settings-api';
import { clearTagOutbox, createTagsApi, dropOrphanAutoTags, tagRowIds, type TagsApi } from './tags-api';
import { createPageFiguresApi, type PageFiguresApi } from './page-figures';
import { createPageOcrApi, type PageOcrApi } from './page-ocr';
import { forgottenHashes, recordForgotten } from './forgotten';
import { FTS_TABLES } from './schema';
import { isReadOnly, type SqlValue, userVersion } from './schema-v2';
import { earlierReason, notesMovedReason, WEB_PAGE } from './reading-flags';

export { migrate } from './migrate';
export { ftsQuery } from './fts-query';
export type {
  LibraryFilter,
  LibraryItem,
  LibraryQuery,
  NoteItem,
  ReadingReport,
  ReadingState,
  SearchHit,
  SearchKind,
  SearchQuery,
} from './library-api';

/** The oo1 database: an `OpfsSAHPoolDb` in the store worker, `:memory:` in Node tests. */
export type Sqlite3Database = Database;

export interface SaveDocumentInput {
  id: DocumentId;
  byteSize: number;
  pageCount: number;
  title: string | null;
  authors: string[];
  pdfId: string | null;
  hasText: boolean;
  encrypted: boolean;
  blobStored: boolean;
  saveReasons: string[];
  location: { kind: LocationKind; raw: string; viaPage: string | null; viaTitle?: string | null } | null;
  openedAt: number;
  /** Phase 3. Filled from the PDF's first page (or the DOI and arXiv lookups). Saving again fills only what is empty. */
  year?: number | null;
  doi?: string | null;
  arxivId?: string | null;
  /** A guess from page count, page shape and headings. Default 'other'. */
  kind?: DocumentRow['kind'];
  /** False keeps this document's page text out of search (a hard-blocked PDF saved by choice). Default true. */
  indexText?: boolean;
}

/** R103: what `moveNotes` moves, re-anchored by the caller on the newer version's text. */
export interface MoveNotesInput {
  from: DocumentId;
  to: DocumentId;
  marks: { id: MarkId; anchor: Anchor; pageIndex: number; sortKey: number }[];
  threads: { id: ThreadId; anchor: Anchor; pageIndex: number | null; sortKey: number | null; placement: 'placed' | 'unplaced' }[];
}

export interface MoveNotesResult {
  marks: number;
  threads: number;
  comments: number;
  /** Notes still being typed in a tab, which stayed on the earlier version. */
  kept: number;
}

export interface TouchLocationInput {
  documentId: DocumentId;
  kind: LocationKind;
  raw: string;
  viaPage: string | null;
  viaTitle?: string | null;
  at: number;
}

export interface StoreApi extends AnnotationsApi, PageFiguresApi, PageOcrApi, LibraryApi, BackupApi, RestoreApi, SettingsApi, TagsApi, LookupsApi, PassageVectorsApi, CoursesApi {
  schemaVersion(): Promise<number>;
  stats(): Promise<StoreStats>;
  /** The library document these bytes are: `documents.id`, or the document an alias (a stamped copy) points to. */
  resolveFingerprint(sha256: Sha256): Promise<DocumentId | null>;
  getDocument(id: DocumentId): Promise<DocumentRow | null>;
  countDocumentsWithPageCount(pageCount: number): Promise<number>;
  /** A library document whose page text matches at 99.5% or more once download stamps are removed. Reads only. */
  findStampAlias(pageCount: number, pageTexts: readonly string[]): Promise<{ documentId: DocumentId; similarity: number } | null>;
  addAlias(sha256: Sha256, documentId: DocumentId, similarity: number): Promise<void>;
  /** The fingerprints recorded as other downloads (stamped copies) of a document. Reads only. */
  listAliases(documentId: DocumentId): Promise<Sha256[]>;
  /** The document, its history row and its location, in one transaction. Saving again changes nothing it already holds. */
  saveDocument(input: SaveDocumentInput): Promise<{ row: DocumentRow; created: boolean }>;
  putPageText(documentId: DocumentId, pages: readonly { pageIndex: number; text: string }[]): Promise<void>;
  touchLocation(input: TouchLocationInput): Promise<LocationRow>;
  listLocations(documentId: DocumentId): Promise<LocationRow[]>;
  /**
   * R103: the library document last seen at this link (its canonical form, as `saveDocument` stores it), or null: a web link, or
   * a `file:` link for a page on this computer. Saving a web page asks it, so the same page opens the reading it made before.
   * Reads only.
   */
  documentAtLink(raw: string): Promise<DocumentId | null>;
  recordOpen(documentId: DocumentId, at: number): Promise<void>;
  /**
   * R103: a saved web page changed and was saved as a newer version (`to`, whose save reasons name `from` as its earlier version).
   * The owner's marks and notes move from `from` to `to`, in one transaction: each is written again on `to` (new ids, the same
   * words, authors and times) with the anchor the caller re-anchored it to, and then removed from `from`. A note whose words are
   * not in the new version moves with its old anchor and `placement: 'unplaced'`, so it shows under "Couldn't place" with its quote.
   * It is never deleted. `from` gets the "notes moved" flag in the same transaction.
   * Only what is named moves. A note still being typed in a tab (a draft, or an open edit) stays on `from`, and is counted in `kept`.
   * Refused unless both are web pages and `to` is the newer version of `from`.
   */
  moveNotes(input: MoveNotesInput): Promise<MoveNotesResult>;
  /**
   * Hard delete: the document, everything that hangs off it, every outbox row naming any of it, and its indexed words. Forget also
   * records a salted hash of its fingerprints in the forgotten list (R88); an Undo of a save (`undo: true`) never does. Its tags, the
   * tags taken off it and its meaning vector go in the same transaction (R92), and so does any auto course or topic tag nothing uses now.
   */
  forgetDocument(documentId: DocumentId, o?: { undo?: boolean }): Promise<void>;
  /** Pages whose text matches every word of `query`, best first (bm25). */
  searchPages(query: string, limit: number): Promise<PageHit[]>;
}

export interface StoreDeps {
  now(): number;
  hlc: Hlc;
  publish(c: StoreChange): void;
  /** Removes the saved PDF of a document. Only the store worker has file storage, so Node tests leave this out. */
  deleteBlob?(id: DocumentId): Promise<void>;
  /** Removes a document's library thumbnail (OPFS `thumbs/<id>.webp`, ruling R76). Absent in Node tests too. */
  deleteThumbnail?(id: DocumentId): Promise<void>;
}

/** The method names of this file's part of the API (the annotation and figure parts list their own). */
export const LIBRARY_METHODS = [
  'schemaVersion',
  'stats',
  'resolveFingerprint',
  'getDocument',
  'countDocumentsWithPageCount',
  'findStampAlias',
  'addAlias',
  'listAliases',
  'saveDocument',
  'putPageText',
  'touchLocation',
  'listLocations',
  'documentAtLink',
  'recordOpen',
  'moveNotes',
  'forgetDocument',
  'searchPages',
] as const satisfies readonly (keyof StoreApi)[];

export type StoreErrorCode = 'bad-input' | 'read-only' | 'document-missing' | 'alias-conflict';

/** The message starts with the code, so it can still be told apart after it crosses a message port as plain text. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
    this.code = code;
  }
}

function fail(code: StoreErrorCode, message: string): never {
  throw new StoreError(code, message);
}

/** Runs `f` and returns its result as a promise, so a thrown error is a rejection and never a throw at the call site. */
function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ---- checking what comes in --------------------------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
/** Links and file paths longer than this are refused rather than stored. */
const MAX_LINK = 16_384;
/** A DOI or arXiv id longer than this is refused. */
const MAX_ID_TEXT = 256;
/** The most hits one search returns. */
const MAX_HITS = 500;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function checkHex(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string' || !HEX64.test(v)) fail('bad-input', `${what} is not a SHA-256 (64 lower-case hex characters)`);
}

function checkLocation(kind: unknown, raw: unknown, viaPage: unknown): void {
  if (kind !== 'url' && kind !== 'file') fail('bad-input', 'a location is a url or a file');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK) fail('bad-input', 'a location needs its link');
  if (viaPage !== null && (typeof viaPage !== 'string' || viaPage.length > MAX_LINK)) fail('bad-input', 'the page that led here is not a link');
}

function checkSaveInput(input: SaveDocumentInput): void {
  if (typeof input !== 'object' || input === null) fail('bad-input', 'nothing to save');
  checkHex(input.id, 'the document id');
  if (!isInt(input.byteSize) || input.byteSize < 0) fail('bad-input', 'the size is not a whole number of bytes');
  if (!isInt(input.pageCount) || input.pageCount < 0) fail('bad-input', 'the page count is not a whole number');
  if (input.title !== null && typeof input.title !== 'string') fail('bad-input', 'the title is not text');
  if (!isStringList(input.authors)) fail('bad-input', 'the authors are not a list of names');
  if (input.pdfId !== null && typeof input.pdfId !== 'string') fail('bad-input', 'the PDF id is not text');
  for (const flag of ['hasText', 'encrypted', 'blobStored'] as const) {
    if (typeof input[flag] !== 'boolean') fail('bad-input', `${flag} is not true or false`);
  }
  if (!isStringList(input.saveReasons)) fail('bad-input', 'the save reasons are not a list');
  if (!isTime(input.openedAt)) fail('bad-input', 'the open time is not a time');
  if (input.year != null && (!isInt(input.year) || input.year < 0 || input.year > 9999)) fail('bad-input', 'the year is not a year');
  for (const [name, value] of [['doi', input.doi], ['arXiv id', input.arxivId]] as const) {
    if (value != null && (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_TEXT)) fail('bad-input', `the ${name} is not text`);
  }
  if (input.kind !== undefined && !KINDS.has(input.kind)) fail('bad-input', 'the kind is paper, book, slides or other');
  if (input.indexText !== undefined && typeof input.indexText !== 'boolean') fail('bad-input', 'indexText is not true or false');
  if (input.location !== null) {
    if (typeof input.location !== 'object') fail('bad-input', 'the location is not a location');
    checkLocation(input.location.kind, input.location.raw, input.location.viaPage);
  }
}

// ---- reading cells -----------------------------------------------------------------------------------------------------

type Row = Record<string, SqlValue>;

function text(r: Row, col: string): string {
  const v = r[col];
  if (typeof v !== 'string') throw new Error(`column ${col} is not text`);
  return v;
}
function textOrNull(r: Row, col: string): string | null {
  return r[col] == null ? null : text(r, col);
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
/** A JSON list of strings; anything else reads as an empty list. */
function stringList(r: Row, col: string): string[] {
  try {
    const v: unknown = JSON.parse(text(r, col));
    return isStringList(v) ? v : [];
  } catch {
    return [];
  }
}

const KINDS = new Set(['paper', 'book', 'slides', 'other']);

function documentFromRow(r: Row): DocumentRow {
  const kind = text(r, 'kind');
  return {
    id: text(r, 'id') as DocumentId,
    pageCount: num(r, 'page_count'),
    byteSize: num(r, 'byte_size'),
    title: textOrNull(r, 'title'),
    authors: stringList(r, 'authors'),
    year: numOrNull(r, 'year'),
    doi: textOrNull(r, 'doi'),
    arxivId: textOrNull(r, 'arxiv_id'),
    pdfId: textOrNull(r, 'pdf_id'),
    kind: (KINDS.has(kind) ? kind : 'other') as DocumentRow['kind'],
    hasText: num(r, 'has_text') === 1,
    encrypted: num(r, 'encrypted') === 1,
    indexText: num(r, 'index_text') === 1,
    blobStored: num(r, 'blob_stored') === 1,
    starred: num(r, 'starred') === 1,
    saveReasons: stringList(r, 'save_reasons'),
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
    deletedAt: numOrNull(r, 'deleted_at'),
    rev: num(r, 'rev'),
    hlc: text(r, 'hlc'),
  };
}

function locationFromRow(r: Row): LocationRow {
  return {
    id: text(r, 'id') as LocationId,
    documentId: text(r, 'document_id') as DocumentId,
    kind: text(r, 'kind') as LocationKind,
    canonical: text(r, 'canonical'),
    raw: text(r, 'raw'),
    viaPage: textOrNull(r, 'via_page'),
    firstSeen: num(r, 'first_seen'),
    lastSeen: num(r, 'last_seen'),
  };
}

/** A location ready to store: its id, canonical form, and the raw link with tracking and session parts removed. */
interface PreparedLocation {
  id: LocationId;
  kind: LocationKind;
  canonical: string;
  raw: string;
  viaPage: string | null;
  viaTitle: string | null;
}

async function prepareLocation(kind: LocationKind, raw: string, viaPage: string | null, viaTitle?: string | null): Promise<PreparedLocation> {
  const canonical = canonicalLocation(kind, raw);
  return {
    id: await locationId(kind, canonical),
    kind,
    canonical,
    // Web links lose tracking parameters and session keys before they are stored; a file URL is kept as it was.
    raw: kind === 'url' ? cleanLink(raw) : raw,
    viaPage: viaPage === null ? null : canonicalLink(viaPage),
    viaTitle: typeof viaTitle === 'string' && viaTitle.trim() !== '' ? viaTitle.slice(0, 300) : null,
  };
}

// ---- the store -----------------------------------------------------------------------------------------------------------

export function createStoreApi(db: Sqlite3Database, deps: StoreDeps): StoreApi {
  // sqlite-wasm refuses an empty bind list on a statement without parameters, so none is passed then.
  const binding = (bind: SqlValue[]): SqlValue[] | undefined => (bind.length > 0 ? bind : undefined);
  const one = (sql: string, bind: SqlValue[] = []): Row | undefined => db.selectObjects(sql, binding(bind))[0];
  const run = (sql: string, bind: SqlValue[] = []): number => {
    db.exec({ sql, bind: binding(bind) });
    return db.changes();
  };
  const count = (sql: string, bind: SqlValue[] = []): number => Number(db.selectValue(sql, binding(bind)) ?? 0);

  const assertWritable = (): void => {
    if (isReadOnly(db)) fail('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
  };
  const documentExists = (id: string): boolean => one('SELECT 1 AS x FROM documents WHERE id = ?', [id]) !== undefined;

  /** Publishes after a commit. A failed broadcast never makes a committed write look failed. */
  const publish = (changes: StoreChange[]): void => {
    for (const c of changes) {
      try {
        deps.publish(c);
      } catch {
        // Other tabs catch up on their next read.
      }
    }
  };

  const readDocument = (id: string): DocumentRow | null => {
    const r = one('SELECT * FROM documents WHERE id = ?', [id]);
    return r ? documentFromRow(r) : null;
  };

  /** Inserts or updates a location row. The first sighting stays; the newest document, link and time win. */
  const upsertLocation = (loc: PreparedLocation, documentId: string, at: number): void => {
    run(
      `INSERT INTO locations (id, document_id, kind, canonical, raw, via_page, first_seen, last_seen, rev, hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (id) DO UPDATE SET document_id = excluded.document_id, raw = excluded.raw,
         via_page = coalesce(excluded.via_page, locations.via_page),
         first_seen = min(locations.first_seen, excluded.first_seen), last_seen = max(locations.last_seen, excluded.last_seen),
         hlc = excluded.hlc`,
      [loc.id, documentId, loc.kind, loc.canonical, loc.raw, loc.viaPage, at, at, deps.hlc.tick()],
    );
    // R92c: the title of the page that led here, for the categoriser's course codes. A local-only table: never in a backup or a sync.
    if (loc.viaTitle !== null) run(`INSERT INTO source_pages (document_id, title, seen_at) VALUES (?, ?, ?) ON CONFLICT (document_id) DO UPDATE SET title = excluded.title, seen_at = excluded.seen_at`, [documentId, loc.viaTitle, at]);
  };

  const base: Pick<StoreApi, (typeof LIBRARY_METHODS)[number]> = {
    schemaVersion: () => attempt(() => userVersion(db)),

    stats: () =>
      attempt(() => ({
        documents: count('SELECT count(*) FROM documents'),
        aliases: count('SELECT count(*) FROM aliases'),
        locations: count('SELECT count(*) FROM locations'),
        pageText: count('SELECT count(*) FROM page_text'),
        history: count('SELECT count(*) FROM history'),
        outbox: count('SELECT count(*) FROM outbox'),
      })),

    resolveFingerprint: (sha256) =>
      attempt(() => {
        if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
        if (documentExists(sha256)) return sha256;
        const alias = one('SELECT document_id FROM aliases WHERE sha256 = ?', [sha256]);
        return alias ? (text(alias, 'document_id') as DocumentId) : null;
      }),

    getDocument: (id) => attempt(() => (typeof id === 'string' && HEX64.test(id) ? readDocument(id) : null)),

    listAliases: (documentId) =>
      attempt(() =>
        typeof documentId === 'string' && HEX64.test(documentId)
          ? db.selectObjects('SELECT sha256 AS id FROM aliases WHERE document_id = ? ORDER BY sha256', [documentId]).map((r) => text(r, 'id') as Sha256)
          : [],
      ),

    countDocumentsWithPageCount: (pageCount) =>
      attempt(() => (isInt(pageCount) ? count('SELECT count(*) FROM documents WHERE page_count = ?', [pageCount]) : 0)),

    findStampAlias: (pageCount, pageTexts) =>
      attempt(() => {
        if (!isInt(pageCount) || !isStringList(pageTexts)) fail('bad-input', 'findStampAlias needs a page count and the text of each page');
        if (pageCount <= 0 || pageTexts.length !== pageCount) return null;
        let best: { documentId: DocumentId; similarity: number } | null = null;
        const candidates = db.selectObjects('SELECT id FROM documents WHERE page_count = ? AND index_text = 1 ORDER BY created_at, id', [pageCount]);
        for (const c of candidates) {
          const id = text(c, 'id');
          const stored = new Array<string>(pageCount).fill('');
          for (const p of db.selectObjects('SELECT page_index, text FROM page_text WHERE document_id = ? AND page_index < ?', [id, pageCount])) {
            stored[num(p, 'page_index')] = text(p, 'text');
          }
          if (!isStampAlias(stored, pageTexts)) continue; // R59: the same letters and digits, not just a high percentage
          const similarity = stampedTextSimilarity(stored, pageTexts);
          if (best === null || similarity > best.similarity) best = { documentId: id as DocumentId, similarity };
          if (best?.similarity === 1) break;
        }
        return best;
      }),

    addAlias: (sha256, documentId, similarity) =>
      attempt(() => {
        assertWritable();
        checkHex(sha256, 'the alias fingerprint');
        checkHex(documentId, 'the document id');
        if (typeof similarity !== 'number' || !(similarity >= ALIAS_THRESHOLD && similarity <= 1)) fail('bad-input', 'an alias needs a similarity of 0.995 to 1');
        if (sha256 === documentId) fail('alias-conflict', 'a document cannot be an alias of itself');
        let added = false;
        db.savepoint(() => {
          if (!documentExists(documentId)) fail('document-missing', 'aliases are only stored for saved documents');
          if (documentExists(sha256)) fail('alias-conflict', 'these bytes are a library document of their own');
          const cur = one('SELECT document_id FROM aliases WHERE sha256 = ?', [sha256]);
          if (cur) {
            if (cur.document_id !== documentId) fail('alias-conflict', 'these bytes are already an alias of another document');
            return; // already there: saving again changes nothing
          }
          run('INSERT INTO aliases (sha256, document_id, similarity, created_at, rev, hlc) VALUES (?, ?, ?, ?, 0, ?)', [
            sha256,
            documentId,
            similarity,
            deps.now(),
            deps.hlc.tick(),
          ]);
          added = true;
        });
        if (added) publish([{ table: 'aliases', ids: [sha256], op: 'upsert', documentId }]);
      }),

    saveDocument: async (input) => {
      checkSaveInput(input);
      const loc = input.location ? await prepareLocation(input.location.kind, input.location.raw, input.location.viaPage, input.location.viaTitle) : null;
      return attempt(() => {
        assertWritable();
        const now = deps.now();
        let created = false;
        let changed = false;
        let historyAdded = false;
        db.savepoint(() => {
          if (one('SELECT 1 AS x FROM aliases WHERE sha256 = ?', [input.id])) {
            fail('alias-conflict', 'this file is a stamped copy of a library document; save that document instead');
          }
          const cur = one('SELECT * FROM documents WHERE id = ?', [input.id]);
          if (!cur) {
            run(
              `INSERT INTO documents (id, page_count, byte_size, title, authors, year, doi, arxiv_id, pdf_id, kind, has_text, encrypted,
                 index_text, blob_stored, save_reasons, created_at, updated_at, rev, hlc)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
              [
                input.id,
                input.pageCount,
                input.byteSize,
                input.title,
                JSON.stringify(input.authors),
                input.year ?? null,
                input.doi ?? null,
                input.arxivId ?? null,
                input.pdfId,
                input.kind ?? 'other',
                input.hasText ? 1 : 0,
                input.encrypted ? 1 : 0,
                input.indexText === false ? 0 : 1,
                input.blobStored ? 1 : 0,
                JSON.stringify([...new Set(input.saveReasons)]),
                now,
                now,
                deps.hlc.tick(),
              ],
            );
            created = true;
          } else {
            // Saved before. Fill in only what the stored row lacks; never overwrite what is there (the owner may have
            // edited it), so saving the same document again changes nothing.
            const sets: string[] = [];
            const binds: SqlValue[] = [];
            if (input.blobStored && num(cur, 'blob_stored') === 0) sets.push('blob_stored = 1');
            const reasons = stringList(cur, 'save_reasons');
            const merged = [...new Set([...reasons, ...input.saveReasons])];
            if (merged.length > reasons.length) {
              sets.push('save_reasons = ?');
              binds.push(JSON.stringify(merged));
            }
            if (cur.title == null && input.title !== null) {
              sets.push('title = ?');
              binds.push(input.title);
            }
            if (stringList(cur, 'authors').length === 0 && input.authors.length > 0) {
              sets.push('authors = ?');
              binds.push(JSON.stringify(input.authors));
            }
            if (cur.pdf_id == null && input.pdfId !== null) {
              sets.push('pdf_id = ?');
              binds.push(input.pdfId);
            }
            if (cur.year == null && input.year != null) {
              sets.push('year = ?');
              binds.push(input.year);
            }
            if (cur.doi == null && input.doi != null) {
              sets.push('doi = ?');
              binds.push(input.doi);
            }
            if (cur.arxiv_id == null && input.arxivId != null) {
              sets.push('arxiv_id = ?');
              binds.push(input.arxivId);
            }
            if (cur.kind === 'other' && input.kind !== undefined && input.kind !== 'other') {
              sets.push('kind = ?');
              binds.push(input.kind);
            }
            if (sets.length > 0) {
              run(`UPDATE documents SET ${sets.join(', ')}, updated_at = ?, hlc = ? WHERE id = ?`, [...binds, now, deps.hlc.tick(), input.id]);
              changed = true;
            }
          }
          if (!one('SELECT 1 AS x FROM history WHERE document_id = ?', [input.id])) {
            run('INSERT INTO history (document_id, first_opened, last_opened, open_count, rev, hlc) VALUES (?, ?, ?, 1, 0, ?)', [
              input.id,
              input.openedAt,
              input.openedAt,
              deps.hlc.tick(),
            ]);
            historyAdded = true;
          }
          if (loc) upsertLocation(loc, input.id, input.openedAt);
        });
        const changes: StoreChange[] = [];
        if (created || changed) changes.push({ table: 'documents', ids: [input.id], op: 'upsert', documentId: input.id });
        if (historyAdded) changes.push({ table: 'history', ids: [input.id], op: 'upsert', documentId: input.id });
        if (loc) changes.push({ table: 'locations', ids: [loc.id], op: 'upsert', documentId: input.id });
        publish(changes);
        const row = readDocument(input.id);
        if (!row) throw new Error('the saved document could not be read back');
        return { row, created };
      });
    },

    putPageText: (documentId, pages) =>
      attempt(() => {
        assertWritable();
        checkHex(documentId, 'the document id');
        const given: unknown = pages;
        if (!Array.isArray(given)) fail('bad-input', 'page text comes as a list of pages');
        for (const p of given as unknown[]) {
          const page = p as { pageIndex?: unknown; text?: unknown } | null;
          if (typeof page !== 'object' || page === null || !isInt(page.pageIndex) || page.pageIndex < 0 || typeof page.text !== 'string') {
            fail('bad-input', 'each page needs a page index and its text');
          }
        }
        const changed = new Set<number>();
        db.savepoint(() => {
          const doc = one('SELECT page_count, index_text FROM documents WHERE id = ?', [documentId]);
          if (!doc) fail('document-missing', 'page text is only stored for saved documents');
          if (num(doc, 'index_text') !== 1) return; // the owner keeps this document's text out of the library
          const pageCount = num(doc, 'page_count');
          for (const p of pages) {
            if (p.pageIndex >= pageCount) fail('bad-input', 'a page index is past the last page');
            const n = run(
              // A page whose text was recognised (Phase 7, source 'ocr:…') keeps it: PDFium's text of a scanned page is (next to)
              // nothing, and a later save or re-index must not wipe what the recogniser read.
              `INSERT INTO page_text (document_id, page_index, text) VALUES (?, ?, ?)
               ON CONFLICT (document_id, page_index) DO UPDATE SET text = excluded.text
               WHERE page_text.text IS NOT excluded.text AND page_text.source NOT LIKE 'ocr:%'`,
              [documentId, p.pageIndex, p.text],
            );
            if (n > 0) changed.add(p.pageIndex);
          }
        });
        if (changed.size > 0) {
          publish([{ table: 'page_text', ids: [...changed].sort((a, b) => a - b).map((i) => `${documentId}:${i}`), op: 'upsert', documentId }]);
        }
      }),

    touchLocation: async (input) => {
      if (typeof input !== 'object' || input === null) fail('bad-input', 'no location');
      checkHex(input.documentId, 'the document id');
      checkLocation(input.kind, input.raw, input.viaPage);
      if (!isTime(input.at)) fail('bad-input', 'the time is not a time');
      const loc = await prepareLocation(input.kind, input.raw, input.viaPage, input.viaTitle);
      return attempt(() => {
        assertWritable();
        db.savepoint(() => {
          if (!documentExists(input.documentId)) fail('document-missing', 'locations are only stored for saved documents');
          upsertLocation(loc, input.documentId, input.at);
        });
        publish([{ table: 'locations', ids: [loc.id], op: 'upsert', documentId: input.documentId }]);
        const row = one('SELECT * FROM locations WHERE id = ?', [loc.id]);
        if (!row) throw new Error('the location could not be read back');
        return locationFromRow(row);
      });
    },

    listLocations: (documentId) =>
      attempt(() =>
        db.selectObjects('SELECT * FROM locations WHERE document_id = ? ORDER BY last_seen DESC, id', [documentId]).map(locationFromRow),
      ),

    documentAtLink: async (raw) => {
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LINK) fail('bad-input', 'a link is needed');
      const loc = await prepareLocation(/^file:/iu.test(raw) ? 'file' : 'url', raw, null);
      return attempt(() => {
        const r = one('SELECT document_id FROM locations WHERE id = ?', [loc.id]);
        return r ? (text(r, 'document_id') as DocumentId) : null;
      });
    },

    moveNotes: (input) =>
      attempt(() => {
        assertWritable();
        if (typeof input !== 'object' || input === null) fail('bad-input', 'nothing to move');
        checkHex(input.from, 'the earlier version');
        checkHex(input.to, 'the newer version');
        if (input.from === input.to) fail('bad-input', 'a reading cannot move its notes to itself');
        if (!Array.isArray(input.marks) || !Array.isArray(input.threads)) fail('bad-input', 'marks and threads come as lists');
        const isAnchor = (a: unknown): a is Anchor => typeof a === 'object' && a !== null && typeof (a as { kind?: unknown }).kind === 'string';
        for (const m of input.marks) {
          if (!isAnchor(m.anchor) || !isInt(m.pageIndex) || m.pageIndex < 0 || typeof m.sortKey !== 'number' || !Number.isFinite(m.sortKey)) fail('bad-input', 'a mark needs its anchor and place');
        }
        for (const t of input.threads) {
          if (!isAnchor(t.anchor) || (t.pageIndex !== null && (!isInt(t.pageIndex) || t.pageIndex < 0)) || (t.sortKey !== null && (typeof t.sortKey !== 'number' || !Number.isFinite(t.sortKey)))) {
            fail('bad-input', 'a thread needs its anchor and place');
          }
          if (t.placement !== 'placed' && t.placement !== 'unplaced') fail('bad-input', 'a thread is placed or unplaced');
        }
        const result: MoveNotesResult = { marks: 0, threads: 0, comments: 0, kept: 0 };
        const moved = { marks: { from: [] as string[], to: [] as string[] }, threads: { from: [] as string[], to: [] as string[] }, comments: { from: [] as string[], to: [] as string[] } };
        db.savepoint(() => {
          const from = one('SELECT save_reasons FROM documents WHERE id = ?', [input.from]);
          const to = one('SELECT save_reasons FROM documents WHERE id = ?', [input.to]);
          if (!from || !to) fail('document-missing', 'notes only move between saved readings');
          const fromReasons = stringList(from, 'save_reasons');
          const toReasons = stringList(to, 'save_reasons');
          // Only to the newer version of the same web page: notes never move between unrelated readings.
          if (!fromReasons.includes(WEB_PAGE) || !toReasons.includes(WEB_PAGE) || !toReasons.includes(earlierReason(input.from))) {
            fail('bad-input', 'notes only move from a web page to its newer version');
          }
          const hlc = () => deps.hlc.tick();
          for (const m of input.marks) {
            const cur = one('SELECT * FROM marks WHERE id = ? AND document_id = ? AND deleted_at IS NULL', [m.id, input.from]);
            if (!cur) continue; // gone or already moved: nothing to do
            const id = crypto.randomUUID();
            run(
              `INSERT INTO marks (id, document_id, style, color, anchor, page_index, sort_key, author, created_at, updated_at, deleted_at, rev, hlc)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
              [id, input.to, cur.style ?? null, cur.color ?? null, JSON.stringify(m.anchor), m.pageIndex, m.sortKey, cur.author ?? 'me', cur.created_at ?? deps.now(), cur.updated_at ?? deps.now(), hlc()],
            );
            run('DELETE FROM marks WHERE id = ?', [m.id]);
            moved.marks.from.push(m.id);
            moved.marks.to.push(id);
            result.marks += 1;
          }
          for (const t of input.threads) {
            const cur = one('SELECT * FROM threads WHERE id = ? AND document_id = ? AND deleted_at IS NULL', [t.id, input.from]);
            if (!cur) continue;
            // A note still being typed somewhere (a new thread, an unsent reply, an open edit) stays where its tab has it.
            const typing =
              cur.draft_of_tab != null ||
              one('SELECT 1 AS x FROM comments WHERE thread_id = ? AND draft_of_tab IS NOT NULL', [t.id]) !== undefined ||
              one(`SELECT 1 AS x FROM comment_edits e JOIN comments c ON c.id = e.comment_id WHERE c.thread_id = ? AND e.state = 'open'`, [t.id]) !== undefined;
            if (typing) {
              result.kept += 1;
              continue;
            }
            const id = crypto.randomUUID();
            run(
              `INSERT INTO threads (id, document_id, anchor, page_index, sort_key, placement, draft_of_tab, created_at, updated_at, deleted_at, rev, hlc)
               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?)`,
              [id, input.to, JSON.stringify(t.anchor), t.pageIndex, t.sortKey, t.placement, cur.created_at ?? deps.now(), cur.updated_at ?? deps.now(), hlc()],
            );
            // Every sent comment goes with it, a reply in Notes → Trash too (it stays in the Trash, now on the newer version).
            for (const c of db.selectObjects('SELECT * FROM comments WHERE thread_id = ? AND draft_of_tab IS NULL ORDER BY created_at, id', [t.id])) {
              const cid = crypto.randomUUID();
              run(
                `INSERT INTO comments (id, thread_id, document_id, author, body, draft_of_tab, meta, created_at, edited_at, deleted_at, rev, hlc)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?)`,
                [cid, id, input.to, c.author ?? 'me', c.body ?? '', c.meta ?? '{}', c.created_at ?? deps.now(), c.edited_at ?? null, c.deleted_at ?? null, hlc()],
              );
              moved.comments.from.push(text(c, 'id'));
              moved.comments.to.push(cid);
              result.comments += 1;
            }
            // Closed edit markers go with their comments; nothing in them is text.
            run('DELETE FROM comments WHERE thread_id = ? AND draft_of_tab IS NULL', [t.id]);
            run('DELETE FROM threads WHERE id = ?', [t.id]);
            moved.threads.from.push(t.id);
            moved.threads.to.push(id);
            result.threads += 1;
          }
          if (result.marks + result.threads > 0 && !fromReasons.includes(notesMovedReason(input.to))) {
            run('UPDATE documents SET save_reasons = ?, updated_at = ?, hlc = ? WHERE id = ?', [JSON.stringify([...fromReasons, notesMovedReason(input.to)]), deps.now(), hlc(), input.from]);
          }
        });
        const changes: StoreChange[] = [];
        for (const table of ['marks', 'threads', 'comments'] as const) {
          if (moved[table].to.length > 0) changes.push({ table, ids: moved[table].to, op: 'upsert', documentId: input.to });
          if (moved[table].from.length > 0) changes.push({ table, ids: moved[table].from, op: 'delete', documentId: input.from });
        }
        if (result.marks + result.threads > 0) changes.push({ table: 'documents', ids: [input.from], op: 'upsert', documentId: input.from });
        publish(changes);
        return result;
      }),

    recordOpen: (documentId, at) =>
      attempt(() => {
        assertWritable();
        checkHex(documentId, 'the document id');
        if (!isTime(at)) fail('bad-input', 'the open time is not a time');
        db.savepoint(() => {
          if (!documentExists(documentId)) fail('document-missing', 'history is only kept for saved documents');
          run(
            `INSERT INTO history (document_id, first_opened, last_opened, open_count, rev, hlc) VALUES (?, ?, ?, 1, 0, ?)
             ON CONFLICT (document_id) DO UPDATE SET open_count = history.open_count + 1,
               first_opened = min(history.first_opened, excluded.first_opened), last_opened = max(history.last_opened, excluded.last_opened),
               hlc = excluded.hlc`,
            [documentId, at, at, deps.hlc.tick()],
          );
        });
        publish([{ table: 'history', ids: [documentId], op: 'upsert', documentId }]);
      }),

    forgetDocument: (documentId, o) =>
      forgetRows(documentId, o?.undo === true).then(() => forgetThumbnail(documentId)),

    searchPages: (query, limit) =>
      attempt(() => {
        const match = ftsQuery(query, { prefix: false });
        const n = isInt(limit) ? Math.min(limit, MAX_HITS) : 0;
        if (match === null || n <= 0) return [];
        return db
          .selectObjects(
            `SELECT p.document_id AS document_id, p.page_index AS page_index,
                    snippet(page_text_fts, 0, '<b>', '</b>', '…', 16) AS snippet, bm25(page_text_fts) AS rank
             FROM page_text_fts
             JOIN page_text p ON p.rowid = page_text_fts.rowid
             JOIN documents d ON d.id = p.document_id
             WHERE page_text_fts MATCH ? AND d.deleted_at IS NULL
             ORDER BY rank, p.document_id, p.page_index
             LIMIT ?`,
            [match, n],
          )
          .map((r) => ({
            documentId: text(r, 'document_id') as DocumentId,
            pageIndex: num(r, 'page_index'),
            snippet: text(r, 'snippet'),
            rank: num(r, 'rank'),
          }));
      }),
  };

  async function forgetRows(documentId: DocumentId, undo: boolean): Promise<void> {
    // R82, R88: the fingerprints that leave for good (the document and its aliases) are hashed first, so the list of forgotten readings
    // is written in the same transaction as the delete (forgotten.ts). The request queue keeps anything from changing in between. An
    // Undo of a save writes nothing there: it leaves no trace once the backup's queue has drained.
    const hashes = await attempt(() => {
      assertWritable();
      checkHex(documentId, 'the document id');
      if (undo || !documentExists(documentId)) return null;
      return [documentId, ...db.selectObjects('SELECT sha256 AS id FROM aliases WHERE document_id = ?', [documentId]).map((r) => text(r, 'id'))];
    }).then((ids) => (ids === null ? new Map<string, string>() : forgottenHashes(db, ids)));
    return attempt(() => {
      assertWritable();
      checkHex(documentId, 'the document id');
      let existed = false;
      let orphaned: string[] = [];
      db.savepoint(() => {
        existed = documentExists(documentId);
        if (existed) recordForgotten(db, hashes.values(), deps.now());
        // 1. Every id that names this document or something hanging off it. The history row's id is the document id.
        const ids = new Set<string>([documentId]);
        for (const sql of [
          'SELECT sha256 AS id FROM aliases WHERE document_id = ?',
          'SELECT id FROM locations WHERE document_id = ?',
          'SELECT id FROM marks WHERE document_id = ?',
          'SELECT id FROM threads WHERE document_id = ?',
          'SELECT id FROM comments WHERE document_id = ?',
        ]) {
          for (const r of db.selectObjects(sql, [documentId])) ids.add(text(r, 'id'));
        }
        for (const id of tagRowIds(db, [documentId])) ids.add(id);
        // 2. The cascade removes aliases, locations, page text, marks, threads, comments, history, the figure cache, tags, removed-tag
        // records and the meaning vector; the index triggers remove their words from page_text_fts, documents_fts and comments_fts.
        run('DELETE FROM documents WHERE id = ?', [documentId]);
        // 3. Every outbox row naming any of them, including the delete rows the cascade itself just queued.
        run('DELETE FROM outbox WHERE row_id IN (SELECT value FROM json_each(?))', [JSON.stringify([...ids])]);
        clearTagOutbox(db, [documentId]);
        // Where the owner put it on the Courses page: a settings row named by its fingerprint (8.5b).
        forgetCoursePlacements(db, [documentId]);
        // R108: its page order (a settings row named by its fingerprint) goes too.
        forgetPageOrders(db, [documentId]);
        // A topic or course tag that only this reading kept alive is deleted too (its name came from this reading's words).
        if (existed) orphaned = dropOrphanAutoTags(db);
        // 4. Merge each index into one fresh segment, so the deleted words are gone from the index files too (R13).
        if (existed) for (const t of FTS_TABLES) db.exec(`INSERT INTO ${t} (${t}) VALUES ('optimize')`);
      });
      if (existed) publish([{ table: 'documents', ids: [documentId], op: 'delete', documentId }]);
      if (orphaned.length > 0) publish([{ table: 'tags', ids: orphaned, op: 'delete' }]);
    });
  }

  /** The thumbnail is a copy of a page, so it goes too. A failure is left to the library's sweep at its next start. */
  async function forgetThumbnail(documentId: DocumentId): Promise<void> {
    await deps.deleteThumbnail?.(documentId).catch(() => {
      console.warn('sickofpdfs: a forgotten reading\'s thumbnail could not be removed yet');
    });
  }

  return {
    ...base,
    ...createAnnotationsApi(db, deps),
    ...createPageFiguresApi(db, deps),
    ...createPageOcrApi(db, deps),
    ...createLibraryApi(db, deps, { document: documentFromRow, location: locationFromRow }),
    ...createBackupApi(db, deps),
    ...createRestoreApi(db, deps),
    ...createSettingsApi(db, deps),
    ...createTagsApi(db, deps),
    ...createLookupsApi(db, deps),
    ...createPassageVectorsApi(db),
    ...createCoursesApi(db, deps),
  };
}
