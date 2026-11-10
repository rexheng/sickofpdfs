// Deletes that sync (CL11). Most synced tables have soft deletes (`deletedAt`), so a delete is just a later version of the row.
// Five small tables do not: a reading's tags (`reading_tags`), the auto tags taken off a reading (`auto_tag_removed`), settings
// (a course placement `course.of.<sha>`, a page order `pageOrder.of.<sha>`), locations and aliases. Without this file a row
// taken out on one computer stayed alive on the others, and came back.
//
// The rule is simple, because none of these rows is a note: the later change wins, by hybrid-clock stamp.
//   - A push says `removed: true` for a row it deleted. If the server's row is not newer, the server deletes it and keeps a
//     small marker (table, id, stamp), so every computer pulls the delete.
//   - A push of the row itself, while a marker is there, wins only when its stamp is later than the delete's (the row was
//     added again). An older one (a computer that had not heard of the delete) is answered with the delete instead.
// Notes are never deleted this way: marks, threads, comments and tags keep their soft deletes and every merge rule of merge.ts.
//
// Pure: no clock, no database.

import type { HlcStamp } from '../hlc';
import { clampHlc, compareStamps, parseHlc } from './clamp';
import { isSyncableSetting, TABLE_SPECS } from './columns';
import { documentIdsInKey } from './local';
import type { ServerRow } from './merge';
import { CLAUDE_DEVICE, type ChangeEntry, REMOVABLE_TABLES, type RejectCode, type SyncedTable } from './protocol';

/** The marker the server keeps for a row that was deleted outright. */
export interface RemovalMarker {
  table: SyncedTable;
  id: string;
  /** The row's revision after the delete (the deleted row's plus one). */
  rev: number;
  hlc: HlcStamp;
  device: string;
}

export type RemovalResult =
  /** Delete the stored row (if any) and keep a marker at `rev` and `hlc`. */
  | { kind: 'remove'; rev: number; hlc: HlcStamp }
  /** The stored row is newer than the delete: it stays, and the device gets it back. */
  | { kind: 'keep' }
  /** Already gone (a retry, or a row the server never held): acknowledge, change nothing. */
  | { kind: 'ack' }
  | { kind: 'reject'; code: RejectCode; message: string; retryable: boolean };

export interface RemovalContext {
  device: string;
  now: number;
  documentState?(documentId: string): 'known' | 'unknown' | 'forgotten';
}

/** The document a removable row belongs to, from what the server holds (or, for a reading's tag, its id `<documentId>:<tagId>`). */
export function documentOfRemovable(table: SyncedTable, id: string, server: ServerRow | null): string | null {
  if (table === 'settings') return documentIdsInKey(id)[0] ?? null;
  if (table === 'reading_tags' || table === 'auto_tag_removed') return /^[0-9a-f]{64}:/.test(id) ? id.slice(0, 64) : null;
  const f = TABLE_SPECS[table].documentField;
  const v = f !== null && server !== null ? server.row[f] : null;
  return typeof v === 'string' ? v : null;
}

/** The wire form of a removal: the entry a device sends, or the one a pull or a rebase hands out. Only the id field. */
export function removalRow(table: SyncedTable, id: string): Record<string, unknown> {
  return { [TABLE_SPECS[table].idField]: id };
}

/** A pushed `removed: true` entry, against the stored row (null when there is none, or only a marker: then it is a retry). */
export function judgeRemoval(server: ServerRow | null, entry: ChangeEntry, ctx: RemovalContext): RemovalResult {
  const reject = (code: RejectCode, message: string, retryable = false): RemovalResult => ({ kind: 'reject', code, message, retryable });
  if (!REMOVABLE_TABLES.has(entry.table)) return reject('bad_table', `a ${String(entry.table)} row is not deleted this way`);
  if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 300) return reject('bad_entry', 'id must be text');
  if (!Number.isSafeInteger(entry.baseRev) || entry.baseRev < 0) return reject('bad_entry', 'baseRev must be a whole number from 0');
  if (parseHlc(entry.hlc) === null) return reject('bad_hlc', 'hlc is not a clock stamp');
  if (ctx.device === CLAUDE_DEVICE) return reject('claude_scope', 'the claude device writes notes only');
  if (entry.table === 'settings' && !isSyncableSetting(entry.id)) return reject('setting_not_syncable', 'this setting stays on the computer');
  if (server === null) return { kind: 'ack' };
  const doc = documentOfRemovable(entry.table, entry.id, server);
  if (doc !== null && ctx.documentState?.(doc) === 'forgotten') return { kind: 'ack' };

  const stamp = clampHlc(entry.hlc, ctx.now);
  // The device saw the latest version and deleted it; otherwise the later change wins
  const wins = entry.baseRev === server.rev || compareStamps(stamp, server.hlc) > 0;
  if (!wins) return { kind: 'keep' };
  const later = compareStamps(stamp, server.hlc) >= 0 ? stamp : server.hlc;
  return { kind: 'remove', rev: server.rev + 1, hlc: later };
}

/**
 * A pushed row (not a removal) for which the server holds no row but a marker: true when the delete is the later change, so
 * the row stays deleted and the device is told so. False: the row was added again after the delete, and is created.
 */
export function deleteIsLater(marker: RemovalMarker, entry: ChangeEntry, now: number): boolean {
  if (parseHlc(entry.hlc) === null) return false; // mergeEntry refuses it
  return compareStamps(clampHlc(entry.hlc, now), marker.hlc) <= 0;
}
