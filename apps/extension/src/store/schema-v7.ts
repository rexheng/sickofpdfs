// Store schema v7 (Phase 7, Nov 7): the recognised text of scanned pages. Additive only: one new table. Nothing in an existing
// table or trigger changes.
//
// The ladder moved for this step (Release 2's sync was never built, so the next free step is OCR's): OCR is v7 (`page_ocr`),
// export v8 (`pdf_import_refs`), sync v9 (`sync_state`). Contracts §4 has the ladder.
//
// `page_ocr (document_id, page_index, engine, engine_version, langs, words, created_at)`: one row per recognised page of a SAVED
// reading, with the engine's name and version (contracts §9). `words` is the JSON OcrWord[] in reading order; the page's chars
// are rebuilt from it (ocrText), so a char index means the same thing on every computer. The page's text also goes into
// `page_text` with source 'ocr:<engine>@<version>' in the same transaction (store/page-ocr.ts), so search, the library and
// Claude read it as page text. LOCAL ONLY: no outbox triggers (never synced; the cloud gets the text through page text). It
// hangs off `documents` with ON DELETE CASCADE, so Forget, the Trash purge and an Undo of a save remove it with the reading.
// A PDF that is not saved never has a row: its recognised text stays in the tab's memory.
//
// Every statement is `IF NOT EXISTS`, and running the step twice changes nothing.
//
// Wiring: `migrate` calls `applySchemaV7` after the v6 block.
import { SCHEMA_VERSION, type SqlDb, userVersion } from './schema-v2';

/** The newest schema this file brings a database to. */
export const SCHEMA_V7_VERSION = 7;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS page_ocr (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL CHECK (page_index >= 0),
    engine TEXT NOT NULL CHECK (length(engine) BETWEEN 1 AND 64),
    engine_version TEXT NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 64),
    langs TEXT NOT NULL DEFAULT '[]',
    words TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (document_id, page_index)) WITHOUT ROWID`,
];

/** The whole v7 step as one SQL script, for reading. Run it through `applySchemaV7`, which also sets the version. */
export const SCHEMA_V7 = TABLES.map((s) => `${s.trim().replace(/\s+/g, ' ')};`).join('\n');

/**
 * v6 -> v7, in one transaction (a savepoint, so it also nests inside `migrate`'s). Safe to run twice. Sets `user_version = 7` only
 * when it is lower, so it can never move a newer database back; a newer database is refused before anything is touched.
 */
export function applySchemaV7(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    for (const sql of TABLES) tx.exec(sql);
    if (userVersion(tx) < SCHEMA_V7_VERSION) tx.exec(`PRAGMA user_version = ${SCHEMA_V7_VERSION}`);
  });
}
