// Store schema v3 (Phase 3, contracts §4). Additive only: one index, three re-created triggers and one rebuild of
// documents_fts. Nothing is dropped from a synced table, no CHECK changes, no value changes meaning.
//
// What it changes:
// - `documents_fts` skips trashed documents (`deleted_at` set), so a title or author in Trash is not a search hit. Trashing
//   removes the entry, restoring puts it back, and a title edit on a trashed document adds nothing.
// - `history(last_opened)` is indexed, for the Recent list and the "date read" filter.
//
// Wiring (Task 28's `migrate`): after the v2 block, `if (userVersion(db) < 3) applySchemaV3(db)`.
import { SCHEMA_VERSION, type SqlDb, userVersion } from './schema-v2';

/** The newest schema this file brings a database to. */
export const SCHEMA_V3_VERSION = 3;

const HISTORY_LAST_OPENED_INDEX = 'CREATE INDEX IF NOT EXISTS history_last_opened ON history(last_opened)';

/** An author list as words for the index: the JSON array's strings joined by spaces (the same words v1 indexes). */
const AUTHOR_WORDS = `(SELECT coalesce(group_concat(value, ' '), '') FROM json_each(CASE WHEN json_valid(NEW.authors) THEN NEW.authors ELSE '[]' END))`;

// documents -> documents_fts: live (not trashed) documents only. The UPDATE trigger also fires when `deleted_at` changes:
// it drops the old entry, and adds a new one only if the row is live now. A delete of the document drops the entry as in v1.
const DOCUMENTS_FTS_TRIGGERS = [
  `CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents WHEN NEW.deleted_at IS NULL BEGIN
     INSERT INTO documents_fts (document_id, title, authors) VALUES (NEW.id, coalesce(NEW.title, ''), ${AUTHOR_WORDS}); END`,
  `CREATE TRIGGER documents_fts_au AFTER UPDATE OF title, authors, deleted_at ON documents BEGIN
     DELETE FROM documents_fts WHERE document_id = OLD.id;
     INSERT INTO documents_fts (document_id, title, authors) SELECT NEW.id, coalesce(NEW.title, ''), ${AUTHOR_WORDS} WHERE NEW.deleted_at IS NULL; END`,
  `CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
     DELETE FROM documents_fts WHERE document_id = OLD.id; END`,
];

const OWN_TRIGGERS = ['documents_fts_ai', 'documents_fts_au', 'documents_fts_ad'];

const REBUILD_DOCUMENTS_FTS = [
  'DELETE FROM documents_fts',
  `INSERT INTO documents_fts (document_id, title, authors)
     SELECT id, coalesce(title, ''),
       (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(CASE WHEN json_valid(authors) THEN authors ELSE '[]' END))
     FROM documents WHERE deleted_at IS NULL`,
];

/**
 * The whole v3 step as one SQL script (contracts §4), for reading. Run it through `applySchemaV3`, which also finds the
 * v1/v2 triggers under whatever names they have and sets the version.
 */
export const SCHEMA_V3 = [
  HISTORY_LAST_OPENED_INDEX,
  ...OWN_TRIGGERS.map((n) => `DROP TRIGGER IF EXISTS ${n}`),
  ...DOCUMENTS_FTS_TRIGGERS,
  ...REBUILD_DOCUMENTS_FTS,
]
  .map((s) => `${s.trim()};`)
  .join('\n');

/**
 * v2 -> v3, in one transaction (a savepoint, so it also nests inside `migrate`'s). Safe to run twice: the index is created
 * only when missing, the triggers are dropped and created again, and the title index is rebuilt from the rows. Sets
 * `user_version = 3` only when it is lower, so it can never move a newer database back.
 *
 * Every trigger on `documents` that feeds `documents_fts` is dropped by what it does, not by its name.
 */
export function applySchemaV3(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    const columns = new Set(tx.selectObjects(`SELECT name FROM pragma_table_info('documents')`).map((r) => r.name));
    if (!columns.has('deleted_at') || tx.selectObjects(`SELECT name FROM pragma_table_info('history')`).length === 0) {
      throw new Error('schema v1 is not present; run the earlier steps first');
    }

    tx.exec(HISTORY_LAST_OPENED_INDEX);

    const old = tx
      .selectObjects(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'documents' AND sql LIKE '%documents_fts%'`)
      .map((r) => (typeof r.name === 'string' ? r.name : ''))
      .filter((n) => n.length > 0);
    for (const name of new Set([...old, ...OWN_TRIGGERS])) tx.exec(`DROP TRIGGER IF EXISTS "${name.replaceAll('"', '""')}"`);
    for (const sql of DOCUMENTS_FTS_TRIGGERS) tx.exec(sql);

    for (const sql of REBUILD_DOCUMENTS_FTS) tx.exec(sql);

    if (userVersion(tx) < SCHEMA_V3_VERSION) tx.exec(`PRAGMA user_version = ${SCHEMA_V3_VERSION}`);
  });
}
