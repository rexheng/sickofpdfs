// What "Restore from backup" needs from the database besides `applyRestorePlan` (backup-api.ts). Phase 3 S17.
//
//  - `markCopyRestored`: the restore copied a reading's PDF into the private file storage, its SHA-256 checked as it was written, so the
//    library now keeps a copy of it (`blob_stored`). That flag is local state: it is never synced and never taken from a backup, so no
//    stamp moves.
//  - `needsText`: which restored readings must have their page text read again. A backup never holds page text (contracts §5), so
//    search finds nothing in a restored reading until its text is read from its PDF (backup/reindex.ts).
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends RestoreApi`, the object it returns spreads `createRestoreApi`, and `protocol.ts`
// serves `RESTORE_API_METHODS`. Errors are rejections whose message starts with a code (`bad-input: …`), as in the rest of the store.
import type { DocumentId } from '@sop/core';
import type { StoreChange } from './change-bus';
import { isReadOnly, type SqlDb } from './schema-v2';

export interface RestoreApi {
  /**
   * The restore put this reading's PDF into the private file storage: the library keeps a copy of it now. Answers false when there is no
   * such reading here, or it was marked already. Publishes a `documents` change (origin `restore`), so the library draws its thumbnail.
   */
  markCopyRestored(documentId: DocumentId): Promise<boolean>;
  /**
   * The readings among `ids` whose page text must be read again: a copy is kept here, the PDF has text, the owner lets its text into
   * search, and the library holds text for fewer pages than it has. In the order given; at most 10,000 ids. Reads only.
   */
  needsText(ids: readonly string[]): Promise<DocumentId[]>;
}

export const RESTORE_API_METHODS = ['markCopyRestored', 'needsText'] as const satisfies readonly (keyof RestoreApi)[];
/** The methods that only read: their answers are not kept for replays. */
export const RESTORE_READ_METHODS = ['needsText'] as const satisfies readonly (keyof RestoreApi)[];

export interface RestoreDeps {
  publish(c: StoreChange): void;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_IDS = 10_000;

function fail(code: 'bad-input' | 'read-only', message: string): never {
  throw Object.assign(new Error(`${code}: ${message}`), { name: 'StoreError', code });
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

export function createRestoreApi(db: SqlDb, deps: RestoreDeps): RestoreApi {
  return {
    markCopyRestored: (documentId) =>
      attempt(() => {
        if (typeof documentId !== 'string' || !HEX64.test(documentId)) fail('bad-input', 'the document id is not a SHA-256 (64 lower-case hex characters)');
        if (isReadOnly(db)) fail('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
        let marked = false;
        db.savepoint(() => {
          const cur = db.selectValue('SELECT blob_stored FROM documents WHERE id = ?', [documentId]);
          if (cur === undefined || Number(cur) === 1) return;
          // `rev` and `hlc` stay as they are: whether a copy is kept is this computer's business only.
          db.exec({ sql: 'UPDATE documents SET blob_stored = 1 WHERE id = ?', bind: [documentId] });
          marked = true;
        });
        if (marked) {
          try {
            deps.publish({ table: 'documents', ids: [documentId], op: 'upsert', documentId, origin: 'restore' });
          } catch {
            // Written. Other tabs catch up on their next read.
          }
        }
        return marked;
      }),

    needsText: (ids) =>
      attempt(() => {
        if (!Array.isArray(ids) || ids.length > MAX_IDS) fail('bad-input', `ids is a list of at most ${MAX_IDS} fingerprints`);
        const wanted = (ids as unknown[]).filter((id): id is string => typeof id === 'string' && HEX64.test(id));
        if (wanted.length === 0) return [];
        const rows = db.selectObjects(
          `SELECT d.id AS id FROM documents d
           WHERE d.id IN (SELECT value FROM json_each(?)) AND d.blob_stored = 1 AND d.has_text = 1 AND d.index_text = 1 AND d.page_count > 0
             AND (SELECT count(*) FROM page_text p WHERE p.document_id = d.id) < d.page_count`,
          [JSON.stringify(wanted)],
        );
        const found = new Set(rows.map((r) => (typeof r.id === 'string' ? r.id : '')));
        const out: DocumentId[] = [];
        for (const id of wanted) if (found.delete(id)) out.push(id as DocumentId);
        return out;
      }),
  };
}
