// Opens the library schema: connection settings first, then each schema step in order, each in one transaction.
import type { Sqlite3Database } from './store-api';
import { SCHEMA_V1, triggersV1 } from './schema';
import { applySchemaV2, guardNewerSchema, refreshCommentsFtsTrigger, userVersion } from './schema-v2';
import { applySchemaV3 } from './schema-v3';
import { applySchemaV4 } from './schema-v4';
import { applySchemaV5 } from './schema-v5';

/**
 * The connection settings, set on every open. Deleted rows are overwritten in the file (secure_delete), and the journal
 * is cut to nothing after each commit rather than left behind in a free OPFS slot (TRUNCATE), so a forgotten PDF leaves
 * no bytes behind (ruling R13). FULL sync makes every commit durable before it is reported.
 */
const CONNECTION_PRAGMAS = ['PRAGMA foreign_keys = ON', 'PRAGMA journal_mode = TRUNCATE', 'PRAGMA synchronous = FULL', 'PRAGMA secure_delete = ON'];

/**
 * Brings the database up to the newest schema this code knows and returns its `user_version` (5 now). Safe to run on
 * every open: a step runs only when the version is below it. A database written by a newer version is opened read-only
 * and left exactly as it is; its version is returned, and every write is refused ("Update sickofpdfs").
 */
export function migrate(db: Sqlite3Database): number {
  const newer = guardNewerSchema(db);
  if (newer.readOnly) return newer.version;

  for (const pragma of CONNECTION_PRAGMAS) db.exec(pragma);

  if (userVersion(db) === 0) {
    db.transaction(() => {
      db.exec(SCHEMA_V1);
      for (const sql of triggersV1()) db.exec(sql);
      db.exec('PRAGMA user_version = 1');
    });
  }
  if (userVersion(db) < 2) applySchemaV2(db);
  if (userVersion(db) < 3) applySchemaV3(db);
  if (userVersion(db) < 4) applySchemaV4(db);
  if (userVersion(db) < 5) applySchemaV5(db);
  // R67: drafts never touch comments_fts. Idempotent and a no-op when the trigger is current; repairs databases made before the fix.
  if (userVersion(db) >= 2) refreshCommentsFtsTrigger(db);
  return userVersion(db);
}
