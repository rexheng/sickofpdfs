// Store schema v2 (Phase 2, contracts §4). Additive only: two columns, a table for unsent edits (R54), two indexes, re-created
// triggers and one rebuild of comments_fts. Nothing is dropped from a synced table, no CHECK changes, no value changes meaning.
//
// Wiring (Task 28's `migrate`): after the v1 block, `if (version < 2) applySchemaV2(db)`. Before anything else, call
// `guardNewerSchema(db)`: a database written by a newer version opens read-only and is never written.

/** What the SQL layer returns and accepts. The same set as `@sqlite.org/sqlite-wasm`'s `SqlValue` that this slice uses. */
export type SqlValue = string | number | null | bigint | Uint8Array | Int8Array | ArrayBuffer;

/**
 * The part of the `@sqlite.org/sqlite-wasm` oo1 `Database` that the Phase 2 store code uses. The real `Database`
 * (Task 28's `Sqlite3Database`) fits it, so these files do not import the package.
 */
export interface SqlDb {
  exec(sql: string): unknown;
  exec(opts: { sql: string; bind?: readonly SqlValue[] }): unknown;
  selectValue(sql: string, bind?: readonly SqlValue[]): SqlValue | undefined;
  selectObjects(sql: string, bind?: readonly SqlValue[]): Record<string, SqlValue>[];
  /** Runs `callback` in a transaction (or a nested savepoint) and rolls everything back if it throws. */
  savepoint<T>(callback: (db: SqlDb) => T): T;
}

/** The newest schema this code knows. A database above this opens read-only. */
export const SCHEMA_VERSION = 3;

const MARKS_AUTHOR = `ALTER TABLE marks ADD COLUMN author TEXT NOT NULL DEFAULT 'me' CHECK (author IN ('me','claude'))`;
// Non-NULL = a new thread whose first comment is unsent. Never synced.
const THREADS_DRAFT = 'ALTER TABLE threads ADD COLUMN draft_of_tab TEXT';
const COMMENTS_DRAFTS_INDEX = 'CREATE INDEX IF NOT EXISTS comments_drafts ON comments(draft_of_tab) WHERE draft_of_tab IS NOT NULL';

// R54: an unsent edit of a comment that was already sent. A separate table, not a column of `comments`: the edit text must
// never reach the outbox, the search index or the live text, and a column on `comments` would fire their triggers on every
// keystroke. Not a synced table, so it has no triggers. One row per comment. `edit_id` names one edit session: a 'closed'
// row (text cleared) is the marker that makes a late save of that session fail instead of bringing the edit back.
const COMMENT_EDITS_TABLE = `CREATE TABLE IF NOT EXISTS comment_edits (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  edit_id TEXT NOT NULL,
  draft_of_tab TEXT,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  updated_at INTEGER NOT NULL,
  CHECK (state = 'closed' OR draft_of_tab IS NOT NULL))`;
const COMMENT_EDITS_INDEX = 'CREATE INDEX IF NOT EXISTS comment_edits_owner ON comment_edits(document_id, draft_of_tab)';

const NOW_MS = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * Outbox triggers for one table, as Task 28 generates them (`INSERT` queues an upsert at base_rev 0, `UPDATE` queues one at
 * OLD.rev, `DELETE` queues a delete). `draft` adds the guard that keeps unsent drafts out of the outbox: they never sync.
 */
function outboxTriggers(table: 'threads' | 'comments'): string[] {
  const queue = (op: string, id: string, rev: string, hlc: string) =>
    `INSERT INTO outbox (table_name, row_id, op, base_rev, hlc, created_at) VALUES ('${table}', ${id}, '${op}', ${rev}, ${hlc}, ${NOW_MS});`;
  return [
    `CREATE TRIGGER ${table}_outbox_ai AFTER INSERT ON ${table} WHEN NEW.draft_of_tab IS NULL BEGIN ${queue('upsert', 'NEW.id', '0', 'NEW.hlc')} END`,
    `CREATE TRIGGER ${table}_outbox_au AFTER UPDATE ON ${table} WHEN NEW.draft_of_tab IS NULL BEGIN ${queue('upsert', 'NEW.id', 'OLD.rev', 'NEW.hlc')} END`,
    `CREATE TRIGGER ${table}_outbox_ad AFTER DELETE ON ${table} WHEN OLD.draft_of_tab IS NULL BEGIN ${queue('delete', 'OLD.id', 'OLD.rev', 'OLD.hlc')} END`,
  ];
}

// comments -> comments_fts: only sent, live comments are searchable. A sent, a soft-deleted and a Trash-restored comment
// all go through the UPDATE trigger, which drops the old entry and adds a new one only if the row now qualifies.
// TB2 finding 8: a draft is never indexed, so saving one (every typing burst) must not touch the index at all. The
// UPDATE trigger only runs when the row was or is a sent one, and only for the columns the index depends on; its DELETE
// scans the index (comment_id is UNINDEXED), which cost 2-7 ms per draft save on a big library.
const COMMENTS_FTS_AU = `CREATE TRIGGER comments_fts_au AFTER UPDATE OF body, draft_of_tab, deleted_at, document_id ON comments
     WHEN OLD.draft_of_tab IS NULL OR NEW.draft_of_tab IS NULL BEGIN
     DELETE FROM comments_fts WHERE comment_id = OLD.id;
     INSERT INTO comments_fts (comment_id, document_id, body) SELECT NEW.id, NEW.document_id, NEW.body
       WHERE NEW.draft_of_tab IS NULL AND NEW.deleted_at IS NULL; END`;
const COMMENTS_FTS_TRIGGERS = [
  `CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments WHEN NEW.draft_of_tab IS NULL AND NEW.deleted_at IS NULL BEGIN
     INSERT INTO comments_fts (comment_id, document_id, body) VALUES (NEW.id, NEW.document_id, NEW.body); END`,
  COMMENTS_FTS_AU,
  `CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN DELETE FROM comments_fts WHERE comment_id = OLD.id; END`,
];

const OWN_TRIGGERS = [
  ...['threads', 'comments'].flatMap((t) => ['ai', 'au', 'ad'].map((k) => `${t}_outbox_${k}`)),
  'comments_fts_ai',
  'comments_fts_au',
  'comments_fts_ad',
];

const REBUILD_COMMENTS_FTS = [
  'DELETE FROM comments_fts',
  `INSERT INTO comments_fts (comment_id, document_id, body)
     SELECT id, document_id, body FROM comments WHERE draft_of_tab IS NULL AND deleted_at IS NULL`,
];

/**
 * The whole v2 step as one SQL script (contracts §4), for reading and for a database that has none of v1's triggers
 * under other names. Do not run it on its own against a real v1 database: v1's triggers may carry other names, and
 * only `applySchemaV2` finds and drops them. It is not safe to run twice either (the ALTERs); `applySchemaV2` is.
 */
export const SCHEMA_V2 = [
  MARKS_AUTHOR,
  THREADS_DRAFT,
  COMMENTS_DRAFTS_INDEX,
  COMMENT_EDITS_TABLE,
  COMMENT_EDITS_INDEX,
  ...OWN_TRIGGERS.map((n) => `DROP TRIGGER IF EXISTS ${n}`),
  ...outboxTriggers('threads'),
  ...outboxTriggers('comments'),
  ...COMMENTS_FTS_TRIGGERS,
  ...REBUILD_COMMENTS_FTS,
]
  .map((s) => `${s.trim()};`)
  .join('\n');

function hasColumn(db: SqlDb, table: string, column: string): boolean {
  return db.selectObjects(`SELECT name FROM pragma_table_info('${table}')`).some((r) => r.name === column);
}

export function userVersion(db: SqlDb): number {
  return Number(db.selectValue('PRAGMA user_version') ?? 0);
}

/**
 * A database with a higher `user_version` than this code knows was written by a newer version. Open it read-only (the
 * connection refuses every write) and tell the person to update. Call it before `migrate`; when `readOnly` is true, do
 * not migrate.
 */
export function guardNewerSchema(db: SqlDb, known: number = SCHEMA_VERSION): { version: number; readOnly: boolean } {
  const version = userVersion(db);
  if (version > known) {
    db.exec('PRAGMA query_only = ON');
    return { version, readOnly: true };
  }
  return { version, readOnly: false };
}

/** True when the connection refuses writes: a newer database, or any other reason the owner set `query_only`. */
export function isReadOnly(db: SqlDb): boolean {
  return Number(db.selectValue('PRAGMA query_only') ?? 0) === 1;
}

/**
 * v1 -> v2, in one transaction (a savepoint, so it also nests inside `migrate`'s). Safe to run twice: columns are added only
 * when missing, the triggers are dropped and created again, and the FTS table is rebuilt from the rows. Sets
 * `user_version = 2` only when it is lower, so it can never move a newer database back.
 *
 * Every trigger on `threads` or `comments` that queues to the outbox or feeds `comments_fts` is dropped by what it does,
 * not by its name, because v1's generated names are not part of the contract.
 */
/**
 * A database already at v2 got the first comments_fts UPDATE trigger, which ran on every draft save. This puts the
 * current one in its place. It is a re-created trigger (contracts §4: allowed), changes no data and needs no rebuild,
 * because the index holds exactly what it held. Safe to run on every open; it does nothing when the trigger is current.
 */
export function refreshCommentsFtsTrigger(db: SqlDb): void {
  const now = db.selectValue(`SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'comments_fts_au'`);
  if (now === COMMENTS_FTS_AU) return;
  db.savepoint((tx) => {
    tx.exec('DROP TRIGGER IF EXISTS comments_fts_au');
    tx.exec(COMMENTS_FTS_AU);
  });
}

export function applySchemaV2(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    if (!hasColumn(tx, 'marks', 'id') || !hasColumn(tx, 'threads', 'id') || !hasColumn(tx, 'comments', 'id'))
      throw new Error('schema v1 is not present; run the v1 step first');

    if (!hasColumn(tx, 'marks', 'author')) tx.exec(MARKS_AUTHOR);
    if (!hasColumn(tx, 'threads', 'draft_of_tab')) tx.exec(THREADS_DRAFT);
    tx.exec(COMMENTS_DRAFTS_INDEX);
    tx.exec(COMMENT_EDITS_TABLE);
    tx.exec(COMMENT_EDITS_INDEX);

    const old = tx
      .selectObjects(
        `SELECT name FROM sqlite_schema WHERE type = 'trigger'
           AND ((tbl_name = 'threads' AND sql LIKE '%outbox%')
             OR (tbl_name = 'comments' AND (sql LIKE '%outbox%' OR sql LIKE '%comments_fts%')))`,
      )
      .map((r) => (typeof r.name === 'string' ? r.name : ''))
      .filter((n) => n.length > 0);
    for (const name of new Set([...old, ...OWN_TRIGGERS])) tx.exec(`DROP TRIGGER IF EXISTS "${name.replaceAll('"', '""')}"`);
    for (const sql of [...outboxTriggers('threads'), ...outboxTriggers('comments'), ...COMMENTS_FTS_TRIGGERS]) tx.exec(sql);

    for (const sql of REBUILD_COMMENTS_FTS) tx.exec(sql);

    if (userVersion(tx) < 2) tx.exec('PRAGMA user_version = 2');
  });
}
