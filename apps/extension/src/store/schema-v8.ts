// Store schema v8 (Phase 8, slice 8.4, Nov 7): which annotations of a saved reading's file were already imported as notes.
// Additive only: one new table. Nothing in an existing table or trigger changes.
//
// The ladder: OCR is v7 (`page_ocr`), import is v8 (`pdf_import_refs`), sync is v9 (`sync_state`). Contracts §4 has the ladder.
//
// `pdf_import_refs (document_id, pdf_ref, row_table, row_id, created_at)`: one row per annotation (or part of one) that "Import on
// open" turned into a note. `pdf_ref` is the annotation's /NM, or `obj:<number>` when it has none (core/export/nm.ts `pdfRefOf`),
// plus `<ref>#thread` and `<ref>#root` for the thread and first comment made from a mark. Opening the file again finds its
// annotations here, makes no second note, and hides them so they are drawn once. One special row, `pdf_ref = 'declined'`, is
// written by Undo: that reading's file is then not imported again. LOCAL ONLY: no outbox triggers (never synced), not a backup
// table. It hangs off `documents` with ON DELETE CASCADE, so Forget, the Trash purge and an Undo of a save remove it with the reading.
// A PDF that is not saved never has a row.
//
// Every statement is `IF NOT EXISTS`, and running the step twice changes nothing.
//
// Wiring: `migrate` calls `applySchemaV8` after the v6 block (and after OCR's v7 step, once that is merged).
import { SCHEMA_VERSION, type SqlDb, userVersion } from './schema-v2';

/** The newest schema this file brings a database to. */
export const SCHEMA_V8_VERSION = 8;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS pdf_import_refs (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    pdf_ref TEXT NOT NULL CHECK (length(pdf_ref) BETWEEN 1 AND 600),
    row_table TEXT NOT NULL CHECK (row_table IN ('marks','threads','comments')),
    row_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (document_id, pdf_ref)) WITHOUT ROWID`,
];

/** The whole v8 step as one SQL script, for reading. Run it through `applySchemaV8`, which also sets the version. */
export const SCHEMA_V8 = TABLES.map((s) => `${s.trim().replace(/\s+/g, ' ')};`).join('\n');

/**
 * v7 -> v8 (or v6 -> v8 until OCR's step is merged), in one transaction (a savepoint, so it also nests inside `migrate`'s).
 * Safe to run twice. Sets `user_version = 8` only when it is lower, so it can never move a newer database back; a newer
 * database is refused before anything is touched.
 */
export function applySchemaV8(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    for (const sql of TABLES) tx.exec(sql);
    if (userVersion(tx) < SCHEMA_V8_VERSION) tx.exec(`PRAGMA user_version = ${SCHEMA_V8_VERSION}`);
  });
}
