// CL5: the one set of read queries behind the web library and the connector, so they never disagree (meaning of Phase 3's local
// queries, contracts §5). Read-only: nothing here writes.
//
// Who is asking decides what is visible:
//   'owner'      the web library and the extension: every live reading, and Trash.
//   'connector'  claude.ai and Claude Code: live readings only, and never a PRIVATE one. A reading is private when its text is
//                not for search (`index_text = 0`) or it is password-protected (`encrypted = 1`). Its title, notes, history and
//                text never reach the connector, and the connector cannot tell a private reading from a missing one.
// In both: no draft, no deleted row, nothing in Trash for the connector, nothing forgotten.
import type { CommentRow, MarkRow, Sha256, ThreadRow } from '@sop/core';
import { type DbRow, dbToWire, fileNameOnly } from '@sop/core/sync';
import { type Env, textShards } from '../env';
import type { ActivityItem, DocumentSummary, LibraryItem, LibraryQuery, QueryApi, SearchHit } from '../seams';
import { decodeCursor, encodeCursor, ftsQuery, likeContains } from './fts';

export type Audience = 'owner' | 'connector';

const SNIPPET = `'', '', '…', 24`;

/** The documents a caller may see. `d` is the documents table in the query. */
export function visibleDocs(audience: Audience, trash = false): string {
  const live = trash ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL';
  const base = `${live} AND NOT EXISTS (SELECT 1 FROM forgotten f WHERE f.document_id = d.id AND d.created_at <= f.at)`;
  if (audience === 'owner') return base;
  return trash ? '0' : `${base} AND d.index_text = 1 AND d.encrypted = 0`;
}

const LIVE_COMMENT = 'c.deleted_at IS NULL AND c.draft_of_tab IS NULL';
const LIVE_THREAD = 't.deleted_at IS NULL AND t.draft_of_tab IS NULL';

type Raw = Record<string, unknown>;
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function summary(r: Raw): DocumentSummary {
  let authors: string[] = [];
  try {
    const parsed: unknown = JSON.parse(s(r.authors) || '[]');
    if (Array.isArray(parsed)) authors = parsed.filter((a): a is string => typeof a === 'string');
  } catch {
    /* none */
  }
  return {
    id: s(r.id) as Sha256,
    title: typeof r.title === 'string' ? r.title : null,
    authors,
    year: r.year === null || r.year === undefined ? null : n(r.year),
    doi: typeof r.doi === 'string' ? r.doi : null,
    arxivId: typeof r.arxiv_id === 'string' ? r.arxiv_id : null,
    kind: (['paper', 'book', 'slides', 'other'].includes(s(r.kind)) ? s(r.kind) : 'other') as DocumentSummary['kind'],
    pageCount: n(r.page_count),
    byteSize: n(r.byte_size),
    starred: n(r.starred) === 1,
    hasText: n(r.has_text) === 1,
    blobStored: n(r.blob_stored) === 1,
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : n(r.deleted_at),
  };
}

function toRow<T>(table: 'marks' | 'threads' | 'comments', raw: Raw): T {
  const w = dbToWire(table, raw as DbRow);
  return { ...w.row, rev: w.rev, hlc: w.hlc } as unknown as T;
}

const DOC_COLUMNS = 'd.id, d.title, d.authors, d.year, d.doi, d.arxiv_id, d.kind, d.page_count, d.byte_size, d.starred, d.has_text, d.blob_stored, d.created_at, d.updated_at, d.deleted_at';

const SORTS: Record<LibraryQuery['sort']['by'], string> = {
  title: "lower(COALESCE(d.title, ''))",
  lastOpened: 'COALESCE(h.last_opened, 0)',
  added: 'd.created_at',
  pages: 'd.page_count',
};

export function createQueryApi(env: Env, audience: Audience = 'owner'): QueryApi {
  const META = env.META;
  const shards = textShards(env);
  const all = async <T = Raw>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> => (await db.prepare(sql).bind(...params).all<T>()).results;
  const first = async <T = Raw>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> => (await db.prepare(sql).bind(...params).first<T>()) ?? null;

  /** Locations as the caller may see them. The connector sees a file's name, never a folder path. */
  const locationsOf = async (ids: string[]): Promise<Map<string, LibraryItem['locations']>> => {
    const out = new Map<string, LibraryItem['locations']>();
    if (ids.length === 0) return out;
    const rows = await all(META, `SELECT document_id, kind, canonical FROM locations WHERE document_id IN (${placeholders(ids.length)}) ORDER BY last_seen DESC`, ...ids);
    for (const r of rows) {
      const kind = s(r.kind) === 'file' ? 'file' : 'url';
      const canonical = kind === 'file' && audience === 'connector' ? fileNameOnly(s(r.canonical)) : s(r.canonical);
      const list = out.get(s(r.document_id)) ?? [];
      if (list.length < 10) list.push({ kind, canonical });
      out.set(s(r.document_id), list);
    }
    return out;
  };

  /** Which shard and document number hold a reading's text. */
  const textHome = async (id: string): Promise<{ db: D1Database; docnum: number; extractor: string } | null> => {
    const home = await first<{ shard: number; extractor: string; pages: number; state: string }>(META, 'SELECT shard, extractor, pages, state FROM doc_text WHERE document_id = ?', id);
    if (!home || home.state === 'no_text' || home.pages <= 0) return null;
    const db = shards[home.shard];
    if (!db) return null;
    const row = await first<{ docnum: number }>(db, 'SELECT docnum FROM shard_doc WHERE document_id = ?', id);
    return row ? { db, docnum: row.docnum, extractor: home.extractor } : null;
  };

  const visibleDoc = (id: string): Promise<Raw | null> => first(META, `SELECT ${DOC_COLUMNS}, d.index_text, d.encrypted FROM documents d WHERE d.id = ? AND ${visibleDocs(audience)}`, id);

  const api: QueryApi = {
    async search(q) {
      const match = ftsQuery(q.text);
      if (match === null) return [];
      const limit = Math.max(1, Math.min(q.limit, 50));
      const wanted = new Set<SearchHit['kind']>(q.kinds ?? ['reading', 'page', 'note']);
      const doc = q.documentId;
      const hits: SearchHit[] = [];

      if (wanted.has('reading')) {
        const rows = await all(
          META,
          `SELECT d.id, d.title, snippet(documents_fts, 1, ${SNIPPET.replace('24', '16')}) AS snip, bm25(documents_fts) AS rank
           FROM documents_fts JOIN documents d ON d.id = documents_fts.document_id
           WHERE documents_fts MATCH ? AND ${visibleDocs(audience)} ${doc ? 'AND d.id = ?' : ''} ORDER BY rank LIMIT ?`,
          ...(doc ? [match, doc, limit] : [match, limit]),
        );
        for (const r of rows) hits.push({ kind: 'reading', documentId: s(r.id) as Sha256, title: s(r.title) || 'Untitled', snippet: s(r.snip) || s(r.title), rank: n(r.rank) });
      }

      if (wanted.has('note')) {
        const rows = await all(
          META,
          `SELECT c.id AS cid, c.thread_id AS tid, c.document_id AS did, c.author, t.page_index, d.title,
                  snippet(comments_fts, 2, ${SNIPPET}) AS snip, bm25(comments_fts) AS rank
           FROM comments_fts JOIN comments c ON c.id = comments_fts.comment_id
             JOIN threads t ON t.id = c.thread_id JOIN documents d ON d.id = c.document_id
           WHERE comments_fts MATCH ? AND ${LIVE_COMMENT} AND ${LIVE_THREAD} AND ${visibleDocs(audience)} ${doc ? 'AND c.document_id = ?' : ''}
           ORDER BY rank LIMIT ?`,
          ...(doc ? [match, doc, limit] : [match, limit]),
        );
        for (const r of rows) {
          hits.push({
            kind: 'note', documentId: s(r.did) as Sha256, threadId: s(r.tid), commentId: s(r.cid), author: (s(r.author) === 'claude' ? 'claude' : 'me'),
            pageIndex: r.page_index === null ? null : n(r.page_index), snippet: s(r.snip), rank: n(r.rank),
          });
        }
      }

      if (wanted.has('page')) {
        // Each shard answers on its own; the reading's visibility lives in META, so check the hits there in one query.
        const docHome = doc ? await textHome(doc) : null;
        const targets = doc ? (docHome ? [docHome.db] : []) : shards;
        const found: { documentId: string; pageIndex: number; snippet: string; rank: number }[] = [];
        for (const db of targets) {
          const rows = await all(
            db,
            `SELECT p.document_id, p.page_index, snippet(page_fts, 0, ${SNIPPET}) AS snip, bm25(page_fts) AS rank
             FROM page_fts JOIN page p ON p.id = page_fts.rowid
             WHERE page_fts MATCH ? ${doc ? 'AND p.document_id = ?' : ''} ORDER BY rank LIMIT ?`,
            ...(doc ? [match, doc, limit * 3] : [match, limit * 3]),
          );
          for (const r of rows) found.push({ documentId: s(r.document_id), pageIndex: n(r.page_index), snippet: s(r.snip), rank: n(r.rank) });
        }
        found.sort((a, b) => a.rank - b.rank);
        const ids = [...new Set(found.map((f) => f.documentId))].slice(0, 90);
        const titles = new Map<string, string>();
        if (ids.length) {
          const docs = await all(META, `SELECT d.id, d.title FROM documents d WHERE d.id IN (${placeholders(ids.length)}) AND ${visibleDocs(audience)}`, ...ids);
          for (const d of docs) titles.set(s(d.id), s(d.title) || 'Untitled');
        }
        for (const f of found) if (titles.has(f.documentId)) hits.push({ kind: 'page', documentId: f.documentId as Sha256, pageIndex: f.pageIndex, snippet: f.snippet, rank: f.rank });
      }

      hits.sort((a, b) => a.rank - b.rank);
      return hits.slice(0, limit);
    },

    async listDocuments(q) {
      const limit = Math.max(1, Math.min(q.limit, 50));
      const { o: offset } = decodeCursor(q.cursor, ['o']);
      const where: string[] = [];
      const params: unknown[] = [];
      where.push(visibleDocs(audience, q.view === 'trash'));
      if (q.view === 'recent') where.push('h.document_id IS NOT NULL');
      if (q.view === 'starred') where.push('d.starred = 1');
      const f = q.filter;
      if (f?.starred !== undefined) where.push(f.starred ? 'd.starred = 1' : 'd.starred = 0');
      if (f?.hasNotes !== undefined)
        where.push(`${f.hasNotes ? '' : 'NOT '}EXISTS (SELECT 1 FROM comments c WHERE c.document_id = d.id AND ${LIVE_COMMENT})`);
      if (f?.readFrom !== undefined) {
        where.push('h.last_opened >= ?');
        params.push(f.readFrom);
      }
      if (f?.readTo !== undefined) {
        where.push('h.last_opened <= ?');
        params.push(f.readTo);
      }
      if (f?.kind?.length) {
        where.push(`d.kind IN (${placeholders(Math.min(f.kind.length, 4))})`);
        params.push(...f.kind.slice(0, 4));
      }
      if (f?.titleContains) {
        where.push("d.title LIKE ? ESCAPE '\\'");
        params.push(likeContains(f.titleContains.slice(0, 200)));
      }
      const cond = where.join(' AND ');
      const dir = q.sort.dir === 'asc' ? 'ASC' : 'DESC';
      const order = `${SORTS[q.sort.by] ?? SORTS.added} ${dir}, d.id ${dir}`;
      const rows = await all(
        META,
        `SELECT ${DOC_COLUMNS}, h.first_opened, h.last_opened, h.reading_ms,
                (SELECT count(*) FROM comments c WHERE c.document_id = d.id AND ${LIVE_COMMENT}) AS note_count
         FROM documents d LEFT JOIN history h ON h.document_id = d.id WHERE ${cond} ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...params, limit + 1, offset,
      );
      const total = (await first<{ n: number }>(META, `SELECT count(*) AS n FROM documents d LEFT JOIN history h ON h.document_id = d.id WHERE ${cond}`, ...params))?.n ?? 0;
      const page = rows.slice(0, limit);
      const locations = await locationsOf(page.map((r) => s(r.id)));
      const items: LibraryItem[] = page.map((r) => ({
        doc: summary(r),
        firstOpened: n(r.first_opened),
        lastOpened: n(r.last_opened),
        readingMs: n(r.reading_ms),
        noteCount: n(r.note_count),
        locations: locations.get(s(r.id)) ?? [],
      }));
      return { items, nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null, total };
    },

    async getDocument(id) {
      const r = await visibleDoc(id);
      if (!r) return null;
      const locations = (await locationsOf([id])).get(id) ?? [];
      const counts = await all(
        META,
        `SELECT t.page_index AS p, count(*) AS k FROM comments c JOIN threads t ON t.id = c.thread_id
         WHERE c.document_id = ? AND ${LIVE_COMMENT} AND ${LIVE_THREAD} AND t.page_index IS NOT NULL GROUP BY t.page_index`,
        id,
      );
      const notesByPage: Record<number, number> = {};
      for (const c of counts) notesByPage[n(c.p)] = n(c.k);
      const doc = summary(r);
      const textAvailable = doc.hasText && (await textHome(id)) !== null;
      return { doc, locations, notesByPage, textAvailable };
    },

    async readPages(id, o) {
      const none = { pages: [], nextFromIndex: null };
      if (!(await visibleDoc(id))) return none;
      const home = await textHome(id);
      if (!home) return none;
      const from = Math.max(0, Math.min(o.fromIndex, 99_999));
      const to = Math.max(from, Math.min(o.toIndex, 99_999, from + 199));
      const rows = await all(home.db, 'SELECT page_index, text FROM page WHERE id BETWEEN ? AND ? ORDER BY id', home.docnum * 100_000 + from, home.docnum * 100_000 + to);
      const maxChars = Math.max(1_000, o.maxChars);
      const pages: { pageIndex: number; text: string }[] = [];
      let used = 0;
      let next: number | null = null;
      for (const r of rows) {
        let text = s(r.text);
        if (pages.length > 0 && used + text.length > maxChars) {
          next = n(r.page_index);
          break;
        }
        if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[page cut here]`;
        pages.push({ pageIndex: n(r.page_index), text });
        used += text.length;
      }
      return { pages, nextFromIndex: next };
    },

    async getAnnotations(id, o) {
      const empty = { marks: [], threads: [], nextCursor: null };
      if (!(await visibleDoc(id))) return empty;
      const limit = Math.max(1, Math.min(o.limit, 100));
      const cur = decodeCursor(o.cursor, ['m', 't']);
      const author = o.author && o.author !== 'any' ? o.author : null;
      const ranged = o.pageFrom !== undefined || o.pageTo !== undefined;
      const lo = o.pageFrom ?? 0;
      const hi = o.pageTo ?? 99_999;

      const markRows = await all(
        META,
        `SELECT * FROM marks WHERE document_id = ? AND deleted_at IS NULL ${ranged ? 'AND page_index BETWEEN ? AND ?' : ''} ${author ? 'AND author = ?' : ''}
         ORDER BY page_index, sort_key, id LIMIT ? OFFSET ?`,
        ...[id, ...(ranged ? [lo, hi] : []), ...(author ? [author] : []), limit + 1, cur.m]);

      const rootAuthor = `(SELECT c.author FROM comments c WHERE c.thread_id = t.id AND ${LIVE_COMMENT} ORDER BY c.created_at, c.id LIMIT 1)`;
      const threadRows = await all(
        META,
        `SELECT t.* FROM threads t WHERE t.document_id = ? AND ${LIVE_THREAD}
           AND EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = t.id AND ${LIVE_COMMENT})
           ${ranged ? 'AND t.page_index BETWEEN ? AND ?' : ''} ${author ? `AND ${rootAuthor} = ?` : ''}
         ORDER BY t.page_index IS NULL, t.page_index, t.sort_key, t.id LIMIT ? OFFSET ?`,
        ...[id, ...(ranged ? [lo, hi] : []), ...(author ? [author] : []), limit + 1, cur.t]);

      const shownThreads = threadRows.slice(0, limit);
      const comments = shownThreads.length
        ? await all(META, `SELECT c.* FROM comments c WHERE c.thread_id IN (${placeholders(shownThreads.length)}) AND ${LIVE_COMMENT} ORDER BY c.created_at, c.id`, ...shownThreads.map((t) => s(t.id)))
        : [];
      const byThread = new Map<string, CommentRow[]>();
      for (const c of comments) {
        const row = toRow<CommentRow>('comments', c);
        const list = byThread.get(row.threadId) ?? [];
        list.push(row);
        byThread.set(row.threadId, list);
      }
      const more = markRows.length > limit || threadRows.length > limit;
      return {
        marks: markRows.slice(0, limit).map((m) => toRow<MarkRow>('marks', m)),
        threads: shownThreads.map((t) => {
          const thread = toRow<ThreadRow>('threads', t);
          return { thread, comments: byThread.get(thread.id) ?? [] };
        }),
        nextCursor: more ? encodeCursor({ m: cur.m + Math.min(markRows.length, limit), t: cur.t + shownThreads.length }) : null,
      };
    },

    async recentActivity(o) {
      const limit = Math.max(1, Math.min(o.limit, 100));
      const since = Date.now() - Math.max(1, Math.min(o.days, 365)) * 86_400_000;
      const vis = visibleDocs(audience);
      const items: ActivityItem[] = [];
      const opened = await all(META, `SELECT h.document_id AS did, h.last_opened AS at, COALESCE(d.title, 'Untitled') AS title FROM history h JOIN documents d ON d.id = h.document_id WHERE h.last_opened >= ? AND ${vis} ORDER BY h.last_opened DESC LIMIT ?`, since, limit);
      for (const r of opened) items.push({ at: n(r.at), kind: 'opened', documentId: s(r.did) as Sha256, title: s(r.title) });
      const added = await all(META, `SELECT d.id AS did, d.created_at AS at, COALESCE(d.title, 'Untitled') AS title FROM documents d WHERE d.created_at >= ? AND ${vis} ORDER BY d.created_at DESC LIMIT ?`, since, limit);
      for (const r of added) items.push({ at: n(r.at), kind: 'added', documentId: s(r.did) as Sha256, title: s(r.title) });
      const notes = await all(
        META,
        `SELECT c.document_id AS did, c.created_at AS at, c.author, t.page_index, substr(c.body, 1, 240) AS snip, COALESCE(d.title, 'Untitled') AS title
         FROM comments c JOIN threads t ON t.id = c.thread_id JOIN documents d ON d.id = c.document_id
         WHERE c.created_at >= ? AND ${LIVE_COMMENT} AND ${LIVE_THREAD} AND ${vis} ORDER BY c.created_at DESC LIMIT ?`,
        since, limit,
      );
      for (const r of notes) {
        items.push({
          at: n(r.at), kind: s(r.author) === 'claude' ? 'claude-note' : 'note', documentId: s(r.did) as Sha256, title: s(r.title),
          ...(r.page_index === null ? {} : { pageIndex: n(r.page_index) }), snippet: s(r.snip),
        });
      }
      items.sort((a, b) => b.at - a.at);
      return items.slice(0, limit);
    },

    async listNotes(o) {
      const limit = Math.max(1, Math.min(o.limit, 100));
      const { o: offset } = decodeCursor(o.cursor, ['o']);
      const rootAuthor = `(SELECT c.author FROM comments c WHERE c.thread_id = t.id AND ${LIVE_COMMENT} ORDER BY c.created_at, c.id LIMIT 1)`;
      const rows = await all(
        META,
        `SELECT t.*, COALESCE(d.title, 'Untitled') AS doc_title FROM threads t JOIN documents d ON d.id = t.document_id
         WHERE ${LIVE_THREAD} AND ${visibleDocs(audience)} AND EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = t.id AND ${LIVE_COMMENT})
           ${o.author ? `AND ${rootAuthor} = ?` : ''} ORDER BY t.updated_at DESC, t.id LIMIT ? OFFSET ?`,
        ...[...(o.author ? [o.author] : []), limit + 1, offset],
      );
      const shown = rows.slice(0, limit);
      const comments = shown.length ? await all(META, `SELECT c.* FROM comments c WHERE c.thread_id IN (${placeholders(shown.length)}) AND ${LIVE_COMMENT} ORDER BY c.created_at, c.id`, ...shown.map((t) => s(t.id))) : [];
      const byThread = new Map<string, CommentRow[]>();
      for (const c of comments) {
        const row = toRow<CommentRow>('comments', c);
        byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), row]);
      }
      return {
        items: shown.map((t) => {
          const thread = toRow<ThreadRow>('threads', t);
          return { thread, comments: byThread.get(thread.id) ?? [], title: s(t.doc_title) };
        }),
        nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null,
      };
    },
  };
  return api;
}

/** The text of one page, with where it came from. For anchoring a comment (CL6); the caller has already checked the reading is visible. */
export async function pageText(env: Env, documentId: string, pageIndex: number): Promise<{ text: string; source: string } | null> {
  const home = await env.META.prepare('SELECT shard, state, pages FROM doc_text WHERE document_id = ?').bind(documentId).first<{ shard: number; state: string; pages: number }>();
  if (!home || home.state === 'no_text') return null;
  const db = textShards(env)[home.shard];
  if (!db) return null;
  const d = await db.prepare('SELECT docnum FROM shard_doc WHERE document_id = ?').bind(documentId).first<{ docnum: number }>();
  if (!d) return null;
  const row = await db.prepare('SELECT text, source FROM page WHERE id = ?').bind(d.docnum * 100_000 + pageIndex).first<{ text: string; source: string }>();
  return row ? { text: row.text, source: row.source } : null;
}

/** Titles for some readings the caller may see (a hit list names its readings). Anything not visible is simply missing from the map. */
export async function titlesOf(env: Env, ids: string[], audience: Audience): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)].slice(0, 90);
  if (unique.length === 0) return out;
  const rows = await env.META.prepare(`SELECT d.id, d.title FROM documents d WHERE d.id IN (${placeholders(unique.length)}) AND ${visibleDocs(audience)}`).bind(...unique).all<{ id: string; title: string | null }>();
  for (const r of rows.results) out.set(r.id, r.title || 'Untitled');
  return out;
}
