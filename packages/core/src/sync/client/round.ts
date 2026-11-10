// One sync round, the same on every client with a local library: push what is queued (in batches), then pull everything after
// the cursor. The local store does the database work (`LocalSyncStore`, the extension's `SyncStoreApi` fits it); this file only
// moves pages between the store and the server, in order, and stops cleanly at the first failure. The queue and the cursor are in
// the store, so a round cut off at any point simply starts again: an unacknowledged push is resent (the server sees a replay) and
// an unapplied page is pulled again.
//
// Scheduling (when to run a round), uploads of PDFs and page text, and status belong to each platform's engine (CL11).

import type { ChangeEntry, PullResponse, PushResponse, SyncedTable } from '../protocol';
import type { SyncClient } from './http';

/** One row a push carries, and how far its queue went when it was read: an ack removes only the changes up to `seqMax`. */
export interface SentMark {
  table: SyncedTable;
  id: string;
  seqMax: number;
}

export interface PushBatch {
  entries: ChangeEntry[];
  sent: SentMark[];
  /** Queued rows left out of this batch for space; collect again after the ack. */
  more: boolean;
}

export interface AckResult {
  acked: number;
  rebased: number;
  /** Entries the server refused for good: they left the queue. */
  dropped: number;
  /** Entries refused for now (`retryable`); they stay queued. */
  waiting: number;
}

export interface ApplyResult {
  applied: number;
  /** Rows with a queued local change: the server decides at the next push. */
  skipped: number;
  /** Rows waiting for a parent this computer does not hold yet. */
  parked: number;
  /** Readings forgotten here because the cloud forgot them. */
  forgotten: number;
}

/** What a sync round needs of the local store. */
export interface LocalSyncStore {
  collectPush(limit: number): Promise<PushBatch>;
  ackPush(result: PushResponse, sent: readonly SentMark[]): Promise<AckResult>;
  applyPulled(entries: PullResponse['entries'], cursor: number): Promise<ApplyResult>;
  getSyncState(key: string): Promise<string | null>;
}

export interface RoundResult {
  pushed: number;
  dropped: number;
  pulled: number;
  applied: number;
  cursor: number;
  head: number;
}

/** At most this many push batches in one round, so a huge first upload yields to a pull now and then. */
const MAX_PUSH_BATCHES = 50;

/** Push, then pull to the head. Throws the client's `SyncHttpError` on the first failure; everything done before it is kept. */
export async function runSyncRound(store: LocalSyncStore, client: SyncClient, o: { pushLimit?: number; pullLimit?: number } = {}): Promise<RoundResult> {
  const out: RoundResult = { pushed: 0, dropped: 0, pulled: 0, applied: 0, cursor: 0, head: 0 };
  for (let i = 0; i < MAX_PUSH_BATCHES; i++) {
    const batch = await store.collectPush(o.pushLimit ?? 200);
    if (batch.entries.length === 0) break;
    const res = await client.push(batch.entries);
    const ack = await store.ackPush(res, batch.sent);
    out.pushed += batch.entries.length;
    out.dropped += ack.dropped;
    // A batch whose every entry waits (a child sent before its reading) would come back the same: stop, the next round retries.
    if (!batch.more || ack.acked + ack.rebased + ack.dropped === 0) break;
  }
  let cursor = Number((await store.getSyncState('cursor')) ?? '0') || 0;
  for (;;) {
    const page = await client.pull(cursor, o.pullLimit);
    const r = await store.applyPulled(page.entries, page.cursor);
    out.pulled += page.entries.length;
    out.applied += r.applied;
    cursor = page.cursor;
    out.head = page.head;
    if (!page.more || page.entries.length === 0) break;
  }
  out.cursor = cursor;
  return out;
}
