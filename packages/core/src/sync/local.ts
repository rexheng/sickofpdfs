// The client side of sync, the parts that do not depend on a database: the order rows are applied in, how queued changes
// become one entry per row, how a hard-deleted note leaves as a tombstone, and how a pulled row meets the local one. Every
// sync client with a local library uses these (the extension's store worker, the Android app's copy of it).
//
// Pure: no network, no database, no clock.

import type { HlcStamp } from '../hlc';
import { type DbRow, dbToWire, TABLE_SPECS, type WireRow } from './columns';
import type { SyncedTable } from './protocol';

/** Parents before the rows that name them: a document before its notes, a tag before a reading's tags, a thread before its comments. */
export const SYNC_APPLY_ORDER: readonly SyncedTable[] = ['documents', 'aliases', 'locations', 'tags', 'reading_tags', 'auto_tag_removed', 'marks', 'threads', 'comments', 'history', 'settings'];

export const applyRank = (table: SyncedTable): number => {
  const i = SYNC_APPLY_ORDER.indexOf(table);
  return i < 0 ? SYNC_APPLY_ORDER.length : i;
};

/** One queued change, as the local outbox holds it. */
export interface QueuedChange {
  seq: number;
  table: SyncedTable;
  rowId: string;
  op: 'upsert' | 'delete';
  baseRev: number;
  hlc: HlcStamp;
  /** For a hard delete of a row with soft deletes: the row as it was (snake_case JSON). */
  rowJson: string | null;
}

/** Every queued change of one row, folded: a push sends the row once, with the base revision of its oldest queued change. */
export interface QueuedRow {
  table: SyncedTable;
  id: string;
  /** The oldest and newest queue positions. An ack removes the changes up to `seqMax` (later ones are newer edits). */
  seqMin: number;
  seqMax: number;
  baseRev: number;
  /** The newest kept copy of the row before a hard delete, if any. */
  rowJson: string | null;
}

/** Folds queued changes into one per row, parents first, then oldest first. */
export function groupQueue(changes: readonly QueuedChange[]): QueuedRow[] {
  const byRow = new Map<string, QueuedRow>();
  for (const c of [...changes].sort((a, b) => a.seq - b.seq)) {
    const key = `${c.table}\u0000${c.rowId}`;
    const g = byRow.get(key);
    if (g === undefined) byRow.set(key, { table: c.table, id: c.rowId, seqMin: c.seq, seqMax: c.seq, baseRev: c.baseRev, rowJson: c.rowJson });
    else {
      g.seqMax = c.seq;
      if (c.rowJson !== null) g.rowJson = c.rowJson;
    }
  }
  return [...byRow.values()].sort((a, b) => applyRank(a.table) - applyRank(b.table) || a.seqMin - b.seqMin);
}

/**
 * The wire row of a hard-deleted row, as a tombstone: the row as it was, with `deletedAt` set. Only tables with soft deletes have
 * one; for the others the wire cannot say "deleted", and null is returned. `at` is when the delete was queued.
 */
export function tombstoneOf(table: SyncedTable, rowJson: string | null, at: number): WireRow | null {
  if (rowJson === null || !TABLE_SPECS[table].softDelete) return null;
  let db: DbRow;
  try {
    const parsed: unknown = JSON.parse(rowJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    db = parsed as DbRow;
  } catch {
    return null;
  }
  const { row } = dbToWire(table, db);
  if (row.deletedAt === null || row.deletedAt === undefined) row.deletedAt = at;
  if ('updatedAt' in row && typeof row.updatedAt === 'number') row.updatedAt = Math.max(row.updatedAt, at);
  return row;
}

/**
 * A pulled location meeting the one this computer holds. A file location leaves as its file name only, so a pulled one never
 * overwrites a local full path: the local link fields stay, and the sightings merge (first seen the earliest, last seen the latest).
 */
export function mergePulledLocation(local: WireRow | null, pulled: WireRow): WireRow {
  if (local === null || local.kind !== 'file') return pulled;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    ...pulled,
    kind: local.kind,
    canonical: local.canonical,
    raw: local.raw,
    viaPage: local.viaPage ?? null,
    firstSeen: Math.min(num(local.firstSeen), num(pulled.firstSeen)),
    lastSeen: Math.max(num(local.lastSeen), num(pulled.lastSeen)),
  };
}

/** The 64-hex document ids a setting's key names (`course.of.<id>`), so a setting about a private reading stays with it. */
export function documentIdsInKey(key: string): string[] {
  return key.match(/[0-9a-f]{64}/g) ?? [];
}

/** What a parent of a pulled row is: the row a foreign key needs before this one can be written. */
export function parentsOf(table: SyncedTable, row: WireRow): { table: SyncedTable; id: string }[] {
  const out: { table: SyncedTable; id: string }[] = [];
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const doc = TABLE_SPECS[table].documentField;
  if (doc !== null) out.push({ table: 'documents', id: s(row[doc]) });
  if (table === 'comments') out.push({ table: 'threads', id: s(row.threadId) });
  if (table === 'reading_tags' || table === 'auto_tag_removed') out.push({ table: 'tags', id: s(row.tagId) });
  return out;
}
