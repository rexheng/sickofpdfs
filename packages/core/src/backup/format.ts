// The backup format, version 1 (contracts §5): the types, the checks on what is read back, and the paths. Pure: no file system,
// no clock. The writer (S13, offscreen document) and restore (S17) are built on it.
//
//   sickofpdfs-backup/
//     manifest.json                          BackupManifest (written last, so a half-finished backup is never taken for a whole one)
//     library.json                           LibraryDump: { tables: { documents, aliases, locations, marks, threads, comments, history, settings,
//                                                              tags, reading_tags, auto_tag_removed } }
//     snapshots/library-<YYYY-MM-DD>.json    the last 7 nightly copies of library.json (rotate.ts)
//     pdf/<sha[0..2]>/<sha>.pdf              saved copies, once per fingerprint
//     notes/<title-slug>-<sha[0..8]>.md      the Markdown export of each document with notes (export/markdown.ts)
//
// A backup never holds: the key and tokens (`sop-local`), `sop-device`, drafts, the search tables, page text and figures, the
// outbox, or anything from a PDF that was not saved. The dump has drafts out; `parseLibraryDump` drops any that come back.
//
// What is read back is data from a folder that cloud sync tools write to, so it is checked: a manifest names only 64-hex
// fingerprints (a path is never built from anything else), and a dump's rows must carry the keys the merge relies on.
import type { HlcStamp } from '../hlc';
import type { DocumentId, Sha256 } from '../ids';
import type { AutoTagRemovedRow, CommentRow, DocumentRow, LocationRow, MarkRow, ReadingTagRow, TagRow, ThreadRow } from '../model/rows';
import { notesFileName } from '../export/markdown';

export const BACKUP_FORMAT = 'sop-backup';
/** The format version this code writes and the highest it can read. */
export const BACKUP_VERSION = 1;
/** The folder inside the one the owner picks. */
export const BACKUP_DIR = 'sickofpdfs-backup';
/** How many nightly copies of `library.json` are kept (open decision D6). */
export const SNAPSHOT_KEEP = 7;

export const MANIFEST_PATH = 'manifest.json';
export const LIBRARY_PATH = 'library.json';
export const SNAPSHOT_DIR = 'snapshots';
export const PDF_DIR = 'pdf';
export const NOTES_DIR = 'notes';

// ---- the tables ------------------------------------------------------------------------------------------------------

interface Stamped {
  rev: number;
  hlc: HlcStamp;
}

/** A second name for a document's bytes (a re-download with a different stamp). */
export interface AliasRow extends Stamped {
  sha256: Sha256;
  documentId: DocumentId;
  similarity: number;
  createdAt: number;
}

export type DumpLocation = LocationRow & Stamped;

export interface HistoryRow extends Stamped {
  documentId: DocumentId;
  firstOpened: number;
  lastOpened: number;
  openCount: number;
  readingMs: number;
  /** Where the reader stopped. `offset` and `zoom` are the viewer's numbers; `shown` is the page the page box showed (TB5). */
  lastPosition: { page: number; offset: number; zoom: number; shown?: number } | null;
  /** The pages visited, as a bitset in base64 (the same form the sync wire uses). */
  pagesVisited: string;
}

export interface SettingRow extends Stamped {
  key: string;
  value: string;
}

/**
 * The tables a backup holds, in the order they are written and restored (parents first). The three tag tables (local schema v5, R92)
 * come last: tags before the rows that name them. The categoriser's vectors (`embeddings`) are never in a backup.
 */
export const DUMP_TABLES = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings', 'tags', 'reading_tags', 'auto_tag_removed'] as const;
export type DumpTable = (typeof DUMP_TABLES)[number];

export interface LibraryTables {
  documents: DocumentRow[];
  aliases: AliasRow[];
  locations: DumpLocation[];
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
  history: HistoryRow[];
  settings: SettingRow[];
  tags: TagRow[];
  reading_tags: ReadingTagRow[];
  auto_tag_removed: AutoTagRemovedRow[];
}

/** `library.json`: camelCase rows, drafts excluded. */
export interface LibraryDump {
  tables: LibraryTables;
}

export const emptyTables = (): LibraryTables => ({
  documents: [],
  aliases: [],
  locations: [],
  marks: [],
  threads: [],
  comments: [],
  history: [],
  settings: [],
  tags: [],
  reading_tags: [],
  auto_tag_removed: [],
});
export const emptyDump = (): LibraryDump => ({ tables: emptyTables() });

// ---- the manifest ----------------------------------------------------------------------------------------------------

export interface BackupCounts {
  /** Documents that are not in Trash: the "readings". */
  documents: number;
  /** Comment threads that are not deleted: the "notes". */
  threads: number;
  marks: number;
  comments: number;
  /** PDF copies in the folder. */
  pdfs: number;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  /** The store's `user_version` when the backup was made. */
  schemaVersion: number;
  appVersion: string;
  counts: BackupCounts;
  /** The PDF copies in the folder: fingerprint to size in bytes. */
  pdfs: Record<Sha256, number>;
}

export type BackupErrorCode = 'not-a-backup' | 'too-new' | 'damaged';

/** A backup that cannot be used. `message` is plain words, fit to show as it is. */
export class BackupFormatError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupFormatError';
    this.code = code;
  }
}

/** What the owner is told when a backup was made by a newer version (contracts §5). */
export const TOO_NEW_MESSAGE = 'Update sickofpdfs first';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A SHA-256 as 64 lower-case hex characters: the only thing a backup path is ever built from. */
export function isSha(v: unknown): v is Sha256 {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * Reads `manifest.json`. Throws a `BackupFormatError`:
 *  - `not-a-backup` when it is not a sickofpdfs backup at all;
 *  - `too-new` ("Update sickofpdfs first") when a newer version wrote it. That is decided before anything else is checked,
 *    because a newer format may have changed the other fields;
 *  - `damaged` when a field this version needs is missing or the wrong type.
 * PDF entries whose key is not a fingerprint are dropped, so no path can be built from them.
 */
export function parseManifest(input: unknown): BackupManifest {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new BackupFormatError('damaged', 'The backup list could not be read.');
    }
  }
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) throw new BackupFormatError('not-a-backup', 'This folder does not hold a sickofpdfs backup.');
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new BackupFormatError('damaged', 'The backup list is damaged.');
  if (version > BACKUP_VERSION) throw new BackupFormatError('too-new', TOO_NEW_MESSAGE);
  const { createdAt, schemaVersion, appVersion } = raw;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) throw new BackupFormatError('damaged', 'The backup list is damaged.');
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new BackupFormatError('damaged', 'The backup list is damaged.');
  if (typeof appVersion !== 'string') throw new BackupFormatError('damaged', 'The backup list is damaged.');

  const rawCounts = isRecord(raw.counts) ? raw.counts : {};
  const counts: BackupCounts & Record<string, number> = { documents: 0, threads: 0, marks: 0, comments: 0, pdfs: 0 };
  for (const [k, v] of Object.entries(rawCounts)) if (isCount(v)) counts[k] = v;

  const pdfs: Record<Sha256, number> = {};
  if (raw.pdfs !== undefined && !isRecord(raw.pdfs)) throw new BackupFormatError('damaged', 'The backup list is damaged.');
  for (const [sha, size] of Object.entries(isRecord(raw.pdfs) ? raw.pdfs : {})) if (isSha(sha) && isCount(size)) pdfs[sha] = size;

  return { format: BACKUP_FORMAT, version, createdAt, schemaVersion, appVersion, counts, pdfs };
}

// ---- the dump --------------------------------------------------------------------------------------------------------

const KEY_OF: Readonly<Record<DumpTable, string>> = {
  documents: 'id',
  aliases: 'sha256',
  locations: 'id',
  marks: 'id',
  threads: 'id',
  comments: 'id',
  history: 'documentId',
  settings: 'key',
  tags: 'id',
  reading_tags: 'id',
  auto_tag_removed: 'id',
};

/** The field that names a row's document (settings and tags have none). */
const DOCUMENT_OF: Readonly<Record<DumpTable, string | null>> = {
  documents: 'id',
  aliases: 'documentId',
  locations: 'documentId',
  marks: 'documentId',
  threads: 'documentId',
  comments: 'documentId',
  history: 'documentId',
  settings: null,
  tags: null,
  reading_tags: 'documentId',
  auto_tag_removed: 'documentId',
};

/** A row that is an unsent draft. Drafts belong to the tab that is typing them and are never backed up or restored. */
export function isDraftRow(row: { draftOfTab?: unknown } | null | undefined): boolean {
  return row != null && row.draftOfTab !== undefined && row.draftOfTab !== null;
}

/**
 * Reads `library.json`. Throws a `BackupFormatError` (`damaged`) when there are no tables. Inside, a row that is not an
 * object, has no usable key, or is a draft is dropped, and so is a comment that belongs to a draft thread. A table that is
 * missing reads as empty (an older backup).
 */
export function parseLibraryDump(input: unknown): LibraryDump {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new BackupFormatError('damaged', 'The library file could not be read.');
    }
  }
  if (!isRecord(raw) || !isRecord(raw.tables)) throw new BackupFormatError('damaged', 'The library file is damaged.');
  const tables = emptyTables() as unknown as Record<DumpTable, Record<string, unknown>[]>;
  for (const t of DUMP_TABLES) {
    const rows = raw.tables[t];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new BackupFormatError('damaged', 'The library file is damaged.');
    const key = KEY_OF[t];
    const seen = new Set<string>();
    for (const row of rows as unknown[]) {
      if (!isRecord(row)) continue;
      const k = row[key];
      if (typeof k !== 'string' || k === '' || seen.has(k)) continue;
      const doc = DOCUMENT_OF[t];
      if (doc !== null && typeof row[doc] !== 'string') continue;
      if (isDraftRow(row)) continue;
      seen.add(k);
      tables[t].push(row);
    }
  }
  const draftThreads = new Set<string>();
  const rawThreads = raw.tables.threads;
  if (Array.isArray(rawThreads)) for (const t of rawThreads as unknown[]) if (isRecord(t) && isDraftRow(t) && typeof t.id === 'string') draftThreads.add(t.id);
  if (draftThreads.size > 0) tables.comments = tables.comments.filter((c) => !draftThreads.has(String(c.threadId)));
  return { tables: tables as unknown as LibraryTables };
}

// ---- counts and wording ----------------------------------------------------------------------------------------------

/** The counts a manifest carries, from a dump and the PDF copies written. Soft-deleted rows are not counted. */
export function countDump(dump: LibraryDump, pdfs: number): BackupCounts {
  const live = (rows: readonly { deletedAt?: number | null }[] | undefined): number => (rows ?? []).filter((r) => r.deletedAt == null).length;
  return {
    documents: live(dump.tables.documents),
    threads: live(dump.tables.threads),
    marks: live(dump.tables.marks),
    comments: live(dump.tables.comments),
    pdfs,
  };
}

export interface ManifestInput {
  createdAt: number;
  schemaVersion: number;
  appVersion: string;
  dump: LibraryDump;
  /** The PDF copies in the folder: fingerprint to size. */
  pdfs: Readonly<Record<string, number>>;
}

/** The manifest for a finished backup. PDF entries that are not fingerprints are left out. */
export function buildManifest(i: ManifestInput): BackupManifest {
  const pdfs: Record<Sha256, number> = {};
  for (const [sha, size] of Object.entries(i.pdfs)) if (isSha(sha) && isCount(size)) pdfs[sha] = size;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: i.createdAt,
    schemaVersion: i.schemaVersion,
    appVersion: i.appVersion,
    counts: countDump(i.dump, Object.keys(pdfs).length),
    pdfs,
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a backup holds, in the words the restore dialog uses: "12 readings, 340 notes, 9 PDFs". */
export function describeBackup(m: Pick<BackupManifest, 'counts'>): string {
  const c = m.counts;
  return [plural(c.documents, 'reading', 'readings'), plural(c.threads, 'note', 'notes'), plural(c.pdfs, 'PDF', 'PDFs')].join(', ');
}

// ---- paths -----------------------------------------------------------------------------------------------------------

/** The day in a snapshot's name: `YYYY-MM-DD`. */
export const snapshotPath = (day: string): string => `${SNAPSHOT_DIR}/library-${day}.json`;

/** `pdf/<sha[0..2]>/<sha>.pdf`. Throws for anything that is not a fingerprint, so a path can never be made from untrusted text. */
export function pdfPath(sha: string): string {
  if (!isSha(sha)) throw new RangeError('a backup PDF is named by its fingerprint');
  return `${PDF_DIR}/${sha.slice(0, 2)}/${sha}.pdf`;
}

/** `notes/<title-slug>-<sha[0..8]>.md` */
export function notesPath(title: string | null | undefined, sha: string): string {
  if (!isSha(sha)) throw new RangeError('a notes file is named by its fingerprint');
  return `${NOTES_DIR}/${notesFileName(title, sha)}`;
}

/** The parts of a path made here, for walking a folder handle one name at a time. */
export const pathSegments = (path: string): string[] => path.split('/').filter((s) => s !== '');
