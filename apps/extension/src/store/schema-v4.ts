// Store schema v4 (Nov 2, ruling N5 of the backup re-check). Additive only: two local tables for the forgotten list (R88,
// forgotten.ts). Nothing in a synced table changes, no trigger changes, no row changes meaning.
//
// What it adds:
// - `forgotten (hash, forgotten_at)`: salted SHA-256 hashes of the fingerprints of readings that left the library for good
//   (Forget, the 30-day Trash purge). Restore leaves them out; the backup writer counts them as removed on purpose.
// - `local_meta (key, value)`: this library's own local values; `forgottenSalt` is the salt of the hashes above.
// Both are local: not dump tables (never in a backup or an export) and without outbox triggers (never synced).
//
// The build before v4 made these two tables lazily, with the same definitions, so a v3 database may already have them: every
// statement is `IF NOT EXISTS`, and running the step twice changes nothing.
//
// Wiring (Task 28's `migrate`): after the v3 block, `if (userVersion(db) < 4) applySchemaV4(db)`.
import { SCHEMA_VERSION, type SqlDb, userVersion } from './schema-v2';

/** The newest schema this file brings a database to. */
export const SCHEMA_V4_VERSION = 4;

/** The two tables, as statements (forgotten.ts uses the same ones for a database that was never migrated, such as a Node test's). */
export const FORGOTTEN_TABLES = [
  'CREATE TABLE IF NOT EXISTS forgotten (hash TEXT PRIMARY KEY, forgotten_at INTEGER NOT NULL) WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS local_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID',
];

/** The whole v4 step as one SQL script (contracts §4), for reading. */
export const SCHEMA_V4 = FORGOTTEN_TABLES.map((s) => `${s};`).join('\n');

/**
 * v3 -> v4, in one transaction (a savepoint, so it also nests inside `migrate`'s). Safe to run twice. Sets `user_version = 4` only when
 * it is lower, so it can never move a newer database back; a newer database is refused before anything is touched.
 */
export function applySchemaV4(db: SqlDb): void {
  if (userVersion(db) > SCHEMA_VERSION) throw new Error('read-only: this database is newer than this version of sickofpdfs');
  db.savepoint((tx) => {
    for (const sql of FORGOTTEN_TABLES) tx.exec(sql);
    if (userVersion(tx) < SCHEMA_V4_VERSION) tx.exec(`PRAGMA user_version = ${SCHEMA_V4_VERSION}`);
  });
}
