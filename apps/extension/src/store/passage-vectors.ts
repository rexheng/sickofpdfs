// The store's side of @Claude's passage vectors (schema v6, Phase 4 slice D): the meaning vectors of a saved reading's text windows,
// kept so the next question on the reading finds its passages by meaning at once. The viewer's `VectorCache` (claude/context.ts)
// is the only caller.
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends PassageVectorsApi`, and the object it returns spreads
// `createPassageVectorsApi(db, deps)`. `protocol.ts` serves `PASSAGE_VECTORS_API_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - Local only. The table has no outbox triggers and is not a backup or export table; nothing here sends anything anywhere.
// - No text: a window is named by the SHA-256 of its text (64 lower-case hex), which the viewer works out.
// - Only readings the library may understand: live (not in Trash), with searchable text (not D9), and not saved against the filter's
//   "not learning" (R102). A write for any other reading keeps nothing; a read answers nothing.
// - Forget, the Trash purge and an Undo of a save remove the vectors with the reading (ON DELETE CASCADE).
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import type { DocumentId } from '@sop/core';
import { UNDERSTOOD } from './reading-flags';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';

export interface PassageVectorEntry {
  /** SHA-256 of the window's text, 64 lower-case hex. */
  hash: string;
  vector: Float32Array;
}

export interface PassageVectorsApi {
  /** The vectors kept for these windows of a reading, in the same order; null where none is kept (or for a reading that may not have any). */
  getPassageVectors(documentId: DocumentId, model: string, hashes: readonly string[]): Promise<(Float32Array | null)[]>;
  /** Keeps vectors of a reading's windows. Answers how many were kept (0 for a reading that may not have any). */
  putPassageVectors(documentId: DocumentId, model: string, entries: readonly PassageVectorEntry[]): Promise<number>;
}

/** The method names `protocol.ts` serves and `client.ts` proxies. */
export const PASSAGE_VECTORS_API_METHODS = ['getPassageVectors', 'putPassageVectors'] as const satisfies readonly (keyof PassageVectorsApi)[];
/** The methods that only read: their answers are not kept for replays. */
export const PASSAGE_VECTORS_READ_METHODS = ['getPassageVectors'] as const satisfies readonly (keyof PassageVectorsApi)[];

const HEX64 = /^[0-9a-f]{64}$/;
/** At most this many windows asked for, or kept, in one call. */
const MAX_PER_CALL = 2000;
/** At most this many vectors kept for one reading (about 30 MB of MiniLM vectors); a book past it stops adding. */
const MAX_PER_READING = 20_000;
const MAX_DIM = 4096;

class VectorsError extends Error {
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

function blobOf(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** A stored BLOB as a vector (a copy, so it is aligned), or null when it cannot be one. */
function vectorOf(cell: SqlValue | undefined, dim: number): Float32Array | null {
  let bytes: Uint8Array;
  if (cell instanceof Uint8Array) bytes = cell;
  else if (cell instanceof ArrayBuffer) bytes = new Uint8Array(cell);
  else if (cell instanceof Int8Array) bytes = new Uint8Array(cell.buffer, cell.byteOffset, cell.byteLength);
  else return null;
  if (bytes.byteLength !== dim * 4) return null;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function checkArgs(documentId: unknown, model: unknown): void {
  if (typeof documentId !== 'string' || !HEX64.test(documentId)) throw new VectorsError('bad-input', 'a reading id is 64 lower-case hex');
  if (typeof model !== 'string' || model.length < 1 || model.length > 64) throw new VectorsError('bad-input', 'the model is a short name');
}

function checkHashes(hashes: unknown): asserts hashes is readonly string[] {
  if (!Array.isArray(hashes) || hashes.length > MAX_PER_CALL || !hashes.every((h) => typeof h === 'string' && HEX64.test(h))) {
    throw new VectorsError('bad-input', 'hashes is a list of SHA-256 hex strings');
  }
}

function checkEntries(entries: unknown): asserts entries is readonly PassageVectorEntry[] {
  if (!Array.isArray(entries) || entries.length > MAX_PER_CALL) throw new VectorsError('bad-input', 'too many vectors in one call');
  for (const e of entries as unknown[]) {
    const r = e as Partial<PassageVectorEntry> | null;
    if (typeof r !== 'object' || r === null || typeof r.hash !== 'string' || !HEX64.test(r.hash)) throw new VectorsError('bad-input', 'each vector needs the hash of its text');
    const v = r.vector;
    if (!(v instanceof Float32Array) || v.length === 0 || v.length > MAX_DIM || v.some((x) => !Number.isFinite(x))) {
      throw new VectorsError('bad-input', 'each vector is a list of finite numbers');
    }
  }
}

export function createPassageVectorsApi(db: SqlDb): PassageVectorsApi {
  /** The reading is live, has searchable text, and was not saved against "not learning". */
  const understood = (documentId: string): boolean =>
    db.selectObjects(`SELECT 1 AS x FROM documents d WHERE d.id = ? AND d.deleted_at IS NULL AND ${UNDERSTOOD}`, [documentId]).length > 0;

  return {
    getPassageVectors: (documentId, model, hashes) =>
      attempt(() => {
        checkArgs(documentId, model);
        checkHashes(hashes);
        if (hashes.length === 0 || !understood(documentId)) return hashes.map(() => null);
        const found = new Map<string, Float32Array>();
        for (const r of db.selectObjects(
          'SELECT text_hash, dim, vector FROM passage_vectors WHERE document_id = ? AND model = ? AND text_hash IN (SELECT value FROM json_each(?))',
          [documentId, model, JSON.stringify([...new Set(hashes)])],
        )) {
          const v = vectorOf(r.vector, Number(r.dim));
          if (v && typeof r.text_hash === 'string') found.set(r.text_hash, v);
        }
        return hashes.map((h) => found.get(h) ?? null);
      }),

    putPassageVectors: (documentId, model, entries) =>
      attempt(() => {
        if (isReadOnly(db)) throw new VectorsError('read-only', 'this library was made by a newer version of sickofpdfs');
        checkArgs(documentId, model);
        checkEntries(entries);
        let kept = 0;
        db.savepoint((tx) => {
          // Forgotten, trashed or private (D9, R102) while the vectors were being made: nothing is kept.
          if (entries.length === 0 || !understood(documentId)) return;
          const have = Number(tx.selectValue('SELECT count(*) FROM passage_vectors WHERE document_id = ?', [documentId]) ?? 0);
          const room = Math.max(0, MAX_PER_READING - have);
          for (const e of entries.slice(0, room)) {
            tx.exec({
              sql: `INSERT INTO passage_vectors (document_id, text_hash, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (document_id, text_hash) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector, created_at = excluded.created_at`,
              bind: [documentId, e.hash, model, e.vector.length, blobOf(e.vector), Date.now()],
            });
            kept += 1;
          }
        });
        return kept;
      }),
  };
}
