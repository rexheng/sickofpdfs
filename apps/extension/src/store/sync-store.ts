// CL9: the sync side of the local library (contracts §7, CA4, CA5). It turns the outbox into push entries, takes the server's
// answer back, and writes pulled rows, without echoing a pulled row back, dropping a queued edit or overwriting a note.
//
// Wiring: `StoreApi extends SyncStoreApi`; `createStoreApi` spreads `createSyncStoreApi(db, deps, { forget })`; `protocol.ts`
// serves `SYNC_STORE_METHODS`. The Android app's store worker builds the same `createStoreApi`, so it gets all of this unchanged.
//
// What never leaves this computer (each checked here at collect time, and again by the server):
// - a draft (comments and threads with `draft_of_tab`: the outbox triggers never queue them, and `normalizeWireRow` refuses one);
// - a reading the owner saved although the filter judged it not learning (CD1), a reading saved without searchable text (D9: it
//   held a card, bank or ID number), and one marked "never sync" (`neverSync:<id>`), with every row that hangs off them and every
//   setting whose key names them. Their queued changes are held, not dropped: they leave if the owner later lets them;
// - a setting whose key says secret (secrets live in `sop-local`, which this worker cannot reach, R14);
// - a PDF that was not saved: it has no row here at all. The R105b "Send" memory lives in `sop-local` too.
// File locations leave as file names (`normalizeWireRow`), and the learning filter's lists leave with web entries only.
//
// Deletes that sync (CL11): a row of a table without soft deletes (a reading's tags, auto-tag removals, settings, locations,
// aliases) that this computer deleted, and that the server held (`rev > 0`), leaves as `removed: true`, stamped at the time of the
// delete. A pulled `removed: true` deletes the row here too, unless this computer has a newer queued change for it.
//
// Rules for what comes in:
// - A pulled row is skipped while this computer has a queued change for it: the server decides at the next push.
// - Pulled rows and acks are written with the `applying` flag set (schema-v9.ts), so they never queue a push.
// - A pulled row never takes a local-only value: `blob_stored` stays this computer's, and a file location keeps its full path.
// - A row whose document, thread or tag is not here yet waits in `sync_parked`; a reading forgotten here is never brought back.
// - A pulled tag whose name a live local tag already has is folded into one: the smaller id wins on every computer.
// - Duplicates (R59): when a fingerprint is both a reading here and an alias of another reading, the larger id's notes move to the
//   smaller id (`planReparent`), and the emptied reading goes to Trash once (carried CL9 decision: Trash, not hidden: it can be
//   seen and restored for 30 days, it syncs like any Trash, and the cloud's 30-day purge removes it). Opening its file finds the
//   reading it now belongs to (`resolveFingerprint`).
import type { DocumentId, Hlc } from '@sop/core';
import {
  canonicalJson,
  type ChangeEntry,
  dbToWire,
  type DbRow,
  groupQueue,
  isSyncableSetting,
  mergePulledLocation,
  normalizeWireRow,
  parentsOf,
  pickWinner,
  planReparent,
  type PullResponse,
  type PushResponse,
  type QueuedChange,
  SYNC_APPLY_ORDER,
  SYNCED_TABLES,
  type SyncedTable,
  TABLE_SPECS,
  tombstoneOf,
  documentIdsInKey,
  documentOfRemovable,
  formatHlc,
  parseHlc,
  removalRow,
  REMOVABLE_TABLES,
  type WireRow,
  wireToDb,
} from '@sop/core/sync';
import type { AckResult, ApplyResult, PushBatch, SentMark } from '@sop/core/sync-client';
import type { StoreChange } from './change-bus';
import { backdateForgotten, forgottenSince, hashesOf } from './forgotten';
import { SAVED_THOUGH_NOT_LEARNING } from './reading-flags';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';
import { APPLYING_KEY, LOCAL_SYNCED_TABLES } from './schema-v9';

export type { AckResult, ApplyResult, PushBatch, SentMark } from '@sop/core/sync-client';

/** A document waiting for its page text to be sent, with the source it would be sent as. */
export interface PendingText {
  documentId: DocumentId;
  /** The text's sources, as one word: CL11 stores it in `textSent:<id>` once the text is up. */
  source: string;
}

export interface SyncStoreApi {
  /** Up to `limit` push entries, one per queued row, parents first. Cleans the queue of what can never leave as it goes. */
  collectPush(limit: number): Promise<PushBatch>;
  /** The server's answer to a push of `sent` (from `collectPush`). */
  ackPush(result: PushResponse, sent: readonly SentMark[]): Promise<AckResult>;
  /** One pull page, and the cursor to keep after it, in one transaction. */
  applyPulled(entries: PullResponse['entries'], cursor: number): Promise<ApplyResult>;
  getSyncState(key: string): Promise<string | null>;
  /** null removes the key. `applying` is not a key anyone may set. */
  setSyncState(key: string, value: string | null): Promise<void>;
  /** Queued rows that will leave, plus PDFs and text still waiting: "N not yet synced". */
  unsyncedCount(): Promise<number>;
  /** Readings whose PDF the server asked for and that may be uploaded (the switch is on, not "keep local", the file is here). */
  pendingBlobs(): Promise<DocumentId[]>;
  /** Readings whose page text the server does not have in its current form. Never a password-protected one (CD2) or D9. */
  pendingText(): Promise<PendingText[]>;
  /** A pulled `{ forgotten: true }` row: Forget this reading here too. */
  forgetLocally(id: DocumentId): Promise<void>;
  /**
   * Restore (CL11): readings the cloud holds that lack their PDF or their page text here, most recently opened first. A reading in
   * Trash or private is never in the list, and a "keep local" one never asks for its PDF.
   */
  pendingRestore(): Promise<RestoreWant[]>;
  /** The page text of a reading as the cloud should hold it: one extractor and every page, or null when none may leave. */
  textForSync(id: DocumentId): Promise<SyncText | null>;
  /**
   * Pages of text pulled from the cloud (a restore). A page that has text here already keeps it. With `complete`, the text the
   * cloud holds is remembered as sent (`textSent:<id>`), so it is not uploaded back.
   */
  putSyncedText(id: DocumentId, extractor: string, pages: readonly { pageIndex: number; text: string }[], complete: boolean): Promise<void>;
}

/** A reading a restore should fill in: its PDF (with the size the cloud expects), its page text, or both. */
export interface RestoreWant {
  documentId: DocumentId;
  byteSize: number;
  blob: boolean;
  text: boolean;
}

/** Page text for the cloud (`PUT /api/text/:sha`). */
export interface SyncText {
  extractor: string;
  /** The source word `pendingText` gave, to keep in `textSent:<id>` once the cloud has it all. */
  source: string;
  pages: { pageIndex: number; text: string }[];
}

export const SYNC_STORE_METHODS = ['collectPush', 'ackPush', 'applyPulled', 'getSyncState', 'setSyncState', 'unsyncedCount', 'pendingBlobs', 'pendingText', 'forgetLocally', 'pendingRestore', 'textForSync', 'putSyncedText'] as const satisfies readonly (keyof SyncStoreApi)[];
export const SYNC_STORE_READ_METHODS = ['getSyncState', 'unsyncedCount', 'pendingBlobs', 'pendingText', 'pendingRestore', 'textForSync'] as const satisfies readonly (keyof SyncStoreApi)[];

export interface SyncStoreDeps {
  now(): number;
  hlc: Hlc;
  publish(c: StoreChange): void;
}

export interface SyncStoreHooks {
  /** The store's own Forget (not an Undo): rows, outbox, indexes, the PDF and its thumbnail. */
  forget(id: DocumentId): Promise<void>;
}

type Row = Record<string, SqlValue>;

/** A push stays under the server's 4 MiB body limit with room to spare. */
const MAX_PUSH_BYTES = 3_500_000;
const HEX64 = /^[0-9a-f]{64}$/;
const STATE_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,40}(?::[A-Za-z0-9._-]{1,128})?$/;
const MAX_STATE_VALUE = 16_384;
/** A parked row older than this is dropped: its parent is never coming (a purge, a Forget the pull will not repeat). */
const PARK_DAYS = 90;

class SyncStoreError extends Error {
  constructor(code: 'bad-input' | 'read-only', message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
  }
}

function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');
const int = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

/** SQL over `documents` as `d`: a reading whose rows never leave this computer. */
const PRIVATE_DOC = `(d.index_text = 0 OR d.save_reasons LIKE '%"${SAVED_THOUGH_NOT_LEARNING}"%' OR EXISTS (SELECT 1 FROM sync_state s WHERE s.key = 'neverSync:' || d.id))`;

const RANK_SQL = `CASE g.table_name ${SYNC_APPLY_ORDER.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ')} ELSE 99 END`;

/** The document a queued row of `table` names, as SQL over the outbox group `g` (null when it names none). */
function documentOfGroupSql(table: SyncedTable): string {
  switch (table) {
    case 'documents':
    case 'history':
      return 'g.row_id';
    case 'reading_tags':
    case 'auto_tag_removed':
      return 'substr(g.row_id, 1, 64)';
    case 'aliases':
      return '(SELECT document_id FROM aliases WHERE sha256 = g.row_id)';
    case 'settings':
      return `(CASE WHEN g.row_id LIKE 'course.of.%' THEN substr(g.row_id, 11) WHEN g.row_id LIKE 'pageOrder.of.%' THEN substr(g.row_id, 14) END)`;
    case 'tags':
      return 'NULL';
    default:
      return `(SELECT document_id FROM ${table} WHERE id = g.row_id)`;
  }
}

export function createSyncStoreApi(db: SqlDb, deps: SyncStoreDeps, hooks: SyncStoreHooks): SyncStoreApi {
  const select = (sql: string, bind: SqlValue[] = []): Row[] => db.selectObjects(sql, bind.length > 0 ? bind : undefined);
  const one = (sql: string, bind: SqlValue[] = []): Row | undefined => select(sql, bind)[0];
  const run = (sql: string, bind: SqlValue[] = []): void => {
    db.exec({ sql, bind });
  };
  const assertWritable = (): void => {
    if (isReadOnly(db)) throw new SyncStoreError('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
  };
  const state = (key: string): string | null => {
    const r = one('SELECT value FROM sync_state WHERE key = ?', [key]);
    return r === undefined ? null : str(r.value);
  };
  const putState = (key: string, value: string | null): void => {
    if (value === null) run('DELETE FROM sync_state WHERE key = ?', [key]);
    else run('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value]);
  };
  const setApplying = (on: boolean): void => putState(APPLYING_KEY, on ? '1' : null);
  /** Runs `f` in one transaction with the outbox triggers quiet. */
  const applying = <T>(f: () => T): T =>
    db.savepoint(() => {
      setApplying(true);
      try {
        return f();
      } finally {
        setApplying(false);
      }
    });

  const pk = (table: SyncedTable) => LOCAL_SYNCED_TABLES[table];
  const readRow = (table: SyncedTable, id: string): Row | undefined => one(`SELECT * FROM ${table} WHERE ${pk(table)} = ?`, [id]);
  const exists = (table: SyncedTable, id: string): boolean => one(`SELECT 1 AS x FROM ${table} WHERE ${pk(table)} = ?`, [id]) !== undefined;
  /** null: no such reading here. */
  const isPrivate = (documentId: string): boolean | null => {
    const r = one(`SELECT ${PRIVATE_DOC} AS p FROM documents d WHERE d.id = ?`, [documentId]);
    return r === undefined ? null : int(r.p) === 1;
  };
  const dropQueued = (table: SyncedTable, id: string, upTo: number): void => run('DELETE FROM outbox WHERE table_name = ? AND row_id = ? AND seq <= ?', [table, id, upTo]);
  const hasQueued = (table: SyncedTable, id: string, after = 0): boolean => one('SELECT 1 AS x FROM outbox WHERE table_name = ? AND row_id = ? AND seq > ?', [table, id, after]) !== undefined;

  // ---- changes to announce once the transaction commits ----
  const pending = new Map<string, StoreChange>();
  const announce = (table: SyncedTable, id: string, documentId: string | null, op: 'upsert' | 'delete' = 'upsert'): void => {
    const key = `${table}\u0000${documentId ?? ''}\u0000${op}`;
    const c = pending.get(key) ?? { table, ids: [], op, origin: 'sync' as const, ...(documentId !== null ? { documentId: documentId as DocumentId } : {}) };
    if (!c.ids.includes(id)) c.ids.push(id);
    pending.set(key, c);
  };
  const flush = (): void => {
    const all = [...pending.values()];
    pending.clear();
    for (const c of all) {
      try {
        deps.publish(c);
      } catch {
        // committed; other tabs catch up on their next read
      }
    }
  };

  /**
   * Writes a pulled (or rebased) row as the server holds it, at its revision and stamp. Local-only values stay: a reading's
   * `blob_stored`, a file location's full path.
   */
  function writeRow(table: SyncedTable, wire: WireRow, meta: { rev: number; hlc: string }): void {
    let row = wire;
    if (table === 'locations') {
      const cur = readRow('locations', str(wire.id));
      row = mergePulledLocation(cur ? dbToWire('locations', cur as DbRow).row : null, wire);
    }
    const data = wireToDb(table, row, meta);
    const cols = Object.keys(data);
    const names = table === 'documents' ? [...cols, 'blob_stored'] : cols;
    const values = [...cols.map((c) => data[c] as SqlValue), ...(table === 'documents' ? [0] : [])];
    const update = cols.filter((c) => c !== pk(table)).map((c) => `${c} = excluded.${c}`);
    run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT (${pk(table)}) DO UPDATE SET ${update.join(', ')}`, values);
    deps.hlc.receive(meta.hlc);
    const spec = TABLE_SPECS[table];
    const doc = table === 'documents' ? str(wire.id) : spec.documentField !== null ? str(wire[spec.documentField]) : null;
    announce(table, str(wire[spec.idField]), doc);
  }

  // ─── Push ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  function queuedRows(): ReturnType<typeof groupQueue> {
    const rows = select(
      `SELECT g.table_name AS table_name, g.row_id AS row_id, g.smin AS smin, g.smax AS smax, o.base_rev AS base_rev, o.hlc AS hlc,
              (SELECT x.row_json FROM outbox x WHERE x.table_name = g.table_name AND x.row_id = g.row_id AND x.row_json IS NOT NULL ORDER BY x.seq DESC LIMIT 1) AS row_json
       FROM (SELECT table_name, row_id, min(seq) AS smin, max(seq) AS smax FROM outbox GROUP BY table_name, row_id) g
       JOIN outbox o ON o.seq = g.smin
       ORDER BY ${RANK_SQL}, g.smin`,
    );
    // Folded already by SQL; groupQueue keeps the shared order rules (and turns the rows into QueuedRow).
    const changes: QueuedChange[] = [];
    for (const r of rows) {
      const table = str(r.table_name) as SyncedTable;
      if (!(SYNCED_TABLES as readonly string[]).includes(table)) continue;
      const rowJson = r.row_json === null ? null : str(r.row_json);
      changes.push({ seq: int(r.smin), table, rowId: str(r.row_id), op: 'upsert', baseRev: int(r.base_rev), hlc: str(r.hlc), rowJson });
      if (int(r.smax) !== int(r.smin)) changes.push({ seq: int(r.smax), table, rowId: str(r.row_id), op: 'upsert', baseRev: int(r.base_rev), hlc: str(r.hlc), rowJson });
    }
    return groupQueue(changes);
  }

  type Verdict = { kind: 'send'; entry: ChangeEntry } | { kind: 'drop'; why: string } | { kind: 'hold' };

  /** What to do with one queued row now. */
  function judge(table: SyncedTable, id: string, baseRev: number, rowJson: string | null): Verdict {
    const spec = TABLE_SPECS[table];
    const row = readRow(table, id);
    let wire: WireRow;
    let hlc: string;
    if (row === undefined && REMOVABLE_TABLES.has(table)) {
      // Deleted outright (CL11). A row the server never held needs nothing sent.
      if (baseRev === 0) return { kind: 'drop', why: 'never-sent' };
      for (const doc of [...documentIdsInKey(table === 'settings' ? id : ''), documentOfRemovable(table, id, null)]) if (doc !== null && isPrivate(doc) === true) return { kind: 'hold' };
      if (table === 'settings' && !isSyncableSetting(id)) return { kind: 'drop', why: 'secret' };
      return { kind: 'send', entry: { table, id, baseRev, hlc: removalStamp(table, id), row: removalRow(table, id), removed: true } };
    }
    if (row === undefined) {
      // A hard delete. The wire has no "deleted" for tables without soft deletes, and a row never pushed needs no tombstone.
      const tomb = baseRev > 0 ? tombstoneOf(table, rowJson, deps.now()) : null;
      if (tomb === null) return { kind: 'drop', why: 'gone' };
      wire = tomb;
      hlc = deps.hlc.tick();
    } else {
      const w = dbToWire(table, row as DbRow);
      wire = w.row;
      hlc = w.hlc;
      if ((table === 'threads' || table === 'comments') && row.draft_of_tab !== null && row.draft_of_tab !== undefined) return { kind: 'drop', why: 'draft' };
      // A note created and deleted before it was ever sent is not sent at all (contracts §7). A reading in Trash still goes
      // (Trash can be restored on any computer), and so does a deleted thread that still holds a live comment.
      if (spec.softDelete && table !== 'documents' && wire.deletedAt !== null && wire.deletedAt !== undefined && int(row.rev) === 0) {
        const liveChild = table === 'threads' && one('SELECT 1 AS x FROM comments WHERE thread_id = ? AND deleted_at IS NULL AND draft_of_tab IS NULL', [id]) !== undefined;
        if (!liveChild) return { kind: 'drop', why: 'never-sent' };
      }
    }

    // What may leave at all
    if (table === 'settings') {
      if (!isSyncableSetting(id)) return { kind: 'drop', why: 'secret' };
      for (const doc of documentIdsInKey(id)) {
        const p = isPrivate(doc);
        if (p === true) return { kind: 'hold' };
        // about a reading that is not here (forgotten): the cloud refuses it, so it would wait for ever (CL11)
        if (p === null) return { kind: 'drop', why: 'no-document' };
      }
    }
    const documentId = table === 'documents' ? id : spec.documentField !== null ? str(wire[spec.documentField]) : null;
    if (documentId !== null) {
      const p = isPrivate(documentId);
      if (p === null) return { kind: 'drop', why: 'no-document' }; // its reading is gone (Forget clears the queue too)
      if (p) return { kind: 'hold' };
    }

    const norm = normalizeWireRow(table, wire);
    if (!norm.ok) return { kind: 'drop', why: norm.code };
    return { kind: 'send', entry: { table, id, baseRev, hlc, row: norm.row, ...(table === 'documents' ? { label: 'learning' as const } : {}) } };
  }

  /**
   * The stamp of a delete: when it happened (the outbox keeps the time), later than the version it deleted, on this computer's clock.
   * Stamped at the delete and not at the push, so a delete made offline does not beat a change made elsewhere in between.
   */
  function removalStamp(table: SyncedTable, id: string): string {
    const mine = parseHlc(deps.hlc.tick());
    const del = one(`SELECT created_at AS at, hlc FROM outbox WHERE table_name = ? AND row_id = ? AND op = 'delete' ORDER BY seq DESC LIMIT 1`, [table, id]);
    const old = parseHlc(str(del?.hlc));
    const at = int(del?.at) || deps.now();
    if (mine === null) return deps.hlc.tick();
    if (old !== null && old.ms >= at) return formatHlc({ ms: old.ms, counter: old.counter + 1, device: mine.device });
    return formatHlc({ ms: Math.min(at, mine.ms), counter: 0, device: mine.device });
  }

  /** Deletes a row here because the cloud deleted it. Runs inside `applying`, so nothing queues. */
  function removeHere(table: SyncedTable, id: string): boolean {
    const cur = readRow(table, id);
    run('DELETE FROM sync_parked WHERE table_name = ? AND row_id = ?', [table, id]);
    if (cur === undefined) return false;
    const field = TABLE_SPECS[table].documentField;
    const doc = field !== null ? str(cur[snake(field)]) : documentOfRemovable(table, id, null);
    run(`DELETE FROM ${table} WHERE ${pk(table)} = ?`, [id]);
    announce(table, id, doc === '' ? null : doc, 'delete');
    return true;
  }

  // ─── Pull ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  type Pulled = PullResponse['entries'][number];

  /** The tag a pulled reading's tag names here, after a fold. */
  const foldedTag = (tagId: string): string => state(`tagFold:${tagId}`) ?? tagId;

  /**
   * A live pulled tag whose name a live local tag already has (two computers made the same tag). The smaller id wins on every
   * computer, so they agree without talking: the loser is kept as a deleted tag, and its readings move to the winner.
   */
  function foldTag(e: { rev: number; hlc: string }, row: WireRow, other: string): void {
    const pulledId = str(row.id);
    const now = deps.now();
    if (pulledId < other) {
      // The pulled tag wins: retire ours (this queues: the cloud must hear it), then write the pulled one.
      setApplying(false);
      run('UPDATE tags SET deleted_at = ?, updated_at = ?, hlc = ? WHERE id = ?', [now, now, deps.hlc.tick(), other]);
      setApplying(true);
      writeRow('tags', row, { rev: e.rev, hlc: e.hlc });
      putState(`tagFold:${other}`, pulledId);
      setApplying(false);
      moveTagRows(other, pulledId);
      setApplying(true);
      announce('tags', other, null);
    } else {
      // Ours wins: keep the pulled one as a deleted tag, and send that. It is written quietly at the pulled revision first, then
      // touched with the triggers live, so the queued change is based on that revision and the cloud takes the delete at once
      // (a delete based on an older revision would lose to the live row: an edit beats a delete).
      const data = wireToDb('tags', { ...row, deletedAt: now, updatedAt: now }, { rev: e.rev, hlc: e.hlc });
      const cols = Object.keys(data);
      run(`INSERT INTO tags (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`, cols.map((c) => data[c] as SqlValue));
      deps.hlc.receive(e.hlc);
      setApplying(false);
      run('UPDATE tags SET hlc = ? WHERE id = ?', [deps.hlc.tick(), pulledId]);
      setApplying(true);
      putState(`tagFold:${pulledId}`, other);
      announce('tags', pulledId, null);
    }
  }

  /** A retired tag's readings and removals go to the tag that stays (they queue: this is a local edit). */
  function moveTagRows(from: string, to: string): void {
    const now = deps.now();
    for (const r of select('SELECT document_id, source, created_at FROM reading_tags WHERE tag_id = ?', [from])) {
      const doc = str(r.document_id);
      if (one('SELECT 1 AS x FROM auto_tag_removed WHERE id = ?', [`${doc}:${to}`]) === undefined || str(r.source) === 'owner') {
        run('INSERT OR IGNORE INTO reading_tags (id, document_id, tag_id, source, created_at, rev, hlc) VALUES (?, ?, ?, ?, ?, 0, ?)', [`${doc}:${to}`, doc, to, str(r.source), int(r.created_at) || now, deps.hlc.tick()]);
      }
      announce('reading_tags', `${doc}:${to}`, doc);
    }
    for (const r of select('SELECT document_id, removed_at FROM auto_tag_removed WHERE tag_id = ?', [from])) {
      const doc = str(r.document_id);
      run('INSERT OR IGNORE INTO auto_tag_removed (id, document_id, tag_id, removed_at, rev, hlc) VALUES (?, ?, ?, ?, 0, ?)', [`${doc}:${to}`, doc, to, int(r.removed_at) || now, deps.hlc.tick()]);
    }
    run('DELETE FROM reading_tags WHERE tag_id = ?', [from]);
    run('DELETE FROM auto_tag_removed WHERE tag_id = ?', [from]);
  }

  type Outcome = 'applied' | 'skipped' | 'parked' | 'forget' | 'later';

  /**
   * Readings forgotten (merge.ts rule 7). `here`: forgotten on this computer earlier, and when. `cloud`: forgotten in the cloud
   * in this pull, and when. `later`: rows of a reading saved again after a Forget in this pull, applied once it is forgotten here.
   */
  interface Gone {
    here: ReadonlyMap<string, number>;
    cloud: Map<string, number>;
    later: Pulled[];
  }
  const noneGone = (): Gone => ({ here: new Map(), cloud: new Map(), later: [] });

  /** When a pulled row was made: its `createdAt`, or its stamp's time for a table without one. */
  const madeAt = (e: Pulled): number => {
    const c = (e.row as { createdAt?: unknown } | null)?.createdAt;
    return typeof c === 'number' ? c : (parseHlc(e.hlc)?.ms ?? 0);
  };

  /** A pulled row about a forgotten reading: skipped when it was made before the Forget, kept for later when after it. */
  function forgottenFor(doc: string, e: Pulled, gone: Gone): Outcome | null {
    const cloud = gone.cloud.get(doc);
    if (cloud !== undefined) {
      if (madeAt(e) <= cloud) return 'skipped';
      gone.later.push(e);
      return 'later';
    }
    const here = gone.here.get(doc);
    if (here !== undefined && !exists('documents', doc) && madeAt(e) <= here) return 'skipped';
    return null;
  }

  /** One pulled row. Runs inside `applying`. */
  function applyOne(e: Pulled, gone: Gone): Outcome {
    const table = e.table;
    if (!(SYNCED_TABLES as readonly string[]).includes(table) || typeof e.id !== 'string') return 'skipped';
    if (table === 'documents' && (e.row as { forgotten?: unknown }).forgotten === true) {
      if (!HEX64.test(e.id)) return 'skipped';
      const d = (e.row as { deletedAt?: unknown }).deletedAt;
      const at = typeof d === 'number' && Number.isFinite(d) ? d : Number.MAX_SAFE_INTEGER;
      // Saved again here after that Forget: a new reading, which stays (and goes to the cloud as one)
      const mine = readRow('documents', e.id);
      if (mine !== undefined && int(mine.created_at) > at) return 'skipped';
      gone.cloud.set(e.id, at);
      return 'forget';
    }
    if (e.removed === true) {
      // A newer queued change here decides at the next push
      if (!REMOVABLE_TABLES.has(table) || hasQueued(table, e.id)) return 'skipped';
      return removeHere(table, e.id) ? 'applied' : 'skipped';
    }
    // A setting about a reading forgotten here or in this pull (`course.of.<sha>`, `pageOrder.of.<sha>`) never comes back,
    // unless it was made after the Forget, for the reading saved again
    if (table === 'settings') {
      for (const d of documentIdsInKey(e.id)) {
        const f = forgottenFor(d, e, gone);
        if (f !== null) return f;
      }
    }
    const norm = normalizeWireRow(table, e.row);
    if (!norm.ok) return 'skipped';
    const row = norm.row;
    const spec = TABLE_SPECS[table];
    const documentId = table === 'documents' ? e.id : spec.documentField !== null ? str(row[spec.documentField]) : null;
    // Forgotten here (and not saved again since), or forgotten in the cloud in this same pull: never brought back. Only a
    // reading saved again after the Forget, and what was made for it, comes in (merge.ts rule 7).
    if (documentId !== null) {
      const f = forgottenFor(documentId, e, gone);
      if (f !== null) return f;
    }

    // A reading's tag that names a folded tag goes to the tag that stayed, as a local edit.
    if ((table === 'reading_tags' || table === 'auto_tag_removed') && foldedTag(str(row.tagId)) !== str(row.tagId)) {
      const to = foldedTag(str(row.tagId));
      const doc = str(row.documentId);
      if (!exists('documents', doc) || !exists('tags', to)) return park(e, doc);
      setApplying(false);
      if (table === 'reading_tags') {
        if (!(row.source === 'auto' && exists('auto_tag_removed', `${doc}:${to}`)))
          run('INSERT OR IGNORE INTO reading_tags (id, document_id, tag_id, source, created_at, rev, hlc) VALUES (?, ?, ?, ?, ?, 0, ?)', [`${doc}:${to}`, doc, to, str(row.source), int(row.createdAt), deps.hlc.tick()]);
      } else {
        run('INSERT OR IGNORE INTO auto_tag_removed (id, document_id, tag_id, removed_at, rev, hlc) VALUES (?, ?, ?, ?, 0, ?)', [`${doc}:${to}`, doc, to, int(row.removedAt), deps.hlc.tick()]);
      }
      setApplying(true);
      announce(table, `${doc}:${to}`, doc);
      return 'applied';
    }

    // Its parents must be here
    for (const p of parentsOf(table, row)) if (!exists(p.table, p.id)) return park(e, documentId);

    // The server decides at the next push
    if (hasQueued(table, e.id)) return 'skipped';

    const cur = readRow(table, e.id);
    if (cur !== undefined) {
      if ((table === 'threads' || table === 'comments') && cur.draft_of_tab !== null && cur.draft_of_tab !== undefined) return 'skipped';
      if (int(cur.rev) === e.rev && str(cur.hlc) === e.hlc) return 'skipped'; // our own change coming back
      // A note never moves to another reading or thread, and never changes author, by a pull (as a restore never does)
      if (spec.documentField !== null && str(cur[snake(spec.documentField)]) !== str(row[spec.documentField]) && table !== 'aliases') return 'skipped';
      if (table === 'comments' && str(cur.thread_id) !== str(row.threadId)) return 'skipped';
    }
    if (table === 'reading_tags' && row.source === 'auto' && exists('auto_tag_removed', e.id)) return 'skipped';
    writePulled(table, row, e);
    return 'applied';
  }

  /** writeRow, except that a live tag whose name a live local tag has is folded (the name is unique among live tags). */
  function writePulled(table: SyncedTable, row: WireRow, e: { rev: number; hlc: string }): void {
    if (table === 'tags' && (row.deletedAt === null || row.deletedAt === undefined)) {
      const other = one('SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id <> ?', [str(row.name), str(row.id)]);
      if (other !== undefined) {
        foldTag(e, row, str(other.id));
        return;
      }
    }
    writeRow(table, row, { rev: e.rev, hlc: e.hlc });
  }

  function park(e: Pulled, documentId: string | null): 'parked' {
    run(
      `INSERT INTO sync_parked (table_name, row_id, document_id, entry, parked_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (table_name, row_id) DO UPDATE SET document_id = excluded.document_id, entry = excluded.entry`,
      [e.table, e.id, documentId, JSON.stringify(e), deps.now()],
    );
    return 'parked';
  }

  /** Parked rows whose parents came, in apply order. Runs inside `applying`. */
  function unpark(gone: Gone): number {
    let applied = 0;
    for (let pass = 0; pass < 4; pass++) {
      const rows = select('SELECT table_name, row_id, entry FROM sync_parked');
      if (rows.length === 0) break;
      const entries: Pulled[] = [];
      for (const r of rows) {
        try {
          entries.push(JSON.parse(str(r.entry)) as Pulled);
        } catch {
          run('DELETE FROM sync_parked WHERE table_name = ? AND row_id = ?', [str(r.table_name), str(r.row_id)]);
        }
      }
      entries.sort((a, b) => SYNC_APPLY_ORDER.indexOf(a.table) - SYNC_APPLY_ORDER.indexOf(b.table) || a.seq - b.seq);
      let moved = 0;
      for (const e of entries) {
        run('DELETE FROM sync_parked WHERE table_name = ? AND row_id = ?', [e.table, e.id]);
        const r = applyOne(e, gone); // parks it again if its parent is still missing
        if (r !== 'parked') moved++;
        if (r === 'applied') applied++;
      }
      if (moved === 0) break;
    }
    run('DELETE FROM sync_parked WHERE parked_at < ?', [deps.now() - PARK_DAYS * 86_400_000]);
    return applied;
  }

  /**
   * R59 duplicates: a fingerprint that is a reading here and also an alias of another reading. The larger id's notes move to the
   * smaller id, which every computer works out the same way. These moves are local edits: they queue and sync. Runs with the
   * outbox triggers live.
   */
  function reconcileDuplicates(): void {
    const pairs = select('SELECT a.sha256 AS fp, a.document_id AS target, a.similarity AS similarity FROM aliases a JOIN documents d ON d.id = a.sha256 WHERE a.document_id <> a.sha256');
    for (const p of pairs) {
      const fp = str(p.fp);
      const target = str(p.target);
      if (!exists('documents', target)) continue;
      const { winner, loser } = pickWinner(fp as DocumentId, target as DocumentId);
      const rowsOf = (table: 'marks' | 'threads' | 'locations') => select(`SELECT id, document_id, ${table === 'threads' ? 'draft_of_tab' : 'NULL AS draft_of_tab'} FROM ${table} WHERE document_id = ?`, [loser]).map((r) => ({ id: str(r.id), documentId: str(r.document_id), draftOfTab: r.draft_of_tab === null ? null : str(r.draft_of_tab) }));
      const comments = select('SELECT id, document_id, thread_id, draft_of_tab FROM comments WHERE document_id = ? OR thread_id IN (SELECT id FROM threads WHERE document_id = ?)', [loser, loser]).map((r) => ({ id: str(r.id), documentId: str(r.document_id), threadId: str(r.thread_id), draftOfTab: r.draft_of_tab === null ? null : str(r.draft_of_tab) }));
      const hist = (id: string) => {
        const h = readRow('history', id);
        return h ? dbToWire('history', h as DbRow).row : null;
      };
      const plan = planReparent(loser, winner, {
        marks: rowsOf('marks'),
        threads: rowsOf('threads'),
        comments,
        locations: rowsOf('locations'),
        aliases: select('SELECT sha256, document_id FROM aliases WHERE document_id = ?', [loser]).map((r) => ({ sha256: str(r.sha256), documentId: str(r.document_id) })),
        history: { loser: hist(loser), winner: hist(winner) },
      });
      const now = deps.now();
      for (const m of plan.moves) {
        const touch = m.table === 'marks' || m.table === 'threads' ? ', updated_at = max(updated_at, ?)' : '';
        run(`UPDATE ${m.table} SET document_id = ?, hlc = ?${touch} WHERE id = ?`, touch ? [winner, deps.hlc.tick(), now, m.id] : [winner, deps.hlc.tick(), m.id]);
        announce(m.table, m.id, winner);
      }
      // Reading tags carry their reading in their id: the winner gets the same tags.
      for (const r of select('SELECT tag_id, source, created_at FROM reading_tags WHERE document_id = ?', [loser]))
        run('INSERT OR IGNORE INTO reading_tags (id, document_id, tag_id, source, created_at, rev, hlc) VALUES (?, ?, ?, ?, ?, 0, ?)', [`${winner}:${str(r.tag_id)}`, winner, str(r.tag_id), str(r.source), int(r.created_at), deps.hlc.tick()]);
      for (const sha of plan.repointAliases) run('UPDATE aliases SET document_id = ?, hlc = ? WHERE sha256 = ?', [winner, deps.hlc.tick(), sha]);
      if (fp === winner) {
        // The alias said the winner was a copy of the loser: the other way round is true. This computer's copy of that row goes
        // (quietly: every computer drops it the same way), and the loser becomes the winner's alias.
        setApplying(true);
        run('DELETE FROM aliases WHERE sha256 = ?', [winner]);
        setApplying(false);
      }
      if (!exists('aliases', loser)) {
        const sim = Math.min(1, Math.max(0.995, Number(p.similarity) || 1));
        run('INSERT INTO aliases (sha256, document_id, similarity, created_at, rev, hlc) VALUES (?, ?, ?, ?, 0, ?)', [loser, winner, sim, now, deps.hlc.tick()]);
      }
      const curWinner = hist(winner);
      if (plan.history !== null && (curWinner === null || canonicalJson(curWinner) !== canonicalJson({ ...curWinner, ...plan.history }))) {
        const data = wireToDb('history', plan.history, { rev: int(readRow('history', winner)?.rev), hlc: deps.hlc.tick() });
        const cols = Object.keys(data);
        run(`INSERT INTO history (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (document_id) DO UPDATE SET ${cols.filter((c) => c !== 'document_id' && c !== 'rev').map((c) => `${c} = excluded.${c}`).join(', ')}`, cols.map((c) => data[c] as SqlValue));
      }
      if (state(`dupOf:${loser}`) === null) {
        run('UPDATE documents SET deleted_at = ?, updated_at = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [now, now, deps.hlc.tick(), loser]);
        putState(`dupOf:${loser}`, winner);
        announce('documents', loser, loser);
      }
    }
  }

  // ─── The API ────────────────────────────────────────────────────────────────────────────────────────────────────────

  return {
    collectPush: (limit) =>
      attempt((): PushBatch => {
        assertWritable();
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new SyncStoreError('bad-input', 'a push holds 1 to 200 entries');
        const entries: ChangeEntry[] = [];
        const sent: SentMark[] = [];
        let bytes = 0;
        let more = false;
        db.savepoint(() => {
          for (const g of queuedRows()) {
            if (entries.length >= limit) {
              more = true;
              break;
            }
            const v = judge(g.table, g.id, g.baseRev, g.rowJson);
            if (v.kind === 'drop') {
              dropQueued(g.table, g.id, g.seqMax);
              continue;
            }
            if (v.kind === 'hold') continue;
            const size = JSON.stringify(v.entry).length;
            if (entries.length > 0 && bytes + size > MAX_PUSH_BYTES) {
              more = true;
              break;
            }
            bytes += size;
            entries.push(v.entry);
            sent.push({ table: g.table, id: g.id, seqMax: g.seqMax });
          }
        });
        return { entries, sent, more };
      }),

    ackPush: (result, sent) =>
      attempt((): AckResult => {
        assertWritable();
        const out: AckResult = { acked: 0, rebased: 0, dropped: 0, waiting: 0 };
        if (typeof result !== 'object' || result === null || !Array.isArray(sent)) throw new SyncStoreError('bad-input', 'an ack needs the answer and what was sent');
        const marks = new Map<string, SentMark>();
        for (const m of sent as readonly SentMark[]) if ((SYNCED_TABLES as readonly string[]).includes(m.table) && typeof m.id === 'string' && Number.isInteger(m.seqMax)) marks.set(`${m.table}\u0000${m.id}`, m);
        const key = (t: string, id: string) => `${t}\u0000${id}`;
        const rebasedKeys = new Set((result.rebased ?? []).map((r) => key(r.table, r.id)));
        applying(() => {
          for (const a of result.applied ?? []) {
            const m = marks.get(key(a.table, a.id));
            if (m === undefined || !Number.isInteger(a.rev)) continue;
            const newer = hasQueued(m.table, m.id, m.seqMax);
            if (!rebasedKeys.has(key(a.table, a.id))) {
              // Our row is the server's row at `rev`: later local edits are based on it.
              run(`UPDATE ${m.table} SET rev = ? WHERE ${pk(m.table)} = ?`, [a.rev, m.id]);
              if (newer) run('UPDATE outbox SET base_rev = ? WHERE table_name = ? AND row_id = ? AND seq > ?', [a.rev, m.table, m.id, m.seqMax]);
            }
            dropQueued(m.table, m.id, m.seqMax);
            out.acked++;
          }
          for (const r of result.rebased ?? []) {
            const m = marks.get(key(r.table, r.id));
            if (m === undefined) continue;
            dropQueued(m.table, m.id, m.seqMax);
            out.rebased++;
            // An edit made here since the push is newer: the next push merges it, so the server's row is not taken now.
            if (hasQueued(m.table, m.id, m.seqMax)) continue;
            // CL11: the cloud deleted this row later than our change: it goes here too
            if (r.removed === true) {
              if (REMOVABLE_TABLES.has(r.table)) removeHere(r.table, r.id);
              continue;
            }
            const norm = normalizeWireRow(r.table, r.row);
            if (!norm.ok) continue;
            const cur = readRow(r.table, r.id);
            // Gone here meanwhile: after a Forget there is nothing to bring back. A row we deleted outright, whose newer version the
            // cloud kept (CL11), comes back when its reading (and tag) is still here.
            if (cur === undefined && !(REMOVABLE_TABLES.has(r.table) && parentsOf(r.table, norm.row).every((p) => exists(p.table, p.id)))) continue;
            writePulled(r.table, norm.row, r);
          }
          for (const j of result.rejected ?? []) {
            const m = marks.get(key(j.table, j.id));
            if (m === undefined) continue;
            if (j.retryable) {
              out.waiting++;
              continue;
            }
            // CA10: a refusal that a retry will not change leaves the queue, so "not yet synced" can reach 0.
            dropQueued(m.table, m.id, m.seqMax);
            out.dropped++;
          }
          for (const sha of result.needBlobs ?? []) if (HEX64.test(sha)) putState(`needBlob:${sha}`, '1');
          for (const id of result.needText ?? []) if (HEX64.test(id)) putState(`textSent:${id}`, null);
        });
        flush();
        return out;
      }),

    applyPulled: async (entries, cursor) => {
      if (!Array.isArray(entries) || !Number.isSafeInteger(cursor) || cursor < 0) throw new SyncStoreError('bad-input', 'a pull page has entries and a cursor');
      // Readings forgotten here are found first (hashing is asynchronous); the request queue keeps the library still meanwhile.
      const docIds = new Set<string>();
      for (const e of entries) {
        if (e?.table === 'documents' && typeof e.id === 'string') docIds.add(e.id);
        const f = e && (SYNCED_TABLES as readonly string[]).includes(e.table) ? TABLE_SPECS[e.table].documentField : null;
        const d = f !== null && typeof e.row === 'object' && e.row !== null ? e.row[f] : null;
        if (typeof d === 'string' && HEX64.test(d)) docIds.add(d);
        if (e?.table === 'settings' && typeof e.id === 'string') for (const k of documentIdsInKey(e.id)) docIds.add(k);
      }
      for (const r of select('SELECT DISTINCT document_id FROM sync_parked WHERE document_id IS NOT NULL')) docIds.add(str(r.document_id));
      const gone: Gone = { here: await forgottenSince(db, [...docIds].filter((d) => HEX64.test(d))), cloud: new Map(), later: [] };
      const result = await attempt((): ApplyResult => {
        assertWritable();
        const out: ApplyResult = { applied: 0, skipped: 0, parked: 0, forgotten: 0 };
        db.savepoint(() => {
          applying(() => {
            const sorted = [...entries].sort((a, b) => SYNC_APPLY_ORDER.indexOf(a.table) - SYNC_APPLY_ORDER.indexOf(b.table) || a.seq - b.seq);
            for (const e of sorted) {
              const r = applyOne(e, gone);
              if (r === 'applied') out.applied++;
              else if (r === 'parked') out.parked++;
              else if (r === 'skipped') out.skipped++;
            }
            out.applied += unpark(gone);
            for (const id of gone.cloud.keys()) run('DELETE FROM sync_parked WHERE document_id = ?', [id]);
            for (const id of gone.here.keys()) if (!exists('documents', id)) run('DELETE FROM sync_parked WHERE document_id = ?', [id]);
            out.parked = Number(db.selectValue('SELECT count(*) FROM sync_parked') ?? 0);
            // Rows waiting for a Forget to finish move the cursor only once they are in (a cut-off pull is pulled again)
            if (gone.later.length === 0) putState('cursor', String(cursor));
          });
          reconcileDuplicates();
        });
        flush();
        return out;
      });
      for (const [id, at] of gone.cloud) {
        if (!exists('documents', id)) continue;
        await hooks.forget(id as DocumentId);
        result.forgotten++;
        // The Forget's time here is the owner's, so a save after it, pulled later, still comes in
        const hashes = await hashesOf(db, [id]);
        if (at !== Number.MAX_SAFE_INTEGER) await attempt(() => backdateForgotten(db, hashes, at));
      }
      if (gone.later.length > 0) {
        // The reading saved again after its Forget, and what was made for it since: in, now that the old copy is gone
        const again = await attempt((): number => {
          assertWritable();
          let n = 0;
          db.savepoint(() => {
            applying(() => {
              const fresh = noneGone();
              const sorted = [...gone.later].sort((a, b) => SYNC_APPLY_ORDER.indexOf(a.table) - SYNC_APPLY_ORDER.indexOf(b.table) || a.seq - b.seq);
              for (const e of sorted) if (applyOne(e, fresh) === 'applied') n++;
              n += unpark(fresh);
              putState('cursor', String(cursor));
            });
            reconcileDuplicates();
          });
          flush();
          return n;
        });
        result.applied += again;
        result.parked = await attempt(() => Number(db.selectValue('SELECT count(*) FROM sync_parked') ?? 0));
      }
      return result;
    },

    getSyncState: (key) =>
      attempt(() => {
        if (typeof key !== 'string' || !STATE_KEY.test(key)) throw new SyncStoreError('bad-input', 'that is not a sync state key');
        return state(key);
      }),

    setSyncState: (key, value) =>
      attempt(() => {
        assertWritable();
        if (typeof key !== 'string' || !STATE_KEY.test(key) || key === APPLYING_KEY) throw new SyncStoreError('bad-input', 'that is not a sync state key');
        if (value !== null && (typeof value !== 'string' || value.length > MAX_STATE_VALUE)) throw new SyncStoreError('bad-input', 'a sync state value is short text');
        putState(key, value);
      }),

    unsyncedCount: () =>
      attempt(() => {
        const held = SYNCED_TABLES.map((t) => {
          const doc = documentOfGroupSql(t);
          return `WHEN '${t}' THEN ${doc === 'NULL' ? '0' : `coalesce((SELECT ${PRIVATE_DOC} FROM documents d WHERE d.id = ${doc}), 0)`}`;
        }).join(' ');
        const rows = Number(db.selectValue(`SELECT count(*) FROM (SELECT DISTINCT table_name, row_id FROM outbox) g WHERE NOT (CASE g.table_name ${held} ELSE 0 END)`) ?? 0);
        return rows + blobsWaiting().length + textWaiting().length;
      }),

    pendingBlobs: () => attempt(() => blobsWaiting()),
    pendingText: () => attempt(() => textWaiting()),

    forgetLocally: (id) => {
      if (typeof id !== 'string' || !HEX64.test(id)) return Promise.reject(new SyncStoreError('bad-input', 'the document id is not a SHA-256'));
      return hooks.forget(id);
    },

    pendingRestore: () =>
      attempt((): RestoreWant[] =>
        select(
          // Readings the cloud holds (`rev > 0`): a PDF not kept here, or text the reading has and this computer lacks entirely
          `SELECT d.id AS id, d.byte_size AS size,
                  (d.blob_stored = 0 AND NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.key = 'keepLocal:' || d.id)) AS blob,
                  (d.has_text = 1 AND d.index_text = 1 AND d.encrypted = 0 AND d.page_count > 0
                    AND NOT EXISTS (SELECT 1 FROM page_text p WHERE p.document_id = d.id)) AS text
           FROM documents d LEFT JOIN history h ON h.document_id = d.id
           WHERE d.rev > 0 AND d.deleted_at IS NULL AND NOT ${PRIVATE_DOC}
           ORDER BY coalesce(h.last_opened, d.created_at) DESC`,
        )
          .filter((r) => int(r.blob) === 1 || int(r.text) === 1)
          .map((r) => ({ documentId: str(r.id) as DocumentId, byteSize: int(r.size), blob: int(r.blob) === 1, text: int(r.text) === 1 })),
      ),

    textForSync: (id) =>
      attempt((): SyncText | null => {
        if (typeof id !== 'string' || !HEX64.test(id)) throw new SyncStoreError('bad-input', 'the document id is not a SHA-256');
        const ok = one(`SELECT 1 AS x FROM documents d WHERE d.id = ? AND d.rev > 0 AND d.deleted_at IS NULL AND d.has_text = 1 AND d.encrypted = 0 AND NOT ${PRIVATE_DOC}`, [id]);
        if (ok === undefined) return null;
        const rows = select('SELECT page_index, text, source FROM page_text WHERE document_id = ? ORDER BY page_index', [id]);
        if (rows.length === 0) return null;
        const sources = rows.map((r) => str(r.source));
        // One extractor for the reading in the cloud: a recogniser's, if any page was recognised (those pages must never be
        // replaced by PDFium's near-empty text on a restore), else PDFium's.
        const extractor = sources.find((x) => x.startsWith('ocr:')) ?? (sources[0] || 'pdfium');
        const sorted = [...sources].sort();
        return {
          extractor,
          source: `${sorted[0] ?? ''}|${sorted[sorted.length - 1] ?? ''}|${rows.length}`,
          pages: rows.map((r) => ({ pageIndex: int(r.page_index), text: str(r.text) })),
        };
      }),

    putSyncedText: (id, extractor, pages, complete) =>
      attempt(() => {
        assertWritable();
        if (typeof id !== 'string' || !HEX64.test(id)) throw new SyncStoreError('bad-input', 'the document id is not a SHA-256');
        if (typeof extractor !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(extractor)) throw new SyncStoreError('bad-input', 'the extractor is short plain text');
        if (!Array.isArray(pages)) throw new SyncStoreError('bad-input', 'page text comes as a list of pages');
        const source = extractor.startsWith('ocr:') ? extractor : 'pdfium';
        const changed: number[] = [];
        db.savepoint(() => {
          const doc = one('SELECT page_count, index_text FROM documents WHERE id = ?', [id]);
          if (doc === undefined || int(doc.index_text) !== 1) return;
          const count = int(doc.page_count);
          for (const p of pages as readonly { pageIndex: unknown; text: unknown }[]) {
            if (typeof p !== 'object' || p === null || !Number.isSafeInteger(p.pageIndex) || typeof p.text !== 'string') continue;
            const i = p.pageIndex as number;
            if (i < 0 || i >= count) continue;
            // A page with text here keeps it: this computer read it itself.
            if (one('SELECT 1 AS x FROM page_text WHERE document_id = ? AND page_index = ?', [id, i]) !== undefined) continue;
            run('INSERT INTO page_text (document_id, page_index, text, source) VALUES (?, ?, ?, ?)', [id, i, p.text, source]);
            changed.push(i);
          }
          if (complete) {
            const r = one(`SELECT min(source) || '|' || max(source) || '|' || count(*) AS s FROM page_text WHERE document_id = ?`, [id]);
            if (r !== undefined && str(r.s) !== '') putState(`textSent:${id}`, str(r.s));
          }
        });
        if (changed.length > 0) {
          try {
            deps.publish({ table: 'page_text', ids: changed.map((i) => `${id}:${i}`), op: 'upsert', documentId: id, origin: 'sync' });
          } catch {
            // written; other tabs catch up on their next read
          }
        }
      }),
  };

  function blobsWaiting(): DocumentId[] {
    if (state('uploadPdfs') === '0') return [];
    return select(
      `SELECT d.id AS id FROM documents d
       WHERE d.blob_stored = 1 AND NOT ${PRIVATE_DOC}
         AND EXISTS (SELECT 1 FROM sync_state s WHERE s.key = 'needBlob:' || d.id)
         AND NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.key = 'keepLocal:' || d.id)
       ORDER BY d.updated_at DESC`,
    ).map((r) => str(r.id) as DocumentId);
  }

  function textWaiting(): PendingText[] {
    // Only readings the server holds (one push answered for them) have text to send: `rev > 0`.
    return select(
      `SELECT d.id AS id, (SELECT min(source) || '|' || max(source) || '|' || count(*) FROM page_text p WHERE p.document_id = d.id) AS source
       FROM documents d LEFT JOIN history h ON h.document_id = d.id
       WHERE d.rev > 0 AND d.deleted_at IS NULL AND d.has_text = 1 AND d.encrypted = 0 AND NOT ${PRIVATE_DOC}
         AND EXISTS (SELECT 1 FROM page_text p WHERE p.document_id = d.id)
       ORDER BY coalesce(h.last_opened, d.created_at) DESC`,
    )
      .filter((r) => state(`textSent:${str(r.id)}`) !== str(r.source))
      .map((r) => ({ documentId: str(r.id) as DocumentId, source: str(r.source) }));
  }
}

function snake(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
