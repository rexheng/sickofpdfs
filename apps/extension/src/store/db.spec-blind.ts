// Test support only (spec-blind tests for the store). Plain SQLite helpers over @sqlite.org/sqlite-wasm in Node,
// written without any of the code under test. The probes read the database directly, so they check what is really
// on disk (tables, triggers, FTS shadow tables), not what the store API says.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
export type Db = InstanceType<Sqlite3['oo1']['DB']>;
export type Row = Record<string, unknown>;

let sqlite: Promise<Sqlite3> | undefined;
export const sqlite3 = (): Promise<Sqlite3> => (sqlite ??= sqlite3InitModule());

export async function openMemoryDb(): Promise<Db> {
  const s = await sqlite3();
  return new s.oo1.DB(':memory:', 'c');
}

/** All rows of a query as objects. */
export function all(db: Db, sql: string, bind?: unknown[]): Row[] {
  return db.exec({ sql, bind: bind as never, rowMode: 'object', returnValue: 'resultRows' });
}

export function value(db: Db, sql: string, bind?: unknown[]): unknown {
  return db.selectValue(sql, bind as never);
}

export const userVersion = (db: Db): number => value(db, 'PRAGMA user_version') as number;

export const tableNames = (db: Db): string[] =>
  all(db, "SELECT name FROM sqlite_schema WHERE type IN ('table') ORDER BY name").map((r) => r.name as string);

export const columnNames = (db: Db, table: string): string[] => all(db, `PRAGMA table_info(${table})`).map((r) => r.name as string);

/** Trigger names, optionally for one table. */
export const triggerNames = (db: Db, table?: string): string[] =>
  all(db, `SELECT name FROM sqlite_schema WHERE type = 'trigger' ${table ? 'AND tbl_name = ?' : ''} ORDER BY name`, table ? [table] : undefined).map(
    (r) => r.name as string,
  );

export const count = (db: Db, table: string, where = '1'): number => value(db, `SELECT count(*) FROM ${table} WHERE ${where}`) as number;

/** The queued sync entries, oldest first. */
export const outboxRows = (db: Db): { table: string; id: string; op: string; baseRev: number }[] =>
  all(db, 'SELECT table_name, row_id, op, base_rev FROM outbox ORDER BY seq').map((r) => ({
    table: r.table_name as string,
    id: r.row_id as string,
    op: r.op as string,
    baseRev: r.base_rev as number,
  }));

/** ids of the comments whose body matches one plain word in comments_fts. */
export const ftsHits = (db: Db, word: string): string[] =>
  all(db, 'SELECT comment_id FROM comments_fts WHERE comments_fts MATCH ?', [`"${word}"`]).map((r) => r.comment_id as string);

/** Every row of every table (FTS shadow tables included) with a column that contains `needle`. Returns [table, row index][]. */
export function rowsMentioning(db: Db, needle: string): [string, number][] {
  const found: [string, number][] = [];
  const latin1 = new TextDecoder('latin1');
  for (const table of tableNames(db)) {
    all(db, `SELECT * FROM "${table}"`).forEach((r, i) => {
      const hit = Object.values(r).some((v) => {
        if (v instanceof Uint8Array) return latin1.decode(v).includes(needle);
        return typeof v === 'string' || typeof v === 'number' ? String(v).includes(needle) : false;
      });
      if (hit) found.push([table, i]);
    });
  }
  return found;
}

/** One stable text for the whole schema, to compare before and after something that must not change it. */
export const schemaText = (db: Db): string =>
  all(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .map((r) => [r.type, r.name, r.tbl_name, r.sql].map((x) => (typeof x === 'string' ? x : '')).join('|'))
    .join('\n');

/** The content of the given tables, sorted, for before/after comparisons. `cols` limits the columns compared. */
export function dump(db: Db, table: string, cols?: string[]): Row[] {
  const list = (cols ?? columnNames(db, table)).map((c) => `"${c}"`).join(', ');
  return all(db, `SELECT ${list} FROM "${table}" ORDER BY 1, 2`);
}

/** Closes nothing: copies the committed bytes of `db` into a new in-memory database. Same as a worker restart: only what was committed survives. */
export async function reopen(db: Db): Promise<Db> {
  const s = await sqlite3();
  const bytes = s.capi.sqlite3_js_db_export(db.pointer as never);
  const copy = new s.oo1.DB(':memory:', 'c');
  const ptr = s.wasm.allocFromTypedArray(bytes);
  copy.checkRc(s.capi.sqlite3_deserialize(copy.pointer as never, 'main', ptr, bytes.length, bytes.length, s.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s.capi.SQLITE_DESERIALIZE_RESIZEABLE));
  return copy;
}
