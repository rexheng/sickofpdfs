// The readings that left the library for good (R88: Forget and the Trash purge after 30 days, never an Undo of a save), kept as salted
// hashes of their fingerprints. A restore never brings one back, even when the backup folder could not be cleaned (the
// carried restore rulings), and the backup writer uses the list to tell "removed on purpose" from "lost" (writer.ts).
//
// Rules this file keeps:
// - Only salted SHA-256 hashes are kept, never a fingerprint, so a search of the database for a forgotten PDF's fingerprint finds
//   nothing (R13). The salt is random, made once per library, and kept in `local_meta`, as the never-save list keeps `filterSalt`.
// - The hashes are written in the same transaction as the delete, so a reading can never be gone from the library and missing
//   from this list. Hashing is asynchronous, so callers hash first and write inside their transaction; the store's request queue
//   runs one request at a time, so nothing changes in between.
// - The tables are local: they are not dump tables (never in a backup or an export) and have no outbox triggers (never synced).
// - A fingerprint that is in the library again (saved again later, or an alias of a reading) does not count as forgotten.
// - The tables are schema v4 (schema-v4.ts, N5). A database that was never migrated (a Node test's) gets them from the first write
//   that needs them; a read never changes the database.
import type { SqlDb } from './schema-v2';
import { FORGOTTEN_TABLES as TABLES } from './schema-v4';
const SALT_KEY = 'forgottenSalt';
const SHA = /^[0-9a-f]{64}$/;

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

const hasTable = (db: SqlDb, name: string): boolean => db.selectObjects(`SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = ?`, [name]).length > 0;

/** The salt, or null when nothing was ever forgotten here (no table yet). Reads only. */
function readSalt(db: SqlDb): string | null {
  if (!hasTable(db, 'local_meta')) return null;
  const v = db.selectValue('SELECT value FROM local_meta WHERE key = ?', [SALT_KEY]);
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Makes the tables and the salt when they are not there yet. Call it from a write. */
function ensureSalt(db: SqlDb): string {
  for (const sql of TABLES) db.exec(sql);
  const salt = readSalt(db);
  if (salt !== null) return salt;
  const fresh = hex(crypto.getRandomValues(new Uint8Array(16)));
  db.exec({ sql: 'INSERT OR IGNORE INTO local_meta (key, value) VALUES (?, ?)', bind: [SALT_KEY, fresh] });
  return readSalt(db) ?? fresh;
}

async function hashWith(salt: string, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const enc = new TextEncoder();
  for (const id of new Set(ids)) {
    if (!SHA.test(id)) continue;
    out.set(id, hex(await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${id}`))));
  }
  return out;
}

/**
 * The hashes to record for these fingerprints (a document and its aliases), made ready before the delete's transaction. Makes the
 * salt the first time. Fingerprints that are not 64 hex characters are left out.
 */
export async function forgottenHashes(db: SqlDb, ids: readonly string[]): Promise<Map<string, string>> {
  return hashWith(ensureSalt(db), ids);
}

/** Records the hashes. Call it inside the transaction that deletes the readings. */
export function recordForgotten(tx: SqlDb, hashes: Iterable<string>, at: number): void {
  for (const sql of TABLES) tx.exec(sql);
  for (const hash of hashes) tx.exec({ sql: 'INSERT OR REPLACE INTO forgotten (hash, forgotten_at) VALUES (?, ?)', bind: [hash, at] });
}

/** The fingerprints among `ids` that left the library for good and are not in it now (not a document, not an alias). Reads only. */
export async function forgottenAmong(db: SqlDb, ids: readonly string[]): Promise<string[]> {
  const salt = readSalt(db);
  if (salt === null || !hasTable(db, 'forgotten')) return [];
  const hashes = await hashWith(salt, ids);
  if (hashes.size === 0) return [];
  const listed = new Set(
    db
      .selectObjects('SELECT hash FROM forgotten WHERE hash IN (SELECT value FROM json_each(?))', [JSON.stringify([...hashes.values()])])
      .map((r) => (typeof r.hash === 'string' ? r.hash : '')),
  );
  const candidates = [...hashes].filter(([, h]) => listed.has(h)).map(([id]) => id);
  if (candidates.length === 0) return [];
  const here = new Set(
    db
      .selectObjects(
        `SELECT id FROM documents WHERE id IN (SELECT value FROM json_each(?1))
         UNION SELECT sha256 AS id FROM aliases WHERE sha256 IN (SELECT value FROM json_each(?1))`,
        [JSON.stringify(candidates)],
      )
      .map((r) => (typeof r.id === 'string' ? r.id : '')),
  );
  return candidates.filter((id) => !here.has(id)).sort();
}
