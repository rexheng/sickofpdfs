// The synced tables as the push and pull handlers see them: SQL for reading and writing one row, in the cloud copy's columns.
// Column facts come from `@sop/core/sync` (columns.ts), so the server and the devices can never disagree about a column.

import { type ChangeEntry, type DbRow, type ServerRow, type SyncedTable, TABLE_SPECS, type WireRow, dbToWire, snakeCase, wireIdOf, wireToDb } from '@sop/core/sync';

/** The order a push is applied in: a document before anything that names it, a tag before a reading's tag. */
export const APPLY_ORDER: readonly SyncedTable[] = ['documents', 'aliases', 'locations', 'tags', 'reading_tags', 'auto_tag_removed', 'marks', 'threads', 'comments', 'history', 'settings'];

/** D1 allows 100 bound values per statement; keep a margin. */
export const ID_CHUNK = 90;

export const pkColumn = (table: SyncedTable): string => snakeCase(TABLE_SPECS[table].idField);

const pkText = (db: DbRow, table: SyncedTable): string => {
  const v = db[pkColumn(table)];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};

export function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** SELECT the stored rows with these ids, in statements of at most 90 ids. */
export function selectByIds(db: D1Database, table: SyncedTable, ids: readonly string[]): D1PreparedStatement[] {
  return chunk([...new Set(ids)]).map((part) => db.prepare(`SELECT * FROM ${table} WHERE ${pkColumn(table)} IN (${marks(part.length)})`).bind(...part));
}

export function toServerRow(table: SyncedTable, db: DbRow): ServerRow {
  const { row, rev, hlc } = dbToWire(table, db);
  const id = wireIdOf(table, row) ?? pkText(db, table);
  return { table, id, rev, hlc, device: typeof db.device === 'string' ? db.device : '', row };
}

type Bindable = string | number | null | ArrayBuffer;

function bindable(v: string | number | null | Uint8Array): Bindable {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  return v;
}

function columnsAndValues(table: SyncedTable, row: WireRow, meta: { rev: number; hlc: string; seq: number; device: string }): { cols: string[]; values: Bindable[] } {
  const db = wireToDb(table, row, { rev: meta.rev, hlc: meta.hlc });
  const cols = [...Object.keys(db), 'seq', 'device'];
  const values = [...Object.values(db).map(bindable), meta.seq, meta.device];
  return { cols, values };
}

/**
 * Writes one row: inserted, or updated in place. Never `INSERT OR REPLACE`, which would delete the row first and cascade to
 * its notes. Columns the server owns (`blob_stored`, `mcp_request_id`) are not touched.
 */
export function upsertRow(db: D1Database, table: SyncedTable, row: WireRow, meta: { rev: number; hlc: string; seq: number; device: string }): D1PreparedStatement {
  const { cols, values } = columnsAndValues(table, row, meta);
  const pk = pkColumn(table);
  const set = cols.filter((c) => c !== pk).map((c) => `${c} = excluded.${c}`).join(', ');
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks(cols.length)}) ON CONFLICT(${pk}) DO UPDATE SET ${set}`).bind(...values);
}

/** A row that must appear only if no row has its id (a conflict copy: a retry, or a copy the owner already deleted, stays as it is). */
export function insertIfAbsent(db: D1Database, table: SyncedTable, row: WireRow, meta: { rev: number; hlc: string; seq: number; device: string }): D1PreparedStatement {
  const { cols, values } = columnsAndValues(table, row, meta);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks(cols.length)}) ON CONFLICT(${pkColumn(table)}) DO NOTHING`).bind(...values);
}

/**
 * The cloud copy's CHECKs that `normalizeWireRow` does not already test. A row that would break one is refused alone
 * (`bad_row`), so it can never make the database refuse the whole push.
 */
export function cloudCheck(table: SyncedTable, row: WireRow): string | null {
  if (table === 'tags' && (typeof row.name !== 'string' || row.name.length === 0)) return 'name is empty';
  if ((table === 'reading_tags' || table === 'auto_tag_removed') && row.id !== `${String(row.documentId)}:${String(row.tagId)}`) return 'id must be <documentId>:<tagId>';
  return null;
}

/** The document a row belongs to, or null (`documents` itself, `settings`, `tags`). */
export function documentOf(table: SyncedTable, row: Record<string, unknown>): string | null {
  const f = TABLE_SPECS[table].documentField;
  if (f === null) return null;
  const v = row[f];
  return typeof v === 'string' ? v : null;
}

/** The wire form of a stored row, as a pull or a rebase sends it. */
export function entryOf(table: SyncedTable, db: DbRow): ChangeEntry & { rev: number; seq: number; device: string } {
  const { row, rev, hlc } = dbToWire(table, db);
  return {
    table,
    id: wireIdOf(table, row) ?? pkText(db, table),
    baseRev: rev,
    hlc,
    row,
    ...(table === 'documents' ? { label: 'learning' as const } : {}),
    rev,
    seq: Number(db.seq ?? 0),
    device: typeof db.device === 'string' ? db.device : '',
  };
}
