// What the backup needs from the database (contracts §5, Phase 3 S13): the whole library as the backup's `library.json`, the
// readings that left for good (R82, forgotten.ts), and a restore: the plan (`planRestore`, pure core code) is made here, against the
// library as it is at that moment, and written in the same transaction, so a note typed while the restore dialog was open is never
// overwritten by a plan made before it (secread4 M5).
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends BackupApi`, and the object it returns spreads `createBackupApi`.
// `protocol.ts` serves `BACKUP_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - The dump has camelCase rows and no unsent drafts (a thread, or a comment, that belongs to a tab that is still typing).
//   It never holds the search tables, page text, figures or the outbox, and a setting whose name says secret is left out.
// - A restore never deletes anything. It plans and writes the rows, parents first, in one transaction, and publishes its change
//   events (origin 'restore') only after the commit. Running it again with the same backup changes nothing.
// - A restore never brings back a reading that left the library for good (a salted fingerprint in `forgotten`), with all that hangs
//   off it, even when the backup folder could not be cleaned.
// - A backup row never moves a note: a mark, thread, comment or location keeps the reading it has here, a comment keeps its thread
//   and its author, and a new comment must hang off a thread of its own reading. A row that tries is left out (before the plan is
//   made, so no "edited on another device" copy is made from it either, and again as it is written).
// - A restored row keeps the stamp it came with (pulled back to this clock if it is far in the future), and the store's
//   clock moves past it, so nothing written afterwards looks older than a restored row. `rev` is the store's own: a new row
//   starts at 0 and an existing one keeps its own. `blobStored` is local state: a new document has no PDF yet, and an
//   existing one keeps its value.
// - What comes from a backup is checked like what comes from the cloud: a row whose types are wrong is skipped (the other
//   rows still go in), and a row that would break the identity rules is skipped too.
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import {
  compareHlc,
  type DocumentId,
  DUMP_TABLES,
  type DumpTable,
  emptyTables,
  type HlcStamp,
  type LibraryDump,
  type LibraryTables,
  parseLibraryDump,
  planRestore,
  type RestoreSummary,
} from '@sop/core';
import { clampHlc, type DbRow, dbToWire, isSyncableSetting, MAX_HLC_SKEW_MS, normalizeWireRow, wireToDb } from '@sop/core/sync';
import type { StoreChange } from './change-bus';
import { forgottenAmong } from './forgotten';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';

/** Where a chunked export is. `version` is what the database's change counter said at the first chunk: a different value later means it changed. */
export interface ExportCursor {
  table: DumpTable;
  /** The key of the last row of `table` already read; null at the start of a table. */
  after: string | null;
  version: number;
}

export type ExportChunk =
  /** The library changed since the first chunk: the pieces read so far do not fit together. Start again. */
  | { stale: true }
  | { stale: false; table: DumpTable; rows: Record<string, unknown>[]; next: ExportCursor | null };

export interface BackupApi {
  /** Every table of the backup format, as camelCase rows (contracts §5). Drafts, secrets, search tables and the outbox are not in it. */
  exportLibrary(): Promise<LibraryDump>;
  /**
   * The same rows, a piece at a time. The backup reads a big library this way so the store worker answers a viewer's request between
   * two pieces; one `exportLibrary` call can hold the worker for most of a second. Call it with `null`, then with each `next`. When the
   * library was written to in between, the answer is `stale` and the caller starts again (or falls back to `exportLibrary`).
   */
  exportChunk(cursor: ExportCursor | null, limit: number): Promise<ExportChunk>;
  /**
   * Restores a backup's `library.json` (parsed or not) into this library: plans the merge against the rows as they are now and writes
   * it, in one transaction. Never deletes. Restoring the same backup again changes nothing. Readings forgotten here are left out, and
   * so is any row that would move a note to another reading. S17 copies the PDFs in `needsPdf` afterwards.
   */
  applyRestorePlan(backup: LibraryDump): Promise<RestoreResult>;
  /**
   * The fingerprints among `ids` that left the library for good (Forget, an Undo of a save, a Trash purge) and are not in it now. The
   * backup writer uses it to tell readings removed on purpose from readings that were lost (R82, R86). At most 10,000 ids.
   */
  forgottenAmong(ids: readonly string[]): Promise<string[]>;
}

export interface RestoreResult {
  /** Rows added and rows changed, per table. */
  summary: RestoreSummary;
  /** Readings now in the library whose PDF is not stored here: the restore copies these from the backup's `pdf/` folder. */
  needsPdf: DocumentId[];
  /** Readings in the backup that were forgotten here, and were left out. */
  forgotten: number;
  /** Rows that were not valid here, or would have moved a note to another reading, and were left out. */
  skipped: number;
}

/** The most rows one restore takes (all tables together). No library this version writes comes near it. */
export const MAX_RESTORE_ROWS = 2_000_000;
const MAX_FORGOTTEN_QUERY = 10_000;

export const BACKUP_API_METHODS = ['exportLibrary', 'exportChunk', 'applyRestorePlan', 'forgottenAmong'] as const satisfies readonly (keyof BackupApi)[];
export const BACKUP_READ_METHODS = ['exportLibrary', 'exportChunk', 'forgottenAmong'] as const satisfies readonly (keyof BackupApi)[];

export interface BackupDeps {
  now(): number;
  hlc: { tick(): HlcStamp; receive(remote: HlcStamp): HlcStamp };
  publish(c: StoreChange): void;
}

function fail(code: 'bad-input' | 'read-only', message: string): never {
  throw Object.assign(new Error(`${code}: ${message}`), { name: 'StoreError', code });
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

type Row = Record<string, SqlValue>;

/** The primary key column of each table. */
const KEY_COLUMN: Readonly<Record<DumpTable, string>> = {
  documents: 'id',
  aliases: 'sha256',
  locations: 'id',
  marks: 'id',
  threads: 'id',
  comments: 'id',
  history: 'document_id',
  settings: 'key',
  tags: 'id',
  reading_tags: 'id',
  auto_tag_removed: 'id',
};

/** The field of a wire row that is its id (and the column's camelCase name). */
const KEY_FIELD: Readonly<Record<DumpTable, string>> = {
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

/** Which rows go in a backup: a draft thread, a draft comment, and a comment of a draft thread are not backed up. */
const EXPORT_FILTER: Readonly<Record<DumpTable, string>> = {
  documents: '',
  aliases: '',
  locations: '',
  marks: '',
  threads: 'draft_of_tab IS NULL',
  comments: 'draft_of_tab IS NULL AND thread_id IN (SELECT id FROM threads WHERE draft_of_tab IS NULL)',
  history: '',
  settings: '',
  tags: '',
  reading_tags: '',
  auto_tag_removed: '',
};

/** The rows `exportLibrary` reads in one go, in pieces of this size. */
const WHOLE_EXPORT_PIECE = 2000;
const MAX_CHUNK = 5000;

/** The most ids one change event carries, so a big restore does not post one huge message. */
const EVENT_IDS = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createBackupApi(db: SqlDb, deps: BackupDeps): BackupApi {
  const binding = (bind: readonly SqlValue[]): SqlValue[] | undefined => (bind.length > 0 ? [...bind] : undefined);
  const select = (sql: string, bind: readonly SqlValue[] = []): Row[] => db.selectObjects(sql, binding(bind));
  const has = (sql: string, bind: readonly SqlValue[]): boolean => select(sql, bind).length > 0;
  const assertWritable = (): void => {
    if (isReadOnly(db)) fail('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
  };

  /** A database row as the backup's row: the wire shape, with the stamps, and a document's `blobStored` (local state, kept for the record). */
  function backupRow(table: DumpTable, r: Row): Record<string, unknown> {
    const { row, rev, hlc } = dbToWire(table, r as DbRow);
    const out: Record<string, unknown> = { ...row };
    if (table === 'documents') out.blobStored = r.blob_stored === 1 || r.blob_stored === 1n;
    out.rev = rev;
    out.hlc = hlc;
    return out;
  }

  /** Up to `limit` rows of a table that go in a backup, after the key `after`, in key order. */
  function readRows(table: DumpTable, after: string | null, limit: number): Row[] {
    const where = [EXPORT_FILTER[table], after === null ? '' : `${KEY_COLUMN[table]} > ?`].filter((w) => w !== '').join(' AND ');
    return select(`SELECT * FROM ${table}${where === '' ? '' : ` WHERE ${where}`} ORDER BY ${KEY_COLUMN[table]} LIMIT ?`, after === null ? [limit] : [after, limit]);
  }

  /** Database rows as backup rows. A setting whose name says secret is left out: a second lock on the door, since secrets live in sop-local. */
  function exportedRows(table: DumpTable, raw: readonly Row[]): Record<string, unknown>[] {
    const rows = raw.map((r) => backupRow(table, r));
    return table === 'settings' ? rows.filter((r) => isSyncableSetting(text(r.key))) : rows;
  }

  function publishAll(changes: StoreChange[]): void {
    for (const c of changes) {
      try {
        deps.publish(c);
      } catch {
        // The restore is committed. Other tabs catch up on their next read.
      }
    }
  }

  /**
   * True when a backup row would change what an existing row here belongs to: its reading, or one of the `also` columns (database
   * column, wire field). A backup can never move a note to another reading or thread, or give it another author.
   */
  function moves(table: 'marks' | 'threads' | 'comments' | 'locations', key: string, wire: Record<string, unknown>, ...also: [string, string][]): boolean {
    const cur = select(`SELECT * FROM ${table} WHERE id = ?`, [key])[0];
    if (cur === undefined) return false;
    if (text(cur.document_id) !== text(wire.documentId)) return true;
    return also.some(([column, field]) => text(cur[column]) !== text(wire[field]));
  }

  /** Writes one validated row. Returns false when the row is skipped (it would break an identity rule, or its document is not here). */
  function writeRow(table: DumpTable, wire: Record<string, unknown>): boolean {
    const key = text(wire[KEY_FIELD[table]]);
    if (key === '') return false;
    const stamp = text(wire.hlc);
    const hlc: HlcStamp = stamp === '' ? deps.hlc.tick() : clampHlc(stamp, deps.now());

    // The rows must hang off a document that is here (the plan is parents first), and keep the identity rules (a fingerprint is a document or an alias, never both).
    switch (table) {
      case 'documents':
        if (has('SELECT 1 AS x FROM aliases WHERE sha256 = ?', [key])) return false;
        break;
      case 'aliases':
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [text(wire.documentId)]) || has('SELECT 1 AS x FROM documents WHERE id = ?', [key])) return false;
        break;
      case 'settings':
        if (!isSyncableSetting(key)) return false;
        break;
      case 'comments': {
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [text(wire.documentId)])) return false;
        // A comment hangs off a thread of its own reading, and an existing one keeps its reading, its thread and its author.
        if (!has('SELECT 1 AS x FROM threads WHERE id = ? AND document_id = ?', [text(wire.threadId), text(wire.documentId)])) return false;
        if (moves('comments', key, wire, ['thread_id', 'threadId'], ['author', 'author'])) return false;
        break;
      }
      case 'marks':
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [text(wire.documentId)]) || moves('marks', key, wire, ['author', 'author'])) return false;
        break;
      case 'locations':
      case 'threads':
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [text(wire.documentId)]) || moves(table, key, wire)) return false;
        break;
      case 'history':
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [text(wire.documentId)])) return false;
        break;
      case 'tags': {
        // A live tag name is unique here: a backup tag that would take another live tag's name is left out (the plan folds the usual cases).
        if (wire.deletedAt == null && has('SELECT 1 AS x FROM tags WHERE name = ? COLLATE NOCASE AND id <> ? AND deleted_at IS NULL', [text(wire.name), key])) return false;
        break;
      }
      case 'reading_tags':
      case 'auto_tag_removed': {
        const doc = text(wire.documentId);
        const tag = text(wire.tagId);
        // The row names a reading and a tag that are both here, and its id says so. An auto tag the owner took off this reading stays off.
        if (key !== `${doc}:${tag}`) return false;
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [doc]) || !has('SELECT 1 AS x FROM tags WHERE id = ?', [tag])) return false;
        if (table === 'reading_tags' && wire.source === 'auto' && has('SELECT 1 AS x FROM auto_tag_removed WHERE document_id = ? AND tag_id = ?', [doc, tag])) return false;
        break;
      }
    }

    const data = wireToDb(table, wire, { rev: 0, hlc });
    const columns = Object.keys(data).filter((c) => c !== 'rev' && c !== 'hlc');
    const names = [...columns, 'rev', 'hlc', ...(table === 'documents' ? ['blob_stored'] : [])];
    const values = [...columns.map((c) => data[c] as SqlValue), 0, hlc, ...(table === 'documents' ? [0] : [])];
    // An existing row keeps its `rev` and (for a document) its `blob_stored`; everything else the plan gives is written.
    const update = [...columns.filter((c) => c !== KEY_COLUMN[table]), 'hlc'].map((c) => `${c} = excluded.${c}`);
    db.exec({
      sql: `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
            ON CONFLICT (${KEY_COLUMN[table]}) DO UPDATE SET ${update.join(', ')}`,
      bind: values,
    });
    return true;
  }

  /** The whole library as a backup dump, read in one go. */
  function readWholeLibrary(): LibraryDump {
    const tables = {} as Record<DumpTable, Record<string, unknown>[]>;
    for (const table of DUMP_TABLES) {
      tables[table] = [];
      for (let after: string | null = null; ; ) {
        const raw = readRows(table, after, WHOLE_EXPORT_PIECE);
        tables[table].push(...exportedRows(table, raw));
        if (raw.length < WHOLE_EXPORT_PIECE) break;
        after = text(raw[raw.length - 1][KEY_COLUMN[table]]);
      }
    }
    return { tables: tables as unknown as LibraryTables };
  }

  return {
    exportLibrary: () => attempt(readWholeLibrary),

    exportChunk: (cursor, limit) =>
      attempt((): ExportChunk => {
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHUNK) fail('bad-input', `a chunk is 1 to ${MAX_CHUNK} rows`);
        const version = Number(db.selectValue('SELECT total_changes()') ?? 0);
        let c: ExportCursor;
        if (cursor === null) c = { table: DUMP_TABLES[0], after: null, version };
        else {
          if (!isRecord(cursor) || !(DUMP_TABLES as readonly string[]).includes(String(cursor.table)) || typeof cursor.version !== 'number' || (cursor.after !== null && typeof cursor.after !== 'string')) {
            fail('bad-input', 'that is not a place in the export');
          }
          if (cursor.version !== version) return { stale: true };
          c = cursor;
        }
        const raw = readRows(c.table, c.after, limit);
        const rows = exportedRows(c.table, raw);
        let next: ExportCursor | null;
        if (raw.length === limit) next = { table: c.table, after: text(raw[raw.length - 1][KEY_COLUMN[c.table]]), version: c.version };
        else {
          const following = DUMP_TABLES[DUMP_TABLES.indexOf(c.table) + 1];
          next = following === undefined ? null : { table: following, after: null, version: c.version };
        }
        return { stale: false, table: c.table, rows, next };
      }),

    applyRestorePlan: async (input) => {
      const backup = await attempt(() => {
        assertWritable();
        if (!isRecord(input) || !isRecord(input.tables)) fail('bad-input', 'a backup has tables');
        let rows = 0;
        for (const table of DUMP_TABLES) {
          const r = (input.tables as Record<string, unknown>)[table];
          if (Array.isArray(r)) rows += r.length;
        }
        if (rows > MAX_RESTORE_ROWS) fail('bad-input', 'this backup is too big to be one of ours');
        try {
          return parseLibraryDump(input);
        } catch {
          return fail('bad-input', 'the backup library file is damaged');
        }
      });
      // Readings forgotten here are found first (hashing is asynchronous); the request queue keeps the library still until the write.
      const ids = [...backup.tables.documents.map((d) => text(d.id)), ...backup.tables.aliases.map((a) => text(a.sha256))];
      const forgotten = new Set(await forgottenAmong(db, ids));
      return attempt((): RestoreResult => {
        assertWritable();
        const { result, written, newest } = db.savepoint(() => {
          // The plan is made here, against the rows as they are now, and written before anything else can change them.
          const local = readWholeLibrary();
          const screened = screenBackup(local, backup, forgotten);
          const plan = planRestore(local, screened.dump, compareHlc, { now: deps.now() });
          const written = {} as Record<DumpTable, string[]>;
          let newest: HlcStamp | null = null;
          let skipped = screened.skipped;
          const tables = plan.tables as unknown as Record<DumpTable, unknown[]>;
          for (const table of DUMP_TABLES) {
            written[table] = [];
            for (const raw of tables[table]) {
              // Types, enums and ranges are checked as sync checks a row from the cloud. A size cap is not a reason to lose a row from this library's own backup.
              const checked = isRecord(raw) ? normalizeWireRow(table, raw) : null;
              if (!isRecord(raw) || checked === null || (!checked.ok && checked.code !== 'too_large') || !writeRow(table, raw)) {
                skipped += 1;
                continue;
              }
              written[table].push(text(raw[KEY_FIELD[table]]));
              const stamp = text(raw.hlc);
              if (stamp !== '' && (newest === null || stamp > newest)) newest = stamp;
            }
          }
          const result: RestoreResult = { summary: plan.summary, needsPdf: plan.needsPdf, forgotten: screened.forgotten, skipped };
          return { result, written, newest };
        });
        // The clock moves past the restored stamps (but never past a far-future one: that is pulled back first).
        if (newest !== null) deps.hlc.receive(clampHlc(newest, deps.now(), MAX_HLC_SKEW_MS));
        if (result.skipped > 0) console.warn(`sickofpdfs: ${result.skipped} row(s) of a backup were not restored because they were not valid here`);
        const changes: StoreChange[] = [];
        for (const table of DUMP_TABLES) {
          const ids = written[table];
          for (let i = 0; i < ids.length; i += EVENT_IDS) changes.push({ table, ids: ids.slice(i, i + EVENT_IDS), op: 'upsert', origin: 'restore' });
        }
        publishAll(changes);
        return result;
      });
    },

    forgottenAmong: async (ids) => {
      const list = await attempt(() => {
        if (!Array.isArray(ids) || ids.length > MAX_FORGOTTEN_QUERY) fail('bad-input', `ids is a list of at most ${MAX_FORGOTTEN_QUERY} fingerprints`);
        return ids.filter((id): id is string => typeof id === 'string');
      });
      return forgottenAmong(db, list);
    },
  };
}

/**
 * The backup without what must not come back, before the merge is planned:
 *  - readings forgotten here (`forgotten`), with their aliases and everything that hangs off them;
 *  - rows that would move a note: an existing mark, thread, comment or location of another reading (a backup row's reading is first
 *    taken through this library's aliases, as the merge does), a comment of another thread or author, a mark of another author, and a
 *    new comment whose thread belongs to another reading.
 * Dropping them here, and not only when writing, also stops the merge from making an "edited on another device" copy out of one.
 */
function screenBackup(local: LibraryDump, backup: LibraryDump, forgotten: ReadonlySet<string>): { dump: LibraryDump; skipped: number; forgotten: number } {
  type Wire = Record<string, unknown>;
  const L = local.tables as unknown as Record<DumpTable, Wire[]>;
  const B = backup.tables as unknown as Record<DumpTable, Wire[]>;
  const localDocs = new Set(L.documents.map((d) => text(d.id)));
  const aliasTo = new Map(L.aliases.map((a) => [text(a.sha256), text(a.documentId)]));
  /** Where a reading of the backup lands here: itself, or the reading here that it is an alias of. */
  const landsOn = (id: string): string => (localDocs.has(id) ? id : (aliasTo.get(id) ?? id));
  const byId = (rows: readonly Wire[]): Map<string, Wire> => new Map(rows.map((r) => [text(r.id), r]));
  const here = { marks: byId(L.marks), threads: byId(L.threads), comments: byId(L.comments), locations: byId(L.locations) };
  const backupThreads = byId(B.threads);
  let skipped = 0;
  const keep = (ok: boolean): boolean => {
    if (!ok) skipped += 1;
    return ok;
  };
  const sameReading = (l: Wire | undefined, b: Wire): boolean => l === undefined || text(l.documentId) === landsOn(text(b.documentId));
  const notForgotten = (r: Wire): boolean => !forgotten.has(text(r.documentId));

  const out = emptyTables() as unknown as Record<DumpTable, Wire[]>;
  const forgottenDocs = B.documents.filter((d) => forgotten.has(text(d.id))).length;
  out.documents = B.documents.filter((d) => !forgotten.has(text(d.id)));
  out.aliases = B.aliases.filter((a) => !forgotten.has(text(a.sha256)) && notForgotten(a));
  out.history = B.history.filter(notForgotten);
  out.settings = B.settings;
  out.tags = B.tags;
  out.reading_tags = B.reading_tags.filter(notForgotten);
  out.auto_tag_removed = B.auto_tag_removed.filter(notForgotten);
  out.locations = B.locations.filter(notForgotten).filter((b) => keep(sameReading(here.locations.get(text(b.id)), b)));
  out.threads = B.threads.filter(notForgotten).filter((b) => keep(sameReading(here.threads.get(text(b.id)), b)));
  out.marks = B.marks.filter(notForgotten).filter((b) => {
    const l = here.marks.get(text(b.id));
    return keep(sameReading(l, b) && (l === undefined || text(l.author) === text(b.author)));
  });
  out.comments = B.comments.filter(notForgotten).filter((b) => {
    const l = here.comments.get(text(b.id));
    if (l !== undefined) return keep(sameReading(l, b) && text(l.threadId) === text(b.threadId) && text(l.author) === text(b.author));
    const thread = here.threads.get(text(b.threadId)) ?? backupThreads.get(text(b.threadId));
    return keep(thread === undefined || landsOn(text(thread.documentId)) === landsOn(text(b.documentId)));
  });
  return { dump: { tables: out as unknown as LibraryTables }, skipped, forgotten: forgottenDocs };
}
