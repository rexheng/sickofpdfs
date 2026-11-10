// CL4: the sync service (seams.ts `SyncService`). `push` runs CL2's `mergeEntry` on every entry and writes the results in one
// D1 batch; `pull` hands out every change after a cursor, in `seq` order; `purgeDocument` is Forget.
//
// No note may be lost, so a push is all-or-nothing against any other write that ran between reading the rows and writing them:
//   1. one read batch: the stored rows, this device's replay memory (`applied_entry`), the documents they name, the lock;
//   2. the merge, in memory;
//   3. one write batch that starts by swapping `sync_counter.lock` from the value read in step 1 to a new one, then inserts a
//      row into `sync_guard` that is NULL (and so fails, rolling the whole batch back) unless the lock is now ours. Every push,
//      Forget and purge changes the lock, so a push that raced one of them writes nothing and starts again from step 1.
// D1 runs one batch at a time per database and each batch is a transaction, so this is a compare-and-set on the whole push.
//
// Deletes of rows without soft deletes (a reading's tags, settings, locations, aliases: `REMOVABLE_TABLES`) come as
// `removed: true` entries (CL11). The row is deleted and a marker kept in `removed_row`, which a pull hands out like a change.
//
// After every `apply` or `noop`, `entry.hlc` goes into `applied_entry(device, table, row)` in the same batch (plan carried
// requirement), and `mergeEntry` reads it back as `processedUpTo`: a replayed log can neither add a second conflict copy nor
// bring back a note that was deleted since.

import type { Sha256 } from '@sop/core';
import {
  CLAUDE_DEVICE,
  type ChangeEntry,
  MAX_PULL_LIMIT,
  MAX_PUSH_ENTRIES,
  type DbRow,
  type PullResponse,
  type PushResponse,
  type RejectedEntry,
  REMOVABLE_TABLES,
  type RemovalMarker,
  type ServerRow,
  SYNCED_TABLES,
  type SyncedTable,
  compareStamps,
  deleteIsLater,
  documentIdsInKey,
  documentOfRemovable,
  formatHlc,
  judgeRemoval,
  mergeEntry,
  removalRow,
} from '@sop/core/sync';
import { type Env, textShards } from '../env';
import type { SyncService } from '../seams';
import { APPLY_ORDER, chunk, documentOf, entryOf, insertIfAbsent, pkColumn, selectByIds, toServerRow, upsertRow, cloudCheck } from './rows';
import { QuotaError, addUsage, allowed, rowsWritten, usageStatement } from './meter';

export const blobKey = (sha: string): string => `pdf/${sha.slice(0, 2)}/${sha}.pdf`;
export const thumbKey = (sha: string): string => `thumb/${sha}.webp`;

/** Thrown when a push lost the race this many times in a row (very unlikely: it means writes are arriving non-stop). */
export class BusyError extends Error {
  constructor() {
    super('The library is busy. Try again in a moment.');
    this.name = 'BusyError';
  }
}

/** The request itself is wrong (not one entry of it). */
export class PushRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PushRequestError';
  }
}

/** A column value as text (D1 gives text or numbers). */
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '');

const isGuardFailure = (e: unknown): boolean => e instanceof Error && /sync_guard/.test(e.message);
const newLock = (): string => crypto.randomUUID();

/** Stamps the server writes itself (a Forget in a pull). */
const serverStamp = (ms: number): string => formatHlc({ ms, counter: 0, device: 'server' });

interface DocFacts {
  createdAt: number;
  blobStored: boolean;
  hasText: boolean;
  indexText: boolean;
  encrypted: boolean;
  deleted: boolean;
}

export function createSyncService(env: Env): SyncService {
  return {
    head: () => head(env),
    pull: (since, limit) => pull(env, since, limit),
    push: (device, entries) => push(env, device, entries),
    purgeDocument: (sha, at) => purgeDocument(env, sha, at),
  };
}

async function head(env: Env): Promise<number> {
  const r = await env.META.prepare('SELECT seq FROM sync_counter WHERE id = 1').first<{ seq: number }>();
  return r?.seq ?? 0;
}

// ─── Pull ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A pull page stops near this many bytes of JSON, so one answer stays small on a phone. */
const PULL_MAX_BYTES = 4_000_000;

async function pull(env: Env, since: number, limit: number): Promise<PullResponse> {
  const from = Number.isSafeInteger(since) && since > 0 ? since : 0;
  const n = Math.min(Math.max(1, Math.floor(limit) || 200), MAX_PULL_LIMIT);
  const db = env.META;
  const results = await db.batch<DbRow>([
    db.prepare('SELECT seq FROM sync_counter WHERE id = 1'),
    ...SYNCED_TABLES.map((t) => db.prepare(`SELECT * FROM ${t} WHERE seq > ? ORDER BY seq LIMIT ?`).bind(from, n)),
    db.prepare('SELECT document_id, at, seq FROM forgotten WHERE seq > ? ORDER BY seq LIMIT ?').bind(from, n),
    db.prepare('SELECT table_name, row_id, rev, hlc, seq, device FROM removed_row WHERE seq > ? ORDER BY seq LIMIT ?').bind(from, n),
  ]);
  const headSeq = Number(results[0]?.results[0]?.seq ?? 0);
  const all: PullResponse['entries'] = [];
  SYNCED_TABLES.forEach((t, i) => {
    for (const row of results[i + 1]?.results ?? []) all.push(entryOf(t, row));
  });
  for (const f of results[SYNCED_TABLES.length + 1]?.results ?? []) {
    const at = Number(f.at ?? 0);
    all.push({ table: 'documents', id: str(f.document_id), baseRev: 0, hlc: serverStamp(at), row: { id: str(f.document_id), deletedAt: at, forgotten: true }, rev: 0, seq: Number(f.seq ?? 0), device: 'server' });
  }
  for (const r of results[SYNCED_TABLES.length + 2]?.results ?? []) {
    const table = str(r.table_name) as SyncedTable;
    if (!REMOVABLE_TABLES.has(table)) continue;
    const rev = Number(r.rev ?? 0);
    all.push({ table, id: str(r.row_id), baseRev: rev, hlc: str(r.hlc), row: removalRow(table, str(r.row_id)), removed: true, rev, seq: Number(r.seq ?? 0), device: str(r.device) });
  }
  all.sort((a, b) => a.seq - b.seq);

  const entries: PullResponse['entries'] = [];
  let bytes = 0;
  for (const e of all) {
    if (entries.length >= n) break;
    const size = JSON.stringify(e).length;
    if (entries.length > 0 && bytes + size > PULL_MAX_BYTES) break;
    entries.push(e);
    bytes += size;
  }
  const truncated = entries.length < all.length;
  // Read in the same batch as the rows, so nothing between the last row and `head` can be missed
  const cursor = truncated ? (entries[entries.length - 1]?.seq ?? from) : Math.max(from, headSeq);
  return { entries, cursor, head: headSeq, more: cursor < headSeq };
}

// ─── Push ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function push(env: Env, device: string, entries: ChangeEntry[]): Promise<PushResponse> {
  if (typeof device !== 'string' || device === '') throw new PushRequestError(400, 'no_device', 'This sign-in has no sync device yet. Register one first.');
  if (!Array.isArray(entries)) throw new PushRequestError(400, 'bad_request', 'entries must be a list');
  if (entries.length > MAX_PUSH_ENTRIES) throw new PushRequestError(413, 'too_many_entries', `Send at most ${MAX_PUSH_ENTRIES} entries in one push.`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await tryPush(env, device, entries);
    if (r !== 'retry') return r;
  }
  throw new BusyError();
}

async function tryPush(env: Env, device: string, raw: ChangeEntry[]): Promise<PushResponse | 'retry'> {
  const db = env.META;
  const now = Date.now();
  const response: PushResponse = { applied: [], rebased: [], needBlobs: [], needText: [], rejected: [] };
  const rejected = response.rejected as RejectedEntry[];

  // Entries that cannot even be looked up are refused here; the rest are applied in table order (a document before its notes)
  const valid: ChangeEntry[] = [];
  for (const e of raw) {
    const ok = typeof e === 'object' && e !== null && (SYNCED_TABLES as readonly string[]).includes((e).table) && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 300;
    if (ok) valid.push(e);
    else rejected.push({ table: (e as ChangeEntry | null)?.table ?? 'documents', id: typeof e?.id === 'string' ? e.id.slice(0, 300) : '', code: 'bad_entry', message: 'not a sync entry', retryable: false });
  }
  const order = (t: SyncedTable) => APPLY_ORDER.indexOf(t);
  const entries = valid.map((e, i) => ({ e, i })).sort((a, b) => order(a.e.table) - order(b.e.table) || a.i - b.i).map((x) => x.e);

  // 1. Read everything the merge needs, in one batch
  const ids = new Map<SyncedTable, string[]>();
  const docIds = new Set<string>();
  for (const e of entries) {
    ids.set(e.table, [...(ids.get(e.table) ?? []), e.id]);
    if (e.table === 'documents') docIds.add(e.id);
    const d = documentOf(e.table, (typeof e.row === 'object' && e.row !== null ? e.row : {}));
    if (d !== null && /^[0-9a-f]{64}$/.test(d)) docIds.add(d);
    if (e.table === 'settings') for (const k of documentIdsInKey(e.id)) docIds.add(k);
    const r = REMOVABLE_TABLES.has(e.table) ? documentOfRemovable(e.table, e.id, null) : null;
    if (r !== null) docIds.add(r);
  }
  const reads: D1PreparedStatement[] = [db.prepare('SELECT seq, lock FROM sync_counter WHERE id = 1'), usageStatement(env, now)];
  const kinds: ({ kind: 'rows'; table: SyncedTable } | { kind: 'applied' | 'docs' | 'forgotten' | 'doc_text' | 'markers' })[] = [];
  for (const [table, list] of ids) for (const s of selectByIds(db, table, list)) {
    reads.push(s);
    kinds.push({ kind: 'rows', table });
  }
  for (const [table, list] of ids) {
    if (!REMOVABLE_TABLES.has(table)) continue;
    for (const part of chunk([...new Set(list)], 80)) {
      reads.push(db.prepare(`SELECT table_name, row_id, rev, hlc, device FROM removed_row WHERE table_name = ? AND row_id IN (${part.map(() => '?').join(',')})`).bind(table, ...part));
      kinds.push({ kind: 'markers' });
    }
  }
  for (const [table, list] of ids) {
    for (const part of chunk([...new Set(list)], 80)) {
      reads.push(db.prepare(`SELECT table_name, row_id, hlc FROM applied_entry WHERE device = ? AND table_name = ? AND row_id IN (${part.map(() => '?').join(',')})`).bind(device, table, ...part));
      kinds.push({ kind: 'applied' });
    }
  }
  for (const part of chunk([...docIds])) {
    const q = part.map(() => '?').join(',');
    reads.push(db.prepare(`SELECT id, created_at, blob_stored, has_text, index_text, encrypted, deleted_at FROM documents WHERE id IN (${q})`).bind(...part));
    kinds.push({ kind: 'docs' });
    reads.push(db.prepare(`SELECT document_id, at FROM forgotten WHERE document_id IN (${q})`).bind(...part));
    kinds.push({ kind: 'forgotten' });
    reads.push(db.prepare(`SELECT document_id, state FROM doc_text WHERE document_id IN (${q})`).bind(...part));
    kinds.push({ kind: 'doc_text' });
  }
  const got = await db.batch<DbRow>(reads);
  const counter = got[0]?.results[0] as { seq: number; lock: string } | undefined;
  if (!counter) throw new Error('sync_counter is missing');
  if (!allowed(env, 'notes', got[1]?.results[0] as { text_rows: number; note_rows: number } | undefined)) throw new QuotaError('notes');

  const stored = new Map<string, ServerRow>();
  const seqOf = new Map<string, number>();
  const processed = new Map<string, string>();
  const docs = new Map<string, DocFacts>();
  /** Forgotten readings and when (rule 7 of merge.ts: a save after the Forget is a new reading). */
  const forgotten = new Map<string, number>();
  const textState = new Map<string, string>();
  const markers = new Map<string, RemovalMarker>();
  kinds.forEach((k, i) => {
    const rows = got[i + 2]?.results ?? [];
    if (k.kind === 'rows') {
      for (const r of rows) {
        const s = toServerRow(k.table, r);
        stored.set(`${k.table}\u0000${s.id}`, s);
        seqOf.set(`${k.table}\u0000${s.id}`, Number(r.seq ?? 0));
      }
    } else if (k.kind === 'applied') for (const r of rows) processed.set(`${str(r.table_name)}\u0000${str(r.row_id)}`, str(r.hlc));
    else if (k.kind === 'docs')
      for (const r of rows) docs.set(str(r.id), { createdAt: Number(r.created_at ?? 0), blobStored: r.blob_stored === 1, hasText: r.has_text === 1, indexText: r.index_text === 1, encrypted: r.encrypted === 1, deleted: r.deleted_at !== null });
    else if (k.kind === 'forgotten') for (const r of rows) forgotten.set(str(r.document_id), Number(r.at ?? 0));
    else if (k.kind === 'markers')
      for (const r of rows) markers.set(`${str(r.table_name)}\u0000${str(r.row_id)}`, { table: str(r.table_name) as SyncedTable, id: str(r.row_id), rev: Number(r.rev ?? 0), hlc: str(r.hlc), device: str(r.device) });
    else for (const r of rows) textState.set(str(r.document_id), str(r.state));
  });

  // 2. The merge
  let seq = counter.seq;
  const writes: D1PreparedStatement[] = [];
  const pushedDocs = new Set<string>();
  const ctx = {
    device,
    now,
    // A reading saved again after its Forget is known again; until then it is forgotten
    documentState: (id: string) => {
      const d = docs.get(id);
      const at = forgotten.get(id);
      if (at !== undefined && (d === undefined || d.createdAt <= at)) return 'forgotten' as const;
      return d !== undefined ? ('known' as const) : ('unknown' as const);
    },
    forgottenAt: (id: string) => forgotten.get(id) ?? null,
    processedUpTo: (table: SyncedTable, id: string) => processed.get(`${table}\u0000${id}`) ?? null,
  };
  const remember = (e: ChangeEntry) => {
    const key = `${e.table}\u0000${e.id}`;
    const before = processed.get(key);
    const hlc = before !== undefined && compareStamps(before, e.hlc) > 0 ? before : e.hlc;
    processed.set(key, hlc);
    writes.push(
      db.prepare('INSERT INTO applied_entry (device, table_name, row_id, hlc, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device, table_name, row_id) DO UPDATE SET hlc = excluded.hlc, at = excluded.at').bind(device, e.table, e.id, hlc, now),
    );
  };

  for (const e of entries) {
    const key = `${e.table}\u0000${e.id}`;
    const server = stored.get(key) ?? null;
    const marker = markers.get(key) ?? null;

    // A row deleted outright on the device (CL11)
    if (e.removed === true) {
      const j = judgeRemoval(server, e, ctx);
      if (j.kind === 'reject') {
        rejected.push({ table: e.table, id: e.id, code: j.code, message: j.message, retryable: j.retryable });
        continue;
      }
      if (j.kind === 'remove' && server !== null) {
        seq += 1;
        const doc = documentOfRemovable(e.table, e.id, server);
        writes.push(db.prepare(`DELETE FROM ${e.table} WHERE ${pkColumn(e.table)} = ?`).bind(e.id));
        writes.push(
          db
            .prepare('INSERT INTO removed_row (table_name, row_id, document_id, rev, hlc, seq, device, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(table_name, row_id) DO UPDATE SET document_id = excluded.document_id, rev = excluded.rev, hlc = excluded.hlc, seq = excluded.seq, device = excluded.device, at = excluded.at')
            .bind(e.table, e.id, doc, j.rev, j.hlc, seq, device, now),
        );
        stored.delete(key);
        markers.set(key, { table: e.table, id: e.id, rev: j.rev, hlc: j.hlc, device });
        response.applied.push({ table: e.table, id: e.id, rev: j.rev, seq });
      } else if (j.kind === 'keep' && server !== null) {
        response.rebased.push({ table: e.table, id: e.id, baseRev: server.rev, hlc: server.hlc, row: server.row, rev: server.rev, seq: seqOf.get(key) ?? 0 });
      } else {
        response.applied.push({ table: e.table, id: e.id, rev: marker?.rev ?? e.baseRev, seq: 0 });
      }
      remember(e);
      continue;
    }
    // The row itself, where the server keeps only the marker of its delete: the later change wins
    if (server === null && marker !== null && deleteIsLater(marker, e, now)) {
      response.rebased.push({ table: e.table, id: e.id, baseRev: marker.rev, hlc: marker.hlc, row: removalRow(e.table, e.id), removed: true, rev: marker.rev, seq: 0 });
      remember(e);
      continue;
    }

    let r;
    try {
      r = mergeEntry(server, e, ctx);
    } catch {
      r = { kind: 'reject' as const, code: 'bad_entry' as const, message: 'the server could not read this entry', retryable: false };
    }
    if (r.kind === 'apply') {
      const bad = cloudCheck(e.table, r.row);
      if (bad !== null) r = { kind: 'reject' as const, code: 'bad_row' as const, message: bad, retryable: false };
    }
    if (r.kind === 'reject') {
      rejected.push({ table: e.table, id: e.id, code: r.code, message: r.message, retryable: r.retryable });
      continue;
    }
    if (r.conflictCopy) {
      const copy = r.conflictCopy;
      const copyKey = `comments\u0000${String(copy.row.id)}`;
      if (!stored.has(copyKey)) {
        seq += 1;
        writes.push(insertIfAbsent(db, 'comments', copy.row, { rev: copy.rev, hlc: copy.hlc, seq, device: copy.device }));
        stored.set(copyKey, { table: 'comments', id: String(copy.row.id), rev: copy.rev, hlc: copy.hlc, device: copy.device, row: copy.row });
        seqOf.set(copyKey, seq);
      }
    }
    if (r.kind === 'apply') {
      seq += 1;
      writes.push(upsertRow(db, e.table, r.row, { rev: r.rev, hlc: r.hlc, seq, device }));
      if (marker !== null) {
        // added again after its delete: the marker goes (its seq is older than the row's, so no pull can miss the row)
        writes.push(db.prepare('DELETE FROM removed_row WHERE table_name = ? AND row_id = ?').bind(e.table, e.id));
        markers.delete(key);
      }
      const next: ServerRow = { table: e.table, id: e.id, rev: r.rev, hlc: r.hlc, device, row: r.row };
      stored.set(key, next);
      seqOf.set(key, seq);
      if (e.table === 'documents') {
        // its notes later in this push count it as known, and a reading saved again after its Forget counts as saved again
        const prev = docs.get(e.id) ?? { createdAt: 0, blobStored: false, hasText: false, indexText: false, encrypted: false, deleted: false };
        docs.set(e.id, { ...prev, createdAt: typeof r.row.createdAt === 'number' ? r.row.createdAt : now });
      }
      response.applied.push({ table: e.table, id: e.id, rev: r.rev, seq });
      if (r.rebase) response.rebased.push({ table: e.table, id: e.id, baseRev: r.rev, hlc: r.hlc, row: r.row, ...(e.table === 'documents' ? { label: 'learning' as const } : {}), rev: r.rev, seq });
    } else {
      // noop: the stored row stays. A replay is acknowledged; anything else hands the device the stored row.
      const s = server as ServerRow;
      const sSeq = seqOf.get(key) ?? 0;
      if (r.why === 'replay' && !r.rebase) response.applied.push({ table: e.table, id: e.id, rev: s.rev, seq: sSeq });
      else response.rebased.push({ table: e.table, id: e.id, baseRev: s.rev, hlc: s.hlc, row: s.row, ...(e.table === 'documents' ? { label: 'learning' as const } : {}), rev: s.rev, seq: sSeq });
    }
    remember(e);
    if (e.table === 'documents') pushedDocs.add(e.id);
  }

  // What the device should upload next: the PDF if R2 lacks it, the page text if the shards lack it (never a password-protected
  // file's text, CD2, nor a reading whose text is not indexed)
  for (const id of pushedDocs) {
    const row = stored.get(`documents\u0000${id}`)?.row;
    if (!row) continue;
    if (!(docs.get(id)?.blobStored ?? false)) response.needBlobs.push(id as Sha256);
    const t = textState.get(id);
    if (row.hasText === true && row.indexText === true && row.encrypted !== true && t !== 'complete') response.needText.push(id as never);
  }

  if (writes.length === 0) return response;

  // 3. The write, all or nothing
  const lock = newLock();
  const batch = [
    db.prepare('UPDATE sync_counter SET seq = ?, lock = ? WHERE id = 1 AND lock = ?').bind(seq, lock, counter.lock),
    db.prepare('INSERT INTO sync_guard (ok) SELECT CASE WHEN lock = ? THEN 1 END FROM sync_counter WHERE id = 1').bind(lock),
    ...writes,
    db.prepare('DELETE FROM sync_guard'),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(batch);
  } catch (e) {
    if (isGuardFailure(e)) return 'retry';
    throw e;
  }
  await addUsage(env, 'notes', rowsWritten(results), now);
  if (device !== CLAUDE_DEVICE) await db.prepare('UPDATE device SET last_seen_at = ? WHERE id = ?').bind(now, device).run().catch(() => undefined);
  return response;
}

// ─── Forget ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Child tables of a document, in the order they are removed. */
const CHILDREN: readonly SyncedTable[] = ['comments', 'threads', 'marks', 'reading_tags', 'auto_tag_removed', 'locations', 'aliases', 'history'];

/**
 * Hard delete (Forget, and Trash after 30 days): the PDF and its thumbnail, the page text, every note and row of the document.
 * The document joins `forgotten` first, so nothing made before the Forget is accepted again, and other devices pull
 * `{ forgotten: true }`. A new save after it syncs again (merge.ts rule 7).
 *
 * `asked` is when the owner chose Forget on their device (ms), so a Forget sent late, after the device was offline, still
 * lets a save made after it through. It is never later than the server's clock. Left out, it is now.
 *  - A later Forget of a reading saved again moves the time forward and is pulled again by every device.
 *  - An older or repeated one changes nothing, but finishes a Forget that was cut off halfway.
 *  - If the cloud already holds a save made after this Forget (the save got there first), only what was made before the
 *    Forget is removed: the new save, its notes, the PDF and its text stay.
 */
async function purgeDocument(env: Env, sha: Sha256, asked?: number): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new PushRequestError(400, 'bad_id', 'not a document id');
  const db = env.META;
  const now = Date.now();
  const when = typeof asked === 'number' && Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, now) : now;
  // a. Mark it forgotten (one new seq each time the Forget time moves forward), and change the lock so a push in flight starts over
  const [, , atR, docR] = await db.batch<DbRow>([
    db.prepare('UPDATE sync_counter SET seq = seq + (CASE WHEN EXISTS (SELECT 1 FROM forgotten WHERE document_id = ? AND at >= ?) THEN 0 ELSE 1 END), lock = ? WHERE id = 1').bind(sha, when, newLock()),
    db
      .prepare('INSERT INTO forgotten (document_id, at, seq) SELECT ?, ?, seq FROM sync_counter WHERE id = 1 ON CONFLICT (document_id) DO UPDATE SET at = excluded.at, seq = excluded.seq WHERE excluded.at > forgotten.at')
      .bind(sha, when),
    db.prepare('SELECT at FROM forgotten WHERE document_id = ?').bind(sha),
    db.prepare('SELECT created_at FROM documents WHERE id = ?').bind(sha),
  ]);
  const at = Number(atR?.results[0]?.at ?? when);
  const created = docR?.results[0]?.created_at;
  if (typeof created === 'number' && created > at) return purgeBefore(env, sha, at, now);
  // b. The page text, in whichever shard holds it
  for (const shard of textShards(env)) {
    await shard.batch([
      shard.prepare('DELETE FROM page WHERE id >= (SELECT docnum * 100000 FROM shard_doc WHERE document_id = ?) AND id < (SELECT docnum * 100000 + 100000 FROM shard_doc WHERE document_id = ?)').bind(sha, sha),
      shard.prepare('DELETE FROM shard_doc WHERE document_id = ?').bind(sha),
    ]);
  }
  // c. The files
  const upload = await db.prepare('SELECT upload_id FROM blob_upload WHERE sha256 = ?').bind(sha).first<{ upload_id: string }>();
  if (upload) await env.BLOBS.resumeMultipartUpload(blobKey(sha), upload.upload_id).abort().catch(() => undefined);
  await env.BLOBS.delete([blobKey(sha), thumbKey(sha)]);
  // d. Every row, and this document's replay memory
  const children = CHILDREN.map((t) => db.prepare(`DELETE FROM applied_entry WHERE table_name = ? AND row_id IN (SELECT ${pkColumn(t)} FROM ${t} WHERE document_id = ?)`).bind(t, sha));
  await db.batch([
    db.prepare('UPDATE sync_counter SET lock = ? WHERE id = 1').bind(newLock()),
    ...children,
    db.prepare("DELETE FROM applied_entry WHERE table_name = 'documents' AND row_id = ?").bind(sha),
    ...CHILDREN.map((t) => db.prepare(`DELETE FROM ${t} WHERE document_id = ?`).bind(sha)),
    // settings about this reading (`course.of.<sha>`, `pageOrder.of.<sha>`): no fingerprint of a forgotten PDF stays (CL11)
    db.prepare("DELETE FROM applied_entry WHERE table_name = 'settings' AND instr(row_id, ?) > 0").bind(sha),
    db.prepare('DELETE FROM settings WHERE instr(key, ?) > 0').bind(sha),
    db.prepare('DELETE FROM removed_row WHERE document_id = ? OR instr(row_id, ?) > 0').bind(sha, sha),
    db.prepare('DELETE FROM documents WHERE id = ?').bind(sha),
    db.prepare('DELETE FROM doc_text WHERE document_id = ?').bind(sha),
    db.prepare('DELETE FROM blob_upload WHERE sha256 = ?').bind(sha),
    // no document id in the audit: Forget leaves no trace beyond the forgotten list itself
    db.prepare("INSERT INTO audit (at, actor, client_id, action, target) VALUES (?, 'owner', NULL, 'document.forget', NULL)").bind(now),
  ]);
}

/** The tables of a reading whose rows have no `created_at`: their stamp says when they were made. */
const STAMPED: readonly SyncedTable[] = ['locations', 'history', 'auto_tag_removed'];

/** SQL for "this row's stamp is at or before ?" (a stamp starts with its time in ms, 13 digits). */
const stampedBy = (col = 'hlc'): string => `CAST(substr(${col}, 1, 13) AS INTEGER) <= ?`;

/**
 * A Forget that is older than the save the cloud holds (merge.ts rule 7): only the rows made at or before `at` go, with their
 * replay memory. The reading itself, its PDF, its text and everything made after the Forget stay.
 */
async function purgeBefore(env: Env, sha: Sha256, at: number, now: number): Promise<void> {
  const db = env.META;
  const made = (t: SyncedTable): string => (STAMPED.includes(t) ? stampedBy() : 'created_at <= ?');
  await db.batch([
    db.prepare('UPDATE sync_counter SET lock = ? WHERE id = 1').bind(newLock()),
    ...CHILDREN.map((t) => db.prepare(`DELETE FROM applied_entry WHERE table_name = ? AND row_id IN (SELECT ${pkColumn(t)} FROM ${t} WHERE document_id = ? AND ${made(t)})`).bind(t, sha, at)),
    ...CHILDREN.map((t) => db.prepare(`DELETE FROM ${t} WHERE document_id = ? AND ${made(t)}`).bind(sha, at)),
    db.prepare(`DELETE FROM applied_entry WHERE table_name = 'settings' AND instr(row_id, ?) > 0 AND row_id IN (SELECT key FROM settings WHERE ${stampedBy()})`).bind(sha, at),
    db.prepare(`DELETE FROM settings WHERE instr(key, ?) > 0 AND ${stampedBy()}`).bind(sha, at),
    db.prepare(`DELETE FROM removed_row WHERE (document_id = ? OR instr(row_id, ?) > 0) AND ${stampedBy()}`).bind(sha, sha, at),
    db.prepare("INSERT INTO audit (at, actor, client_id, action, target) VALUES (?, 'owner', NULL, 'document.forget', NULL)").bind(now),
  ]);
}
