// Emptying the Trash (contracts §2 and D8). Trash keeps removed readings and notes for 30 days; this file ends that.
//
// For a reading, purging is the same as "Forget this PDF" (R13): the document and everything that hangs off it, every outbox
// row naming any of it, the saved copy of the PDF, and the deleted words in the search indexes. No row, outbox row, index term
// or file is left.
//
// For a note, purging blanks the text of every comment in a thread that has sat in Trash for 30 days, and of a single
// comment that was deleted that long ago. The rows stay as tombstones, because sync needs them (contracts §2).
//
// Rules this file keeps:
// - A reading with a note made after it went to Trash is not purged (say the same PDF was opened again and marked up). It
//   stays in Trash, where it can be restored, rather than lose that note.
// - The saved copy goes first. If a copy cannot be removed, that reading stays in Trash and is tried again at the next run, so
//   a PDF copy is never left behind without a row to find it by.
// - The rows go in one transaction, and their change events are published only after it commits.
// - It runs inside the store worker's own request queue (see `startDailyPurge`), so a restore cannot slip in between steps.
import type { DocumentId, HlcStamp } from '@sop/core';
import type { StoreChange } from './change-bus';
import { FTS_TABLES } from './schema';
import type { SqlDb } from './schema-v2';

/** Days a removed reading or note stays in Trash. */
export const TRASH_KEEP_DAYS = 30;
export const TRASH_KEEP_MS = TRASH_KEEP_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrashDeps {
  hlc: { tick(): HlcStamp };
  publish(c: StoreChange): void;
  /** Removes every file kept for a document (its saved PDF and thumbnail). Absent where there is no file storage, as in Node tests. */
  deleteBlob?(id: DocumentId): Promise<void>;
}

type Row = Record<string, unknown>;
const str = (r: Row, col: string): string => String(r[col]);

/** True when something the person wrote (a mark, thread or comment) was made or changed after the document went to Trash. */
const WRITTEN_AFTER_TRASH = `(
  EXISTS (SELECT 1 FROM marks m WHERE m.document_id = d.id AND m.updated_at > d.deleted_at)
  OR EXISTS (SELECT 1 FROM threads t WHERE t.document_id = d.id AND t.draft_of_tab IS NULL AND t.updated_at > d.deleted_at)
  OR EXISTS (SELECT 1 FROM comments c WHERE c.document_id = d.id AND c.draft_of_tab IS NULL AND (c.created_at > d.deleted_at OR coalesce(c.edited_at, 0) > d.deleted_at)))`;

/** The ids of every row that names these documents or hangs off them, the documents' own ids included. */
function idsOf(db: SqlDb, documentIds: readonly string[]): string[] {
  const list = JSON.stringify(documentIds);
  const ids = new Set<string>(documentIds);
  for (const sql of [
    'SELECT sha256 AS id FROM aliases WHERE document_id IN (SELECT value FROM json_each(?))',
    'SELECT id FROM locations WHERE document_id IN (SELECT value FROM json_each(?))',
    'SELECT id FROM marks WHERE document_id IN (SELECT value FROM json_each(?))',
    'SELECT id FROM threads WHERE document_id IN (SELECT value FROM json_each(?))',
    'SELECT id FROM comments WHERE document_id IN (SELECT value FROM json_each(?))',
  ]) {
    for (const r of db.selectObjects(sql, [list])) ids.add(str(r, 'id'));
  }
  return [...ids];
}

/** FTS5 'optimize': merges an index into one fresh segment, so deleted words are gone from the index files too (R13). */
function optimize(db: SqlDb, tables: readonly string[]): void {
  for (const t of tables) db.exec(`INSERT INTO ${t} (${t}) VALUES ('optimize')`);
}

/**
 * Forgets every reading that has been in Trash since before `olderThan`, and blanks the notes that have. Returns nothing:
 * the published change events say what went. A reading whose saved copy cannot be removed stays for the next run.
 */
export async function purgeTrashRows(db: SqlDb, deps: TrashDeps, olderThan: number): Promise<void> {
  // 1. The readings that are due.
  const due = db
    .selectObjects(
      `SELECT d.id AS id FROM documents d WHERE d.deleted_at IS NOT NULL AND d.deleted_at < ? AND NOT ${WRITTEN_AFTER_TRASH} ORDER BY d.deleted_at, d.id`,
      [olderThan],
    )
    .map((r) => str(r, 'id'));

  // 2. Their saved copies first. A copy that cannot be removed keeps its reading in Trash.
  const copiesGone: string[] = [];
  for (const id of due) {
    try {
      await deps.deleteBlob?.(id as DocumentId);
      copiesGone.push(id);
    } catch {
      // Tried again at the next run.
    }
  }

  // 3. The rows, in one transaction.
  const forgotten: string[] = [];
  const blanked = new Map<string, string[]>();
  db.savepoint((tx) => {
    if (copiesGone.length > 0) {
      // Still in Trash and still old enough: a restore may have come in while the copies were being removed.
      const still = tx
        .selectObjects(
          `SELECT d.id AS id FROM documents d WHERE d.id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NOT NULL AND d.deleted_at < ?
             AND NOT ${WRITTEN_AFTER_TRASH}`,
          [JSON.stringify(copiesGone), olderThan],
        )
        .map((r) => str(r, 'id'));
      if (still.length > 0) {
        const ids = idsOf(tx, still);
        // The cascade removes aliases, locations, page text, marks, threads, comments, edits, history and the figure cache; the
        // index triggers remove their words from page_text_fts, documents_fts and comments_fts.
        tx.exec({ sql: 'DELETE FROM documents WHERE id IN (SELECT value FROM json_each(?))', bind: [JSON.stringify(still)] });
        // Every outbox row naming any of them, including the delete rows the cascade itself just queued.
        tx.exec({ sql: 'DELETE FROM outbox WHERE row_id IN (SELECT value FROM json_each(?))', bind: [JSON.stringify(ids)] });
        forgotten.push(...still);
      }
    }

    // 4. Notes that have been in Trash that long: blank the text, keep the row.
    const stale = tx.selectObjects(
      `SELECT c.id AS id, c.document_id AS document_id FROM comments c JOIN threads t ON t.id = c.thread_id
       WHERE c.body <> '' AND c.draft_of_tab IS NULL
         AND ((c.deleted_at IS NOT NULL AND c.deleted_at < ?) OR (t.deleted_at IS NOT NULL AND t.deleted_at < ?))
       ORDER BY c.id`,
      [olderThan, olderThan],
    );
    for (const r of stale) {
      tx.exec({ sql: `UPDATE comments SET body = '', hlc = ? WHERE id = ?`, bind: [deps.hlc.tick(), str(r, 'id')] });
      const doc = str(r, 'document_id');
      blanked.set(doc, [...(blanked.get(doc) ?? []), str(r, 'id')]);
    }
    if (stale.length > 0) {
      // An unsent edit of a blanked comment is text too.
      tx.exec({
        sql: 'DELETE FROM comment_edits WHERE comment_id IN (SELECT value FROM json_each(?))',
        bind: [JSON.stringify(stale.map((r) => str(r, 'id')))],
      });
    }

    // 5. Merge the indexes into fresh segments, so the removed words are gone from the index files too.
    if (forgotten.length > 0) optimize(tx, FTS_TABLES);
    else if (stale.length > 0) optimize(tx, ['comments_fts']);
  });

  for (const id of forgotten) {
    try {
      deps.publish({ table: 'documents', ids: [id], op: 'delete', documentId: id as DocumentId });
    } catch {
      // The purge is committed. Other tabs catch up on their next read.
    }
  }
  for (const [documentId, ids] of blanked) {
    if (forgotten.includes(documentId)) continue;
    try {
      deps.publish({ table: 'comments', ids, op: 'upsert', documentId: documentId as DocumentId });
    } catch {
      // As above.
    }
  }
}

export interface DailyPurgeOptions {
  /** The first run waits this long, so the store's first requests are not queued behind it. Default 5 s. */
  firstRunDelayMs?: number;
  /** Time between runs. Default one day. */
  everyMs?: number;
  /** How long Trash keeps things. Default 30 days. */
  keepMs?: number;
  now?: () => number;
}

/**
 * Runs the purge once shortly after the store starts, and then once a day while it lives. Requests go through the store
 * server's own queue (a loop-back port), so they are serialised with every other request and a restore cannot interleave.
 * A failed run is ignored: a library that is read-only (written by a newer version) cannot be purged, and any other failure
 * is simply tried again at the next run. Returns the function that stops it.
 */
export function startDailyPurge(server: { attach(port: MessagePort): void }, o: DailyPurgeOptions = {}): () => void {
  const now = o.now ?? Date.now;
  const keepMs = o.keepMs ?? TRASH_KEEP_MS;
  const channel = new MessageChannel();
  server.attach(channel.port1);
  let next = 1;
  // The server answers every request; this only has to drop the answers.
  channel.port2.onmessage = () => undefined;
  const run = (): void => {
    try {
      channel.port2.postMessage({ id: next++, method: 'purgeTrash', args: [now() - keepMs] });
    } catch {
      // The port is closed: the purger was stopped.
    }
  };
  const first = setTimeout(run, o.firstRunDelayMs ?? 5000);
  const every = setInterval(run, o.everyMs ?? DAY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
    channel.port1.close();
    channel.port2.close();
  };
}
