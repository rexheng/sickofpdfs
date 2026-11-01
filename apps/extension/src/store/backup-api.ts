// What the backup needs from the database (contracts §5, Phase 3 S13): the whole library as the backup's `library.json`, and
// the writing of a restore plan (S17 plans it with `planRestore`; nothing here decides who wins).
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends BackupApi`, and the object it returns spreads `createBackupApi`.
// `protocol.ts` serves `BACKUP_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - The dump has camelCase rows and no unsent drafts (a thread, or a comment, that belongs to a tab that is still typing).
//   It never holds the search tables, page text, figures or the outbox, and a setting whose name says secret is left out.
// - A restore never deletes anything. It writes the rows of the plan, parents first, in one transaction, and publishes its
//   change events (origin 'restore') only after the commit. Running it again with the same plan changes nothing.
// - A restored row keeps the stamp it came with (pulled back to this clock if it is far in the future), and the store's
//   clock moves past it, so nothing written afterwards looks older than a restored row. `rev` is the store's own: a new row
//   starts at 0 and an existing one keeps its own. `blobStored` is local state: a new document has no PDF yet, and an
//   existing one keeps its value.
// - What comes from a backup is checked like what comes from the cloud: a row whose types are wrong is skipped (the other
//   rows still go in), and a row that would break the identity rules is skipped too.
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import { DUMP_TABLES, type DumpTable, type HlcStamp, type LibraryDump, type LibraryTables, type RestorePlan } from '@sop/core';
import { clampHlc, type DbRow, dbToWire, isSyncableSetting, MAX_HLC_SKEW_MS, normalizeWireRow, wireToDb } from '@sop/core/sync';
import type { StoreChange } from './change-bus';
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
  /** Writes the rows of a restore plan. Never deletes. Applying the same plan again changes nothing. */
  applyRestorePlan(plan: RestorePlan): Promise<void>;
}

export const BACKUP_API_METHODS = ['exportLibrary', 'exportChunk', 'applyRestorePlan'] as const satisfies readonly (keyof BackupApi)[];
export const BACKUP_READ_METHODS = ['exportLibrary', 'exportChunk'] as const satisfies readonly (keyof BackupApi)[];

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
      case 'comments':
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [text(wire.documentId)]) || !has('SELECT 1 AS x FROM threads WHERE id = ?', [text(wire.threadId)])) return false;
        break;
      case 'locations':
      case 'marks':
      case 'threads':
      case 'history':
        if (!has('SELECT 1 AS x FROM documents WHERE id = ?', [text(wire.documentId)])) return false;
        break;
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

  return {
    exportLibrary: () =>
      attempt(() => {
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
      }),

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

    applyRestorePlan: (plan) =>
      attempt(() => {
        assertWritable();
        if (!isRecord(plan) || !isRecord(plan.tables)) fail('bad-input', 'a restore plan has tables');
        const tables = plan.tables as unknown as Record<string, unknown>;
        const { written, newest, skipped } = db.savepoint(() => {
          const written = {} as Record<DumpTable, string[]>;
          let newest: HlcStamp | null = null;
          let skipped = 0;
          for (const table of DUMP_TABLES) {
            written[table] = [];
            const rows = tables[table];
            if (!Array.isArray(rows)) continue;
            for (const raw of rows as unknown[]) {
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
          return { written, newest, skipped };
        });
        // The clock moves past the restored stamps (but never past a far-future one: that is pulled back first).
        if (newest !== null) deps.hlc.receive(clampHlc(newest, deps.now(), MAX_HLC_SKEW_MS));
        if (skipped > 0) console.warn(`sickofpdfs: ${skipped} row(s) of a backup were not restored because they were not valid here`);
        const changes: StoreChange[] = [];
        for (const table of DUMP_TABLES) {
          const ids = written[table];
          for (let i = 0; i < ids.length; i += EVENT_IDS) changes.push({ table, ids: ids.slice(i, i + EVENT_IDS), op: 'upsert', origin: 'restore' });
        }
        publishAll(changes);
      }),
  };
}
