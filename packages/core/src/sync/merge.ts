// The rules that decide what wins when two computers change the same row. Pure: no clock, no database, no randomness. The
// server's push handler calls `mergeEntry` once per entry and writes whatever it answers.
//
// The promise is that no note is lost. Every rule below either keeps the whole row of exactly one side (last writer wins by
// hybrid-clock stamp) or keeps both sides' words (a conflict copy, a union, a min or a max). Nothing averages, nothing
// guesses, and a body that loses is kept as a new comment in the same thread.
//
// Versions. Each stored row has a revision `rev` that the server bumps on every accepted write. A device sends the revision
// it based its edit on (`baseRev`):
//   - `baseRev === server.rev`: the device saw the latest version, so its edit follows it ("causal") and wins.
//   - otherwise the edit is concurrent with something the device has not seen, and these rules decide.
//
// Rules (contracts §7 and the Phase 5 plan):
//   1. A retry of an applied push is a no-op, not a conflict: the same content as the server's row, or an entry the server
//      has already processed (`ctx.processedUpTo`), so a replayed log does nothing.
//   2. An edit beats a delete. Otherwise the newer stamp wins the whole row; equal stamps break the tie by content, so the
//      result never depends on object key order. The stored stamp is the stamp of the version that won: an edit that beats
//      a newer delete keeps its own stamp, so the push order never decides which of two edits is the later one.
//   3. Two live comments with different, non-empty bodies: the loser's body becomes a new comment in the same thread with
//      `ConflictCopyMeta`. Its id comes from (comment id, body), so a retry makes the same copy, never a second one. A
//      device's own earlier version is superseded, not a rival, so it gets no copy.
//   4. `history` merges field by field; `locations` merge `firstSeen`/`lastSeen`; two aliases for one fingerprint keep the
//      smaller document id. These do not depend on the revision at all.
//   5. `author` never changes. The `claude` device writes only rows with `author = 'claude'` (and new threads) and edits
//      nobody else's. Other devices may delete or restore a Claude row but not rewrite it.
//   6. Drafts, forgotten documents, unlabelled documents, secret-looking settings and local folder paths never get in.

import type { HlcStamp } from '../hlc';
import {
  type WireRow,
  TABLE_SPECS,
  base64ToBytes,
  bytesToBase64,
  canonicalJson,
  isSyncableSetting,
  normalizeWireRow,
  trimBitset,
  unionBitsets,
} from './columns';
import { clampHlc, compareStamps, maxStamp, parseHlc } from './clamp';
import { CLAUDE_DEVICE, type ChangeEntry, type RejectCode, type SyncedTable, SYNCED_TABLES } from './protocol';

/** The row the server holds, as the push handler read it from the database (see `dbToWire`). */
export interface ServerRow {
  table: SyncedTable;
  id: string;
  rev: number;
  hlc: HlcStamp;
  /** The device that wrote the current version. */
  device: string;
  /** Wire form (camelCase, parsed JSON), without `rev` and `hlc`. */
  row: WireRow;
}

export interface MergeContext {
  /** The device the push came from. The server takes it from the signed-in token, never from the request body. */
  device: string;
  /** The server's clock, in ms. Stamps more than five minutes ahead of it are pulled back. */
  now: number;
  /**
   * What the server knows about a document: `known` (any row, even in Trash), `unknown` (not pushed yet: the entry waits),
   * or `forgotten` (Forget ran; nothing about it is accepted again). Rows pushed earlier in the same batch count as known.
   * Left out, every document counts as known.
   */
  documentState?(documentId: string): 'known' | 'unknown' | 'forgotten';
  /**
   * The newest stamp, exactly as the device sent it, of an entry from `ctx.device` for this row that the server has already
   * processed (applied, or judged and kept out), or null. After every `apply` or `noop` result the server records
   * `entry.hlc` here (one small row per device and row; see `applied_entry` in the cloud schema).
   *
   * With it, a retry or a replayed log is recognised and does nothing: it makes no second conflict copy and cannot bring back
   * a note that was deleted since. Without it the merge is still correct and loses nothing, but an old entry replayed after
   * the row moved on can be judged as a concurrent edit again.
   *
   * It trusts that a device's stamps only grow (the clock takes the largest stamp it has seen, and a device's stored data and
   * its id go together). A device that kept its id but lost its clock state, with a wall clock that is also behind its old
   * stamps, would have a genuinely new edit mistaken for a replay until its clock passed the old stamps. A fresh install
   * gets a new device id, so this needs an unusual partial reset.
   */
  processedUpTo?(table: SyncedTable, id: string): HlcStamp | null;
}

/** A comment made from the losing side of a conflict. The server inserts it only if no row has that id yet. */
export interface ConflictCopy {
  table: 'comments';
  /** Wire form of the new comment row. */
  row: WireRow;
  /** The stamp to store it with (the stamp of the merge that made it). */
  hlc: HlcStamp;
  rev: 1;
  /** The comment whose body lost. */
  of: string;
  /** The device that wrote the losing body. */
  device: string;
  /** Insert only if absent: a retry, or a copy the owner already deleted, must not come back. */
  createOnly: true;
}

export type NoopWhy = 'replay' | 'older' | 'delete-loses' | 'smaller-document' | 'claude-row-kept';
export type ApplyWhy = 'created' | 'fast-forward' | 'newer' | 'edit-beats-delete' | 'merged-fields' | 'claude-row-delete';

export type MergeResult =
  | {
      kind: 'apply';
      /** The row to store, wire form, without `rev` and `hlc`. The server's `blobStored` and other server columns stay as they are. */
      row: WireRow;
      /** The stamp to store (never later than five minutes after the server's clock). */
      hlc: HlcStamp;
      /** The revision to store: the server's plus one, or 1 for a new row. */
      rev: number;
      /** True when the pusher's copy differs from `row` and must be replaced by it (answer with it in `rebased`). */
      rebase: boolean;
      why: ApplyWhy;
      conflictCopy: ConflictCopy | null;
    }
  | {
      kind: 'noop';
      /** The stored row stays as it is. A `replay` is acknowledged with its current revision; the others are `rebased`. */
      why: NoopWhy;
      rebase: boolean;
      /** A losing body can still need saving even when the stored row does not change. */
      conflictCopy: ConflictCopy | null;
    }
  | { kind: 'reject'; code: RejectCode; message: string; retryable: boolean };

function reject(code: RejectCode, message: string, retryable = false): MergeResult {
  return { kind: 'reject', code, message, retryable };
}

// ─── Small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const isDeleted = (row: WireRow): boolean => row.deletedAt !== null && row.deletedAt !== undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Equal content, whatever the key order. Compares only wire columns, so the server's own columns never count. */
function sameRow(table: SyncedTable, a: WireRow, b: WireRow): boolean {
  for (const c of TABLE_SPECS[table].columns) {
    if (c.localOnly === true) continue;
    if (canonicalJson(a[c.field] ?? null) !== canonicalJson(b[c.field] ?? null)) return false;
  }
  return true;
}

function rowKey(table: SyncedTable, row: WireRow): string {
  const o: WireRow = {};
  for (const c of TABLE_SPECS[table].columns) if (c.localOnly !== true) o[c.field] = row[c.field] ?? null;
  return canonicalJson(o);
}

// ─── A pure SHA-256, for deterministic ids ────────────────────────────────────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string (UTF-8), as hex. Synchronous, so the merge can stay a plain function. */
export function sha256Sync(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bits = msg.length * 8;
  const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

/** A UUID-shaped id made from text, so a conflict copy looks like every other comment id and is the same on every retry. */
export function derivedId(...parts: string[]): string {
  const hex = sha256Sync(parts.join('\u0000'));
  const variant = (0x8 | (parseInt(hex.charAt(16), 16) & 0x3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ─── Conflict copy ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The loser's words as a new comment in the same thread. Restore (`backup/merge.ts`) makes the same copy, with the same id. */
export function makeConflictCopy(winner: WireRow, loser: WireRow, loserDevice: string, hlc: HlcStamp): ConflictCopy {
  const of = str(loser.id);
  const at = (r: WireRow) => Math.max(num(r.createdAt), num(r.editedAt));
  return {
    table: 'comments',
    of,
    device: loserDevice,
    hlc,
    rev: 1,
    createOnly: true,
    row: {
      id: derivedId('conflict-copy', of, str(loser.body)),
      threadId: loser.threadId,
      documentId: loser.documentId,
      // authorship is never changed: the copy is the loser's words, written by whoever wrote them
      author: loser.author,
      body: loser.body,
      draftOfTab: null,
      meta: { kind: 'conflict-copy', v: 1, of, device: loserDevice },
      // after both comments, so the copy can never become the thread's first comment
      createdAt: Math.max(at(winner), at(loser)) + 1,
      editedAt: null,
      deletedAt: null,
    },
  };
}

/** Both live, both bodies non-empty, and different: the losing body must be kept. */
export function needsCopy(a: WireRow, b: WireRow): boolean {
  return !isDeleted(a) && !isDeleted(b) && str(a.body).trim() !== '' && str(b.body).trim() !== '' && a.body !== b.body;
}

// ─── Field-by-field merges ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Two reading histories of one document. `firstOpened` is the smaller, `lastOpened` the larger, the counters the larger,
 * the pages visited the union, and `lastPosition` comes from the side that was opened last. Order does not matter:
 * `mergeHistoryRows(a, b)` equals `mergeHistoryRows(b, a)`. `mergeEntry` then takes `lastPosition` from the newer stamp
 * (plan CL2); `planReparent` has no stamps and keeps this choice.
 */
export function mergeHistoryRows(a: WireRow, b: WireRow): WireRow {
  const aNewer = num(a.lastOpened) > num(b.lastOpened) || (num(a.lastOpened) === num(b.lastOpened) && canonicalJson(a.lastPosition ?? null) >= canonicalJson(b.lastPosition ?? null));
  const bytesA = base64ToBytes(str(a.pagesVisited)) ?? new Uint8Array(0);
  const bytesB = base64ToBytes(str(b.pagesVisited)) ?? new Uint8Array(0);
  return {
    documentId: a.documentId,
    firstOpened: Math.min(num(a.firstOpened), num(b.firstOpened)),
    lastOpened: Math.max(num(a.lastOpened), num(b.lastOpened)),
    openCount: Math.max(num(a.openCount), num(b.openCount)),
    readingMs: Math.max(num(a.readingMs), num(b.readingMs)),
    lastPosition: (aNewer ? a.lastPosition : b.lastPosition) ?? null,
    pagesVisited: bytesToBase64(trimBitset(unionBitsets(bytesA, bytesB))),
  };
}

/** Two sightings of one link: first seen is the smaller, last seen the larger. The rest comes from `winner`. */
function mergeLocationRows(winner: WireRow, other: WireRow): WireRow {
  return {
    ...winner,
    firstSeen: Math.min(num(winner.firstSeen), num(other.firstSeen)),
    lastSeen: Math.max(num(winner.lastSeen), num(other.lastSeen)),
  };
}

// ─── The merge ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Decides what the server does with one pushed entry.
 *
 * `server` is the row the server holds for `(entry.table, entry.id)`, or null. Returns:
 *  - `apply`: store `row` at `rev` with `hlc` (and insert `conflictCopy` if there is one);
 *  - `noop`: the stored row stays (and insert `conflictCopy` if there is one). `rebase` says whether the pusher must be
 *    given the stored row; a `replay` is answered with the stored revision instead;
 *  - `reject`: refuse this entry only.
 */
export function mergeEntry(server: ServerRow | null, entry: ChangeEntry, ctx: MergeContext): MergeResult {
  // 1. The entry itself
  if (typeof entry !== 'object' || entry === null) return reject('bad_entry', 'entry must be an object');
  if (!(SYNCED_TABLES as readonly string[]).includes(entry.table)) return reject('bad_table', `${String(entry.table)} does not sync`);
  const table = entry.table;
  const spec = TABLE_SPECS[table];
  if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 300) return reject('bad_entry', 'id must be text');
  if (!Number.isSafeInteger(entry.baseRev) || entry.baseRev < 0) return reject('bad_entry', 'baseRev must be a whole number from 0');
  if (parseHlc(entry.hlc) === null) return reject('bad_hlc', 'hlc is not a clock stamp');
  if (server !== null && (server.table !== table || server.id !== entry.id)) throw new RangeError('server row is for another entry');

  // 2. The row
  const norm = normalizeWireRow(table, entry.row);
  if (!norm.ok) return reject(norm.code, norm.message);
  const incoming = norm.row;
  if (str(incoming[spec.idField]) !== entry.id) return reject('id_mismatch', `${spec.idField} does not match the entry id`);

  // 3. What the server accepts at all
  const state = (id: string) => ctx.documentState?.(id) ?? 'known';
  if (table === 'documents') {
    if (entry.label !== 'learning') return reject('not_learning', 'only documents labelled learning are accepted');
    if (state(entry.id) === 'forgotten') return reject('forgotten', 'this document was forgotten');
  } else if (spec.documentField !== null) {
    const documentId = str(incoming[spec.documentField]);
    const s = state(documentId);
    if (s === 'forgotten') return reject('forgotten', 'this document was forgotten');
    if (s === 'unknown') return reject('unknown_document', 'the server does not hold this document yet', true);
  }
  if (table === 'settings' && !isSyncableSetting(entry.id)) return reject('setting_not_syncable', 'this setting stays on the computer');

  // 4. Who may write what
  const fromClaude = ctx.device === CLAUDE_DEVICE;
  if (fromClaude) {
    if (table !== 'threads' && table !== 'comments' && table !== 'marks') return reject('claude_scope', 'the claude device writes notes only');
    if (table !== 'threads' && incoming.author !== 'claude') return reject('claude_scope', 'the claude device writes only rows it authored');
  }
  if (server !== null) {
    if ((table === 'marks' || table === 'comments') && server.row.author !== incoming.author) return reject('author_changed', 'author never changes');
  }

  const stamp = clampHlc(entry.hlc, ctx.now);

  // 5. A new row
  if (server === null) {
    return { kind: 'apply', row: incoming, hlc: stamp, rev: 1, rebase: norm.adjusted || stamp !== entry.hlc, why: 'created', conflictCopy: null };
  }

  // 6. A retry of a push that already applied (or a second device that made the same change). A same-content entry with a
  //    newer stamp is a real, later change (a delete then a restore): it must raise the stored stamp, or a later change
  //    could lose to an earlier one depending on push order (spec: "the later change wins").
  if (sameRow(table, server.row, incoming) && compareStamps(stamp, server.hlc) <= 0) return { kind: 'noop', why: 'replay', rebase: false, conflictCopy: null };
  // ...or an entry the server has already processed, replayed after the row moved on
  const done = ctx.processedUpTo?.(table, entry.id) ?? null;
  if (done !== null && compareStamps(entry.hlc, done) <= 0) return { kind: 'noop', why: 'replay', rebase: true, conflictCopy: null };

  // 7. The claude device edits only rows Claude wrote
  if (fromClaude) {
    if (table === 'threads' ? server.device !== CLAUDE_DEVICE : server.row.author !== 'claude')
      return reject('claude_scope', 'the claude device edits nobody else\'s notes');
  }

  const causal = entry.baseRev === server.rev;
  const rev = server.rev + 1;
  const changed = norm.adjusted || stamp !== entry.hlc;

  // 8. Rows Claude wrote: other devices may delete or restore them, not rewrite them
  if ((table === 'marks' || table === 'comments') && server.row.author === 'claude' && !fromClaude) {
    const kept: WireRow = { ...server.row, deletedAt: incoming.deletedAt };
    if (table === 'marks') kept.updatedAt = Math.max(num(server.row.updatedAt), num(incoming.updatedAt));
    const sameButDelete = sameRow(table, { ...incoming, deletedAt: server.row.deletedAt, updatedAt: server.row.updatedAt }, server.row);
    if (!sameButDelete && causal) return reject('claude_row_readonly', 'Claude\'s notes can be deleted or restored, not edited');
    if (sameRow(table, kept, server.row)) return { kind: 'noop', why: 'claude-row-kept', rebase: true, conflictCopy: null };
    return { kind: 'apply', row: kept, hlc: maxStamp(stamp, server.hlc), rev, rebase: !sameButDelete || changed, why: 'claude-row-delete', conflictCopy: null };
  }

  // 8b. R57 (contracts CA10): the owner's delete beats a concurrent Claude edit, and Claude's newer text is kept in the
  //     tombstone, so a restore brings it back. Claude never undoes a delete made by another device.
  if (fromClaude && (table === 'marks' || table === 'comments') && isDeleted(server.row) && !isDeleted(incoming) && server.device !== CLAUDE_DEVICE) {
    return { kind: 'apply', row: { ...incoming, deletedAt: server.row.deletedAt }, hlc: maxStamp(stamp, server.hlc), rev, rebase: true, why: 'claude-row-delete', conflictCopy: null };
  }

  // 9. Tables that merge by field (these do not look at the revision)
  if (table === 'history') {
    // plan CL2: `lastPosition` from the newer stamp (a computer that opened earlier may have kept reading later)
    const newer = compareStamps(stamp, server.hlc) > 0 ? incoming : server.row;
    const merged = { ...mergeHistoryRows(server.row, incoming), lastPosition: newer.lastPosition ?? null };
    const hlc = maxStamp(stamp, server.hlc);
    if (sameRow(table, merged, server.row)) return { kind: 'noop', why: 'older', rebase: true, conflictCopy: null };
    return { kind: 'apply', row: merged, hlc, rev, rebase: !sameRow(table, merged, incoming) || changed, why: 'merged-fields', conflictCopy: null };
  }
  if (table === 'aliases') {
    // two aliases for one fingerprint: the smaller document id wins, whatever the order or the revision
    const a = str(incoming.documentId);
    const b = str(server.row.documentId);
    if (a === b) {
      const merged: WireRow = { ...server.row, createdAt: Math.min(num(server.row.createdAt), num(incoming.createdAt)), similarity: Math.max(num(server.row.similarity), num(incoming.similarity)) };
      if (sameRow(table, merged, server.row)) return { kind: 'noop', why: 'older', rebase: true, conflictCopy: null };
      return { kind: 'apply', row: merged, hlc: maxStamp(stamp, server.hlc), rev, rebase: true, why: 'merged-fields', conflictCopy: null };
    }
    if (b < a) return { kind: 'noop', why: 'smaller-document', rebase: true, conflictCopy: null };
    return { kind: 'apply', row: incoming, hlc: stamp, rev, rebase: changed, why: 'newer', conflictCopy: null };
  }

  // 10. Whole-row last writer wins
  let incomingWins: boolean;
  let why: ApplyWhy | NoopWhy;
  if (causal) {
    incomingWins = true;
    why = 'fast-forward';
  } else if (spec.softDelete && isDeleted(incoming) !== isDeleted(server.row)) {
    // an edit beats a delete, whatever the stamps say
    incomingWins = !isDeleted(incoming);
    why = incomingWins ? 'edit-beats-delete' : 'delete-loses';
  } else {
    const c = compareStamps(stamp, server.hlc);
    incomingWins = c > 0 || (c === 0 && rowKey(table, incoming) > rowKey(table, server.row));
    why = incomingWins ? 'newer' : 'older';
  }

  const copyHlc = causal ? maxStamp(stamp, server.hlc) : incomingWins ? stamp : server.hlc;
  // A device's own earlier version is superseded by its later one, not a rival: nothing to keep a copy of
  const conflictCopy =
    table === 'comments' && !causal && server.device !== ctx.device && needsCopy(incoming, server.row)
      ? incomingWins
        ? makeConflictCopy(incoming, server.row, server.device, copyHlc)
        : makeConflictCopy(server.row, incoming, ctx.device, copyHlc)
      : null;

  // The winner's row, except that two sightings of one link keep the earliest first and the latest last, whoever wins
  const result: WireRow =
    table === 'locations' ? (incomingWins ? mergeLocationRows(incoming, server.row) : mergeLocationRows(server.row, incoming)) : incomingWins ? incoming : server.row;

  // An edit that beats a newer delete keeps its own stamp (spec: "the later change wins"): with the delete's stamp, a later
  // concurrent edit would lose to this earlier one in some push orders. A losing entry never raises the stored stamp.
  const hlc = incomingWins && why === 'edit-beats-delete' ? stamp : maxStamp(stamp, server.hlc);
  // Same content is a no-op only when the stored stamp would not rise (see step 6)
  if (sameRow(table, result, server.row) && (!incomingWins || hlc === server.hlc)) return { kind: 'noop', why: incomingWins ? 'older' : (why as NoopWhy), rebase: true, conflictCopy };
  return {
    kind: 'apply',
    row: result,
    hlc,
    rev,
    rebase: changed || !sameRow(table, result, incoming),
    why: incomingWins ? (why as ApplyWhy) : 'merged-fields',
    conflictCopy,
  };
}
