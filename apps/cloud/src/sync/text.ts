// Page text (contracts §7: it never travels in a push). `PUT /api/text/:sha` stores up to 200 pages at a time; `GET` reads them
// back for a restore. A document's text lives in one shard, recorded in `doc_text`: a new document goes to the emptiest shard,
// and a different `extractor` (OCR finishing, an engine upgrade) replaces that document's pages.
//
// Order, so a failure halfway never puts one document in two shards: `doc_text` names the shard first, then the shard is
// written in one batch, then `doc_text` gets the page count and state. Page ids are `docnum * 100000 + pageIndex`.

import type { Env } from '../env';
import { textShards } from '../env';
import { QuotaError, addUsage, allowed, rowsWritten, usageStatement } from './meter';

export const MAX_TEXT_BODY = 1_048_576;
const MAX_PAGES_PER_PUT = 200;
const MAX_PAGE_CHARS = 200_000;

export interface TextPut {
  extractor: string;
  pages: { pageIndex: number; text: string }[];
  /** The last chunk: every page has been sent. */
  complete?: boolean;
}

export class TextError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TextError';
  }
}

export function parseTextPut(body: unknown): TextPut {
  const b = body as Partial<TextPut> | null;
  if (!b || typeof b !== 'object') throw new TextError(400, 'bad_body', 'Send { extractor, pages, complete }.');
  if (typeof b.extractor !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(b.extractor)) throw new TextError(400, 'bad_extractor', 'extractor must be short plain text, like pdfium or ocr:tesseract@5');
  if (!Array.isArray(b.pages) || b.pages.length > MAX_PAGES_PER_PUT) throw new TextError(400, 'bad_pages', `pages must be a list of at most ${MAX_PAGES_PER_PUT}`);
  const seen = new Set<number>();
  for (const p of b.pages) {
    if (!p || !Number.isSafeInteger(p.pageIndex) || p.pageIndex < 0 || p.pageIndex >= 100_000 || typeof p.text !== 'string' || p.text.length > MAX_PAGE_CHARS || seen.has(p.pageIndex)) {
      throw new TextError(400, 'bad_pages', 'each page needs a unique 0-based pageIndex and its text');
    }
    seen.add(p.pageIndex);
  }
  return { extractor: b.extractor, pages: b.pages, complete: b.complete === true };
}

export async function putText(env: Env, sha: string, put: TextPut): Promise<{ pages: number; state: 'partial' | 'complete' }> {
  const db = env.META;
  const now = Date.now();
  const [docR, forgotR, textR, usageR, shardsR] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT page_count, has_text, index_text, encrypted FROM documents WHERE id = ?').bind(sha),
    // forgotten, and not saved again since (a save after the Forget is a new reading)
    db.prepare('SELECT 1 AS x FROM forgotten f WHERE f.document_id = ? AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = f.document_id AND d.created_at > f.at)').bind(sha),
    db.prepare('SELECT shard, extractor FROM doc_text WHERE document_id = ?').bind(sha),
    usageStatement(env, now),
    db.prepare('SELECT shard, SUM(pages) AS pages FROM doc_text GROUP BY shard'),
  ]);
  if (forgotR?.results.length) throw new TextError(410, 'forgotten', 'This document was forgotten.');
  const doc = docR?.results[0] as { page_count: number; has_text: number; index_text: number; encrypted: number } | undefined;
  if (!doc) throw new TextError(404, 'unknown_document', 'Push the document before its text.');
  // CD2: a password-protected PDF's text stays on the computer; a reading set to "do not index" sends none
  if (doc.encrypted === 1 || doc.index_text === 0) throw new TextError(409, 'text_stays_local', 'This document\'s text stays on your computer.');
  if (put.pages.some((p) => p.pageIndex >= doc.page_count)) throw new TextError(400, 'bad_pages', 'a pageIndex is past the last page');
  if (!allowed(env, 'text', usageR?.results[0] as { text_rows: number; note_rows: number } | undefined)) throw new QuotaError('text');

  const shards = textShards(env);
  let shardNo: number;
  const existing = textR?.results[0] as { shard: number; extractor: string } | undefined;
  if (existing && existing.shard < shards.length) shardNo = existing.shard;
  else {
    const used = new Map((shardsR?.results ?? []).map((r) => [Number(r.shard), Number(r.pages ?? 0)]));
    shardNo = 0;
    for (let i = 1; i < shards.length; i++) if ((used.get(i) ?? 0) < (used.get(shardNo) ?? 0)) shardNo = i;
  }
  const shard = shards[shardNo];
  if (!shard) throw new Error('no text shard is bound');

  // 1. Name the shard (and the extractor) before writing it
  const head = await db
    .prepare("INSERT INTO doc_text (document_id, shard, extractor, pages, state) VALUES (?, ?, ?, 0, 'partial') ON CONFLICT(document_id) DO UPDATE SET extractor = excluded.extractor, state = CASE WHEN doc_text.extractor = excluded.extractor THEN doc_text.state ELSE 'partial' END")
    .bind(sha, shardNo, put.extractor)
    .run();

  // 2. The shard, in one batch. Old pages go when the extractor changed; an unchanged page is not written again.
  const range = '(SELECT docnum * 100000 FROM shard_doc WHERE document_id = ?1)';
  const shardResults = await shard.batch([
    shard.prepare('INSERT INTO shard_doc (document_id, pages, extractor) VALUES (?1, 0, ?2) ON CONFLICT(document_id) DO NOTHING').bind(sha, put.extractor),
    shard.prepare(`DELETE FROM page WHERE id >= ${range} AND id < ${range} + 100000 AND (SELECT extractor FROM shard_doc WHERE document_id = ?1) IS NOT ?2`).bind(sha, put.extractor),
    shard.prepare('UPDATE shard_doc SET extractor = ?2 WHERE document_id = ?1').bind(sha, put.extractor),
    ...put.pages.map((p) =>
      shard
        .prepare(
          'INSERT INTO page (id, document_id, page_index, text, source) SELECT docnum * 100000 + ?2, ?1, ?2, ?3, ?4 FROM shard_doc WHERE document_id = ?1 ' +
            'ON CONFLICT(id) DO UPDATE SET text = excluded.text, source = excluded.source WHERE page.text IS NOT excluded.text OR page.source IS NOT excluded.source',
        )
        .bind(sha, p.pageIndex, p.text, put.extractor),
    ),
    shard.prepare(`UPDATE shard_doc SET pages = (SELECT count(*) FROM page WHERE id >= ${range} AND id < ${range} + 100000) WHERE document_id = ?1`).bind(sha),
    shard.prepare('SELECT pages FROM shard_doc WHERE document_id = ?1').bind(sha),
  ]);
  const pages = Number((shardResults[shardResults.length - 1]?.results[0] as { pages?: number } | undefined)?.pages ?? 0);
  const state = put.complete === true ? 'complete' : 'partial';

  // 3. The count and the state
  const tail = await db.prepare('UPDATE doc_text SET pages = ?, state = ? WHERE document_id = ?').bind(pages, state, sha).run();
  await addUsage(env, 'text', rowsWritten([head, ...shardResults, tail]), now);
  return { pages, state };
}

export async function getText(env: Env, sha: string, from: number, limit: number): Promise<{ documentId: string; extractor: string; state: string; pages: { pageIndex: number; text: string; source: string }[]; nextFrom: number | null } | null> {
  const t = await env.META.prepare('SELECT shard, extractor, state FROM doc_text WHERE document_id = ?').bind(sha).first<{ shard: number; extractor: string; state: string }>();
  const shard = t ? textShards(env)[t.shard] : undefined;
  if (!t || !shard) return null;
  const r = await shard
    .prepare('SELECT page_index, text, source FROM page WHERE id >= (SELECT docnum * 100000 FROM shard_doc WHERE document_id = ?1) + ?2 AND id < (SELECT docnum * 100000 + 100000 FROM shard_doc WHERE document_id = ?1) ORDER BY id LIMIT ?3')
    .bind(sha, from, limit + 1)
    .all<{ page_index: number; text: string; source: string }>();
  const pages: { pageIndex: number; text: string; source: string }[] = [];
  let bytes = 0;
  let nextFrom: number | null = null;
  for (const p of r.results) {
    if (pages.length >= limit || (pages.length > 0 && bytes + p.text.length > 4_000_000)) {
      nextFrom = p.page_index;
      break;
    }
    pages.push({ pageIndex: p.page_index, text: p.text, source: p.source });
    bytes += p.text.length;
  }
  return { documentId: sha, extractor: t.extractor, state: t.state, pages, nextFrom };
}
