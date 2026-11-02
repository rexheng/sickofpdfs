// The store's side of the online lookups (S12): which saved readings could do with a title, authors or year from arXiv or Crossref, and
// the write that puts the answer in. The lookups themselves (lookups/queue.ts) never touch the database any other way.
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends LookupsApi`, and the object it returns spreads `createLookupsApi(db, deps)`.
// `protocol.ts` serves `LOOKUPS_API_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - Only saved readings: a row of `documents`, not in Trash. A PDF that was never saved has no row, so it is never offered.
// - A reading whose text the owner keeps out of the library (`index_text` 0: a private PDF saved by choice, D9) is never offered and never
//   written to.
// - A reading is offered when it lacks a title, authors or a year, or when it was saved while the lookups were running (one check for each
//   new reading; older complete readings are left alone, so a big library is not asked about again and again).
// - A reading just saved waits `SETTLE_MS` before it is offered, which is longer than the 10 s Undo after a first mark: a save that is taken
//   back is forgotten before anything about it could be sent.
// - The write fills only what is empty and never overwrites: the title only if it has none, the authors only if there are none, the year
//   only if it has none. It is checked again inside the transaction, so a title the owner just typed is never replaced.
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import type { DocumentId, HlcStamp } from '@sop/core';
import type { StoreChange } from './change-bus';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';

/** How long a reading is left alone after it was saved, before a lookup may ask about it (longer than the 10 s Undo of a first mark). */
export const SETTLE_MS = 15_000;

/** One reading that could be filled in. */
export interface LookupItem {
  id: DocumentId;
  /** Lower case, as the library keeps it. Null when the reading has none. */
  doi: string | null;
  /** Without the version. Null when the reading has none. */
  arxivId: string | null;
  /** What the reading has now. The fill checks it again before it writes. */
  title: string | null;
  authors: string[];
  year: number | null;
}

/** The answer to `lookupNext`: the reading to ask about, or (when there is none yet) how long until one has settled. */
export interface LookupNext {
  item: LookupItem | null;
  /** When `item` is null and a reading is still settling after its save: ms until it is offered. Null when nothing is waiting. */
  waitMs: number | null;
}

/** What a lookup found, as far as the reading lacked it. Every field is optional; at least one is set. */
export interface LookupFill {
  title?: string;
  authors?: string[];
  year?: number;
}

export interface LookupsApi {
  /**
   * The next saved reading (newest first) that has a DOI or an arXiv id, saved at least `SETTLE_MS` ago, not in Trash, with its text in the
   * library, and not one of `skip`; and that either lacks a title, authors or a year, or was saved at or after `since` (a time, in ms).
   * So a reading saved while the lookups run is checked once, whether or not it lacks anything; older readings only when they lack something.
   * Null when there is none. Reads only.
   */
  lookupNext(skip: DocumentId[], since: number): Promise<LookupNext>;
  /**
   * Puts a found title, authors or year on a reading, each only if the reading has none now. Answers with the fields written (empty when
   * the reading is gone, in Trash, keeps its text out of the library, or already had them all).
   */
  lookupFill(documentId: DocumentId, found: LookupFill): Promise<('title' | 'authors' | 'year')[]>;
}

/** The method names `protocol.ts` serves and `client.ts` proxies. */
export const LOOKUPS_API_METHODS = ['lookupNext', 'lookupFill'] as const satisfies readonly (keyof LookupsApi)[];
/** The methods that only read: their answers are not kept for replays. */
export const LOOKUPS_READ_METHODS = ['lookupNext'] as const satisfies readonly (keyof LookupsApi)[];

export interface LookupsDeps {
  now(): number;
  hlc: { tick(): HlcStamp };
  publish(c: StoreChange): void;
}

class LookupsError extends Error {
  constructor(code: 'bad-input' | 'read-only', message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
/** The most readings a call may name to skip. A lookup run that has tried more than this in one browser session has bigger worries. */
const MAX_SKIP = 5000;
const MAX_TITLE = 500;
const MAX_AUTHORS = 100;
const MAX_AUTHOR = 200;

type Row = Record<string, SqlValue>;

function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

const text = (r: Row, col: string): string | null => (typeof r[col] === 'string' ? r[col] : null);

function authorsOf(r: Row): string[] {
  try {
    const v: unknown = JSON.parse(text(r, 'authors') ?? '[]');
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

const noTitle = (title: string | null): boolean => title === null || title.trim() === '';

export function createLookupsApi(db: SqlDb, deps: LookupsDeps): LookupsApi {
  return {
    lookupNext: (skip, since) =>
      attempt((): LookupNext => {
        if (!Array.isArray(skip) || skip.length > MAX_SKIP || !skip.every((s) => typeof s === 'string' && HEX64.test(s))) {
          throw new LookupsError('bad-input', 'skip is a list of reading ids');
        }
        if (!Number.isInteger(since) || since < 0) throw new LookupsError('bad-input', 'since is a time in milliseconds');
        const now = deps.now();
        const wanted = `deleted_at IS NULL AND index_text = 1
             AND ((doi IS NOT NULL AND doi <> '') OR (arxiv_id IS NOT NULL AND arxiv_id <> ''))
             AND (title IS NULL OR trim(title) = '' OR authors IN ('', '[]') OR year IS NULL OR created_at >= ?)
             AND id NOT IN (SELECT value FROM json_each(?))`;
        const binds = [since, JSON.stringify(skip)];
        const r = db.selectObjects(
          `SELECT id, doi, arxiv_id, title, authors, year FROM documents WHERE created_at <= ? AND ${wanted} ORDER BY created_at DESC, id LIMIT 1`,
          [now - SETTLE_MS, ...binds],
        )[0];
        if (r === undefined) {
          // Nothing is ready. A reading saved a moment ago is still settling: say when to look again.
          const soon = db.selectValue(`SELECT MIN(created_at) FROM documents WHERE created_at > ? AND ${wanted}`, [now - SETTLE_MS, ...binds]);
          return { item: null, waitMs: typeof soon === 'number' || typeof soon === 'bigint' ? Math.max(0, Number(soon) + SETTLE_MS - now) : null };
        }
        const doi = text(r, 'doi');
        const arxivId = text(r, 'arxiv_id');
        return {
          item: {
            id: text(r, 'id') as DocumentId,
            doi: doi === '' ? null : doi,
            arxivId: arxivId === '' ? null : arxivId,
            title: text(r, 'title'),
            authors: authorsOf(r),
            year: typeof r.year === 'number' ? r.year : null,
          },
          waitMs: null,
        };
      }),

    lookupFill: (documentId, found) =>
      attempt(() => {
        if (typeof documentId !== 'string' || !HEX64.test(documentId)) throw new LookupsError('bad-input', 'a reading id is 64 hex letters');
        if (typeof found !== 'object' || found === null) throw new LookupsError('bad-input', 'nothing to fill in');
        if (found.title !== undefined && (typeof found.title !== 'string' || found.title.trim() === '' || found.title.length > MAX_TITLE)) {
          throw new LookupsError('bad-input', 'the title is not a short piece of text');
        }
        if (
          found.authors !== undefined &&
          (!Array.isArray(found.authors) ||
            found.authors.length === 0 ||
            found.authors.length > MAX_AUTHORS ||
            !found.authors.every((a) => typeof a === 'string' && a.trim() !== '' && a.length <= MAX_AUTHOR))
        ) {
          throw new LookupsError('bad-input', 'the authors are not a short list of names');
        }
        if (found.year !== undefined && (!Number.isInteger(found.year) || found.year < 1000 || found.year > 9999)) {
          throw new LookupsError('bad-input', 'the year is not a year');
        }
        if (isReadOnly(db)) throw new LookupsError('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
        const written: ('title' | 'authors' | 'year')[] = [];
        db.savepoint(() => {
          const cur = db.selectObjects('SELECT title, authors, year FROM documents WHERE id = ? AND deleted_at IS NULL AND index_text = 1', [documentId])[0];
          if (cur === undefined) return; // gone, in Trash, or its text is kept out of the library
          const sets: string[] = [];
          const binds: SqlValue[] = [];
          if (found.title !== undefined && noTitle(text(cur, 'title'))) {
            sets.push('title = ?');
            binds.push(found.title.trim());
            written.push('title');
          }
          if (found.authors !== undefined && authorsOf(cur).length === 0) {
            sets.push('authors = ?');
            binds.push(JSON.stringify(found.authors.map((a) => a.trim())));
            written.push('authors');
          }
          if (found.year !== undefined && cur.year == null) {
            sets.push('year = ?');
            binds.push(found.year);
            written.push('year');
          }
          if (sets.length === 0) return;
          db.exec({ sql: `UPDATE documents SET ${sets.join(', ')}, updated_at = ?, hlc = ? WHERE id = ?`, bind: [...binds, deps.now(), deps.hlc.tick(), documentId] });
        });
        if (written.length > 0) {
          try {
            deps.publish({ table: 'documents', ids: [documentId], op: 'upsert', documentId });
          } catch {
            // Other tabs read the reading again the next time they need it.
          }
        }
        return written;
      }),
  };
}
