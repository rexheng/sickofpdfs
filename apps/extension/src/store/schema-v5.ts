// Store schema v5 (Nov 2, R92: tags and the local auto categoriser). Additive only: four new tables, their indexes and the outbox
// triggers of the three that sync. Nothing in an existing table changes, no existing trigger changes, no row changes meaning.
//
// The ladder moved for this step: sync is v6 (`sync_state`), OCR v7 (`page_ocr`), export v8 (`pdf_import_refs`).
//
// What it adds:
// - `tags (id, name, kind, topic_key, renamed, created_at, updated_at, deleted_at, rev, hlc)`: one row per tag. `kind` says where it
//   came from: 'course' (a course code found in the link, folder or page 1), 'topic' (readings close in meaning), 'tag' (the owner's
//   own word). A live tag's name is unique, ignoring case. A tag the owner deletes keeps its row with `deleted_at` set (a tombstone,
//   like a note), so the categoriser never makes a deleted course or topic tag again and a sync learns of the delete.
// - `reading_tags (id, document_id, tag_id, source, created_at, rev, hlc)`: a tag on a reading. `id` is `<document_id>:<tag_id>`,
//   `source` is 'owner' or 'auto' (the categoriser's, shown as "auto" until the owner keeps it).
// - `auto_tag_removed (id, document_id, tag_id, removed_at, rev, hlc)`: a tag the owner took off a reading. The categoriser never
//   puts it back. Same id form. (It is kept with the other two in backups, so a restore on a new computer does not bring a removed tag back.)
// - `embeddings (document_id, model, dim, vector, text_hash, abstract, pages_used, created_at)`: the categoriser's meaning vector of a reading
//   and the text it was made from (`pages_used`: how many of its first pages had text then, so a reading whose text arrived late is done again). LOCAL ONLY: not a dump table (never in a backup or an export) and without outbox triggers (never synced).
//   It is rebuilt when needed.
//
// The three synced tables have the same outbox triggers as every other synced table (schema.ts `outboxTriggers`). Every table here
// hangs off `documents` with ON DELETE CASCADE, so Forget, the Trash purge and an Undo of a save remove a reading's tags, removals and
// vector in the same transaction as the reading (store-api.ts `forgetDocument`, trash-purge.ts).
//
// Every statement is `IF NOT EXISTS` (the triggers are dropped and made again), and running the step twice changes nothing.
//
// Wiring: `migrate` calls `applySchemaV5` after the v4 block.
import { outboxTriggers } from './schema';
import { SCHEMA_VERSION, type SqlDb, userVersion } from './schema-v2';

/** The newest schema this file brings a database to. */
export const SCHEMA_V5_VERSION = 5;

/**
 * R92c, local only (no outbox triggers, not a dump table): the title of the page a reading was opened from, for the categoriser's course codes
 * (a page titled "EC313 Econometrics - Week 6 reading list"). Hangs off `documents`, so Forget and the Trash purge remove it with the reading.
 * `embeddings.rules` says which course rules a reading was last tagged by, so a new rule set is applied to readings already in the library.
 * Run on every open (idempotent), so a library already at v5 gets them too.
 */
export function ensureCategoriserLocals(db: SqlDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS source_pages (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) <= 300), seen_at INTEGER NOT NULL)`);
  const cols = db.selectObjects(`PRAGMA table_info(embeddings)`);
  if (!cols.some((c) => c.name === 'rules')) db.exec(`ALTER TABLE embeddings ADD COLUMN rules INTEGER NOT NULL DEFAULT 0`);
}

/** The tag tables that sync, with their key. `embeddings` is not among them. */
export const TAG_TABLES = ['tags', 'reading_tags', 'auto_tag_removed'] as const;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    kind TEXT NOT NULL CHECK (kind IN ('topic','course','tag')),
    topic_key TEXT,
    renamed INTEGER NOT NULL DEFAULT 0 CHECK (renamed IN (0,1)),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tags_live_name ON tags(name COLLATE NOCASE) WHERE deleted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS reading_tags (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('owner','auto')),
    created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
    UNIQUE (document_id, tag_id),
    CHECK (id = document_id || ':' || tag_id))`,
  `CREATE INDEX IF NOT EXISTS reading_tags_tag ON reading_tags(tag_id)`,
  `CREATE TABLE IF NOT EXISTS auto_tag_removed (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    removed_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
    UNIQUE (document_id, tag_id),
    CHECK (id = document_id || ':' || tag_id))`,
  `CREATE INDEX IF NOT EXISTS auto_tag_removed_tag ON auto_tag_removed(tag_id)`,
  `CREATE TABLE IF NOT EXISTS embeddings (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    model TEXT NOT NULL, dim INTEGER NOT NULL CHECK (dim > 0),
    vector BLOB NOT NULL CHECK (length(vector) = dim * 4),
    text_hash TEXT NOT NULL, abstract TEXT NOT NULL DEFAULT '', pages_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
];

const TRIGGER_NAMES = TAG_TABLES.flatMap((t) => ['ai', 'au', 'ad'].map((k) => `${t}_outbox_${k}`));
const TRIGGERS = TAG_TABLES.flatMap((t) => outboxTriggers(t, 'id'));

/** The whole v5 step as one SQL script, for reading. Run it through `applySchemaV5`, which also sets the version. */
export const SCHEMA_V5 = [...TABLES, ...TRIGGER_NAMES.map((n) => `DROP TRIGGER IF EXISTS ${n}`), ...TRIGGERS].map((s) => `${s.trim().replace(/\s+/g, ' ')};`).join('\n');

/**
 * v4 -> v5, in one transaction (a savepoint, so it also nests inside `migrate`'s). Safe to run twice. Sets `user_version = 5` only
 * when it is lower, so it can never move a newer database back; a newer database is refused before anything is touched.
 */
export function applySchemaV5(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    for (const sql of TABLES) tx.exec(sql);
    for (const name of TRIGGER_NAMES) tx.exec(`DROP TRIGGER IF EXISTS ${name}`);
    for (const sql of TRIGGERS) tx.exec(sql);
    if (userVersion(tx) < SCHEMA_V5_VERSION) tx.exec(`PRAGMA user_version = ${SCHEMA_V5_VERSION}`);
  });
}
