// Sync wire types (contracts §7, Phase 5). The shapes of `SyncedTable`, `ChangeEntry`, `PushRequest`, `PushResponse`,
// `PullResponse` and `SyncStatus` are the contract's, unchanged. Two additions, both optional or constants only:
//   - `PushResponse.rejected` (proposed contract addition CA10, see below);
//   - the numeric limits and `RejectCode` the merge code and the server share.
//
// The local outbox (Task 28) is the queue; a `ChangeEntry` is the wire form of one queued row.

import type { HlcStamp } from '../hlc';
import type { DocumentId, Sha256 } from '../ids';

/** The v1 `SYNCED_TABLES`. Nothing else ever syncs: not drafts, `page_figures`, FTS tables or caches. */
export type SyncedTable = 'documents' | 'aliases' | 'locations' | 'marks' | 'threads' | 'comments' | 'history' | 'settings';

export const SYNCED_TABLES: readonly SyncedTable[] = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings'];

export interface ChangeEntry {
  table: SyncedTable;
  /** The wire id of the row: `sha256` for aliases, `documentId` for history, `key` for settings, `id` for the rest. */
  id: string;
  baseRev: number;
  hlc: HlcStamp;
  /** The camelCase row without `rev` (see `columns.ts`). */
  row: Record<string, unknown>;
  /** Documents only. The server refuses a document without it. */
  label?: 'learning';
}

export interface PushRequest {
  device: string;
  /** At most `MAX_PUSH_ENTRIES`. */
  entries: ChangeEntry[];
}

/**
 * Why the server refused one entry. A refusal is about that entry only; the rest of the push still applies.
 * `retryable` entries should stay queued (the thing they wait for may arrive); all others should leave the queue.
 */
export type RejectCode =
  | 'bad_entry' // not an object, bad id or base revision
  | 'bad_table'
  | 'bad_hlc'
  | 'bad_row' // a column is missing, has the wrong type or breaks a CHECK
  | 'too_large'
  | 'id_mismatch' // entry.id is not the row's own id
  | 'not_learning' // a document without label 'learning'
  | 'draft' // a draft never syncs
  | 'unknown_document' // a child row whose document the server does not hold yet (retryable)
  | 'forgotten' // the document was forgotten; nothing about it is accepted again
  | 'author_changed'
  | 'claude_scope' // the claude device wrote something it may not write
  | 'claude_row_readonly' // a device edited a row Claude wrote (it may only delete or restore it)
  | 'setting_not_syncable';

export interface RejectedEntry {
  table: SyncedTable;
  id: string;
  code: RejectCode;
  message: string;
  retryable: boolean;
}

export interface PushResponse {
  applied: { table: SyncedTable; id: string; rev: number; seq: number }[];
  rebased: (ChangeEntry & { rev: number; seq: number })[];
  needBlobs: Sha256[];
  needText: DocumentId[];
  /**
   * Proposed contract addition (CA10), optional so the §7 shape still holds. Without it a permanently refused entry (a
   * receipt that was labelled by mistake, a draft) would stay in the outbox for ever and "N not yet synced" would never
   * reach 0. The controller ratifies or replaces it.
   */
  rejected?: RejectedEntry[];
}

export interface PullResponse {
  entries: (ChangeEntry & { rev: number; seq: number; device: string })[];
  cursor: number;
  head: number;
  more: boolean;
}

export interface SyncStatus {
  state: 'off' | 'ok' | 'syncing' | 'offline' | 'stopped' | 'signed-out' | 'quota';
  unsynced: number;
  lastSyncAt: number | null;
  message: string | null;
}

/** A push carries at most this many entries (contracts §7; research 05 §8.2). */
export const MAX_PUSH_ENTRIES = 200;

/** A pull page never holds more than this many entries. */
export const MAX_PULL_LIMIT = 500;

/** The server pulls a stamp back to its own clock when it is more than this far ahead (contracts §7: 5 minutes). */
export const MAX_HLC_SKEW_MS = 5 * 60 * 1000;

/** The device id of the claude.ai connector. It writes only rows with `author = 'claude'` and edits nobody's. */
export const CLAUDE_DEVICE = 'claude';
