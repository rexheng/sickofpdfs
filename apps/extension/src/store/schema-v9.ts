// Store schema v9 (Release 2, CL9, Nov 10): the sync side of the local library. Additive only: two local tables, one nullable
// column on the outbox, one index, and the outbox triggers of the eleven synced tables re-created with one more condition.
//
// The ladder (contracts §4): OCR is v7, import v8, sync v9. A later step (page order, R108) takes v10.
//
// - `sync_state (key, value)`: the sync side's own small values, on this computer only (never synced, not a backup or export table).
//   Keys: `cursor` (the last pulled `seq`), `deviceRegistered` (the server's device id), `uploadPdfs` ('1' or '0'), `keepLocal:<id>`,
//   `neverSync:<id>`, `textSent:<id>`, `needBlob:<id>`, `tagFold:<tagId>`, `dupOf:<id>`, and `applying` (below).
// - `sync_parked (table_name, row_id, document_id, entry, parked_at)`: a pulled row that names a document, thread or tag this
//   computer does not hold yet. A pull hands out rows in `seq` order, and a row keeps the `seq` of its LAST change, so a note can
//   arrive before its document when the document changed again later. The row waits here and is applied when its parent comes.
//   Local only. A parked row of a reading forgotten here, or forgotten in the cloud, is dropped.
// - `outbox.row_json`: for a hard DELETE of a row that has soft deletes (marks, threads, comments, tags), the row as it was. The
//   wire has no hard delete, so the push sends it as a tombstone (`deletedAt` set) and the other computers drop it too. The
//   notes moved to a newer web page (R103) and the auto tags nothing uses any more are such rows.
// - The outbox triggers: every one of them now also says `AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'applying')`.
//   The sync side sets `applying` inside the transaction that writes pulled rows and acks, and removes it before that transaction
//   ends, so those writes never queue a push (contracts §7: "pulled rows and acks never enter the outbox"). This is the
//   contract's `sop_sync_applying()` as a row instead of an SQL function: a function must be registered on every connection (the
//   extension's store worker, the Android copy, Node), and a connection that forgot would fail every write; the row cannot be
//   forgotten, and a crash rolls it back with the transaction. `migrate` also removes a stale one on every open.
//
// Every statement is idempotent, and running the step twice changes nothing.
import { dbColumns, type SyncedTable } from '@sop/core/sync';
import { SCHEMA_VERSION, type SqlDb, userVersion } from './schema-v2';

/** The newest schema this file brings a database to. */
export const SCHEMA_V9_VERSION = 9;

/** The eleven synced tables of the local library, with their primary key column. */
export const LOCAL_SYNCED_TABLES: Readonly<Record<SyncedTable, string>> = {
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

/** The `sync_state` key that tells the outbox triggers a sync write is running. */
export const APPLYING_KEY = 'applying';
const NOT_APPLYING = `NOT EXISTS (SELECT 1 FROM sync_state WHERE key = '${APPLYING_KEY}')`;

const NOW_MS = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/** Tables whose unsent drafts never queue (`draft_of_tab`, schema v2). */
const DRAFT_TABLES: ReadonlySet<string> = new Set(['threads', 'comments']);

/** Tables that keep a copy of a hard-deleted row, so it can leave as a tombstone. `documents` leaves only by Forget or the purge. */
const TOMBSTONE_TABLES: ReadonlySet<SyncedTable> = new Set(['marks', 'threads', 'comments', 'tags']);

/** `json_object(...)` of every local column of the OLD row. These tables hold no BLOB column. */
function oldRowJson(table: SyncedTable): string {
  const cols = dbColumns(table, 'local');
  return `json_object(${cols.map((c) => `'${c}', OLD.${c}`).join(', ')})`;
}

/** The three outbox triggers of one synced table, v9 form. Same names as v1, v2 and v5, so they replace those. */
export function outboxTriggersV9(table: SyncedTable): string[] {
  const pk = LOCAL_SYNCED_TABLES[table];
  const when = (row: 'NEW' | 'OLD') => ` WHEN ${DRAFT_TABLES.has(table) ? `${row}.draft_of_tab IS NULL AND ` : ''}${NOT_APPLYING}`;
  const queue = (op: 'upsert' | 'delete', row: 'NEW' | 'OLD', rev: string, json: string) =>
    `INSERT INTO outbox (table_name, row_id, op, base_rev, hlc, created_at, row_json) VALUES ('${table}', ${row}.${pk}, '${op}', ${rev}, ${row}.hlc, ${NOW_MS}, ${json});`;
  const tomb = TOMBSTONE_TABLES.has(table) ? oldRowJson(table) : 'NULL';
  return [
    `CREATE TRIGGER ${table}_outbox_ai AFTER INSERT ON ${table}${when('NEW')} BEGIN ${queue('upsert', 'NEW', '0', 'NULL')} END`,
    `CREATE TRIGGER ${table}_outbox_au AFTER UPDATE ON ${table}${when('NEW')} BEGIN ${queue('upsert', 'NEW', 'OLD.rev', 'NULL')} END`,
    `CREATE TRIGGER ${table}_outbox_ad AFTER DELETE ON ${table}${when('OLD')} BEGIN ${queue('delete', 'OLD', 'OLD.rev', tomb)} END`,
  ];
}

const TABLES = [
  'CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID',
  `CREATE TABLE IF NOT EXISTS sync_parked (
    table_name TEXT NOT NULL, row_id TEXT NOT NULL, document_id TEXT, entry TEXT NOT NULL, parked_at INTEGER NOT NULL,
    PRIMARY KEY (table_name, row_id)) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS sync_parked_document ON sync_parked(document_id)',
  'CREATE INDEX IF NOT EXISTS outbox_row ON outbox(table_name, row_id)',
];

const TABLE_NAMES = Object.keys(LOCAL_SYNCED_TABLES) as SyncedTable[];

/** The whole v9 step as one SQL script, for reading. Run it through `applySchemaV9`, which also finds older triggers by what they do. */
export const SCHEMA_V9 = [
  ...TABLES,
  'ALTER TABLE outbox ADD COLUMN row_json TEXT',
  ...TABLE_NAMES.flatMap((t) => ['ai', 'au', 'ad'].map((k) => `DROP TRIGGER IF EXISTS ${t}_outbox_${k}`)),
  ...TABLE_NAMES.flatMap((t) => outboxTriggersV9(t)),
]
  .map((s) => `${s.trim().replace(/\s+/g, ' ')};`)
  .join('\n');

function hasColumn(db: SqlDb, table: string, column: string): boolean {
  return db.selectObjects(`SELECT name FROM pragma_table_info('${table}')`).some((r) => r.name === column);
}

/**
 * v8 -> v9, in one transaction (a savepoint, so it also nests inside `migrate`'s). Safe to run twice. Every trigger on a synced table
 * that writes to the outbox is dropped by what it does, not only by its name (v1's names are not part of the contract), and the v9
 * ones are created. The outbox's queued rows are kept as they are: they are what this computer has not sent yet.
 */
export function applySchemaV9(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    for (const sql of TABLES) tx.exec(sql);
    if (!hasColumn(tx, 'outbox', 'row_json')) tx.exec('ALTER TABLE outbox ADD COLUMN row_json TEXT');
    const list = TABLE_NAMES.map((t) => `'${t}'`).join(', ');
    const old = tx
      .selectObjects(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN (${list}) AND sql LIKE '%INSERT INTO outbox%'`)
      .map((r) => (typeof r.name === 'string' ? r.name : ''))
      .filter((n) => n.length > 0);
    const own = TABLE_NAMES.flatMap((t) => ['ai', 'au', 'ad'].map((k) => `${t}_outbox_${k}`));
    for (const name of new Set([...old, ...own])) tx.exec(`DROP TRIGGER IF EXISTS "${name.replaceAll('"', '""')}"`);
    for (const t of TABLE_NAMES) for (const sql of outboxTriggersV9(t)) tx.exec(sql);
    if (userVersion(tx) < SCHEMA_V9_VERSION) tx.exec(`PRAGMA user_version = ${SCHEMA_V9_VERSION}`);
  });
}

/** Removes a stale `applying` flag. It can only be left by a bug (a crash rolls it back), and it would stop every edit from queueing. */
export function clearApplyingFlag(db: SqlDb): void {
  db.exec({ sql: 'DELETE FROM sync_state WHERE key = ?', bind: [APPLYING_KEY] });
}
