// Store schema v6 (Phase 4 slice D, Nov 6): the paragraph vectors @Claude's passage search keeps for saved readings. Additive only:
// one new table. Nothing in an existing table or trigger changes.
//
// The ladder moved for this step: sync is v7 (`sync_state`), OCR v8 (`page_ocr`), export v9 (`pdf_import_refs`).
//
// `passage_vectors (document_id, text_hash, model, dim, vector, created_at)`: the meaning vector (bundled MiniLM) of one three-sentence
// window of a reading's text, so a second question on the same reading does not have to make them again. The text is NOT kept: the
// key is the SHA-256 of the window's text, which the viewer works out. LOCAL ONLY: no outbox triggers (never synced), not a dump table
// (never in a backup or an export). It hangs off `documents` with ON DELETE CASCADE, so Forget, the Trash purge and an Undo of a save
// remove a reading's vectors in the same transaction as the reading. It is rebuilt when needed.
//
// Every statement is `IF NOT EXISTS`, and running the step twice changes nothing.
//
// Wiring: `migrate` calls `applySchemaV6` after the v5 block.
import { SCHEMA_VERSION, type SqlDb, userVersion } from './schema-v2';

/** The newest schema this file brings a database to. */
export const SCHEMA_V6_VERSION = 6;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS passage_vectors (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    text_hash TEXT NOT NULL CHECK (length(text_hash) = 64),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 64),
    dim INTEGER NOT NULL CHECK (dim > 0),
    vector BLOB NOT NULL CHECK (length(vector) = dim * 4),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (document_id, text_hash)) WITHOUT ROWID`,
];

/** The whole v6 step as one SQL script, for reading. Run it through `applySchemaV6`, which also sets the version. */
export const SCHEMA_V6 = TABLES.map((s) => `${s.trim().replace(/\s+/g, ' ')};`).join('\n');

/**
 * v5 -> v6, in one transaction (a savepoint, so it also nests inside `migrate`'s). Safe to run twice. Sets `user_version = 6` only
 * when it is lower, so it can never move a newer database back; a newer database is refused before anything is touched.
 */
export function applySchemaV6(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    for (const sql of TABLES) tx.exec(sql);
    if (userVersion(tx) < SCHEMA_V6_VERSION) tx.exec(`PRAGMA user_version = ${SCHEMA_V6_VERSION}`);
  });
}
