// The recognised text of scanned pages (schema v7, contracts §9): one `page_ocr` row per recognised page of a saved reading,
// and the same text in `page_text` (source 'ocr:<engine>@<version>'), written in one transaction so a crash never leaves one
// without the other. The OCR service (apps/extension/src/ocr) is the writer; the viewer reads a page back when it opens a saved
// scan, and the library search, Ctrl+K and Claude read the page text.
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends PageOcrApi`, and the object it returns spreads `createPageOcrApi(db, deps)`.
// `protocol.ts` serves `PAGE_OCR_API_METHODS`, and `client.ts` proxies them.
//
// Rules this file keeps:
// - Saved readings only. A write for a reading the library does not hold keeps nothing and answers false, so nothing about a
//   PDF that is not saved (a receipt, a "not sure" scan) can reach the database, a backup or the search index.
// - The owner's "keep this reading's text out of search" (index_text = 0, D9) is kept: the page is kept for selecting and
//   marking (`page_ocr`), but its text does not go into `page_text`.
// - Local only: `page_ocr` has no outbox triggers. The page text is what the library (and Release 2's cloud) reads.
// - A reading that gets its first recognised words is marked as having text (`has_text`), so search and the categoriser treat
//   it like a text PDF.
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import { type DocumentId, type HlcStamp, type OcrPageResult, type OcrWord, ocrPlainText, ocrSource, ocrText } from '@sop/core';
import type { Rotation } from '@sop/viewer';
import type { StoreChange } from './change-bus';
import { isReadOnly, type SqlDb } from './schema-v2';

/** What `listPageOcr` answers per stored page: enough to know which pages are done, by which engine. */
export interface PageOcrSummary {
  pageIndex: number;
  engine: string;
  engineVersion: string;
  createdAt: number;
}

export interface PageOcrApi {
  /**
   * Writes the page's recognised words and, when `index` (and the reading lets its text into search), its page text, in one
   * transaction, and publishes both changes. `rotation` is the page's /Rotate (the chars are built from the words with it).
   * Answers false, and writes nothing, for a reading the library does not hold.
   */
  putPageOcr(r: OcrPageResult, o: { index: boolean; rotation?: Rotation }): Promise<boolean>;
  getPageOcr(documentId: DocumentId, pageIndex: number): Promise<OcrPageResult | null>;
  listPageOcr(documentId: DocumentId): Promise<PageOcrSummary[]>;
  /** Removes these pages' recognised text, and their page text rows that came from it. */
  deletePageOcr(documentId: DocumentId, pageIndexes: readonly number[]): Promise<void>;
  /** Marks the reading as having text (or not). Writes nothing when it already says so. */
  setHasText(documentId: DocumentId, on: boolean): Promise<void>;
}

export const PAGE_OCR_API_METHODS = ['putPageOcr', 'getPageOcr', 'listPageOcr', 'deletePageOcr', 'setHasText'] as const satisfies readonly (keyof PageOcrApi)[];
export const PAGE_OCR_READ_METHODS = ['getPageOcr', 'listPageOcr'] as const satisfies readonly (keyof PageOcrApi)[];

const HEX64 = /^[0-9a-f]{64}$/;
/** A page with more words than this is refused (a dense page has about 600). */
const MAX_WORDS = 20_000;
const MAX_NAME = 64;

class PageOcrError extends Error {
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

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function checkId(documentId: unknown): asserts documentId is DocumentId {
  if (typeof documentId !== 'string' || !HEX64.test(documentId)) throw new PageOcrError('bad-input', 'a reading id is 64 lower-case hex');
}

function checkPage(pageIndex: unknown): asserts pageIndex is number {
  if (!Number.isSafeInteger(pageIndex) || (pageIndex as number) < 0) throw new PageOcrError('bad-input', 'a page index is a whole number from 0');
}

/** The words as stored: only the fields of OcrWord, checked, so nothing else rides along into the database. */
function cleanWords(words: unknown): OcrWord[] {
  if (!Array.isArray(words) || words.length > MAX_WORDS) throw new PageOcrError('bad-input', 'the words come as a list');
  return words.map((w: unknown) => {
    const x = w as Partial<OcrWord> | null;
    const b = x?.box;
    if (typeof x?.text !== 'string' || !b || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height) || !isNum(x.confidence) || !Number.isSafeInteger(x.line) || !Number.isSafeInteger(x.block)) {
      throw new PageOcrError('bad-input', 'a word needs its text, box, confidence, line and block');
    }
    return { text: x.text, box: { x: b.x, y: b.y, width: b.width, height: b.height }, confidence: x.confidence, line: x.line!, block: x.block! };
  });
}

export function createPageOcrApi(db: SqlDb, deps: { now(): number; hlc: { tick(): HlcStamp }; publish(c: StoreChange): void }): PageOcrApi {
  const publish = (changes: StoreChange[]) => {
    for (const c of changes) {
      try {
        deps.publish(c);
      } catch {
        // The write has happened; a failed broadcast changes nothing.
      }
    }
  };
  const readOnly = () => {
    if (isReadOnly(db)) throw new PageOcrError('read-only', 'this library was made by a newer version of sickofpdfs');
  };

  const markHasText = (tx: SqlDb, documentId: DocumentId, on: boolean): boolean => {
    const row = tx.selectObjects('SELECT has_text FROM documents WHERE id = ?', [documentId])[0];
    if (!row || Number(row.has_text) === (on ? 1 : 0)) return false;
    tx.exec({ sql: 'UPDATE documents SET has_text = ?, updated_at = ?, hlc = ? WHERE id = ?', bind: [on ? 1 : 0, deps.now(), deps.hlc.tick(), documentId] });
    return true;
  };

  return {
    putPageOcr: (r, o) =>
      attempt(() => {
        readOnly();
        if (typeof r !== 'object' || r === null) throw new PageOcrError('bad-input', 'no page');
        checkId(r.documentId);
        checkPage(r.pageIndex);
        if (typeof r.engine !== 'string' || r.engine.length < 1 || r.engine.length > MAX_NAME) throw new PageOcrError('bad-input', 'the engine is a short name');
        if (typeof r.engineVersion !== 'string' || r.engineVersion.length < 1 || r.engineVersion.length > MAX_NAME) throw new PageOcrError('bad-input', 'the engine version is a short name');
        const langs = Array.isArray(r.langs) ? r.langs.filter((l): l is string => typeof l === 'string' && l.length <= 16).slice(0, 16) : [];
        const words = cleanWords(r.words);
        const createdAt = isNum(r.createdAt) ? r.createdAt : deps.now();
        // The chars are rebuilt from the words, so the stored text can never disagree with them.
        const text = ocrPlainText(ocrText(words, o?.rotation ?? 0));
        const source = ocrSource(r);
        let wrote = false;
        let indexed = false;
        let hasText = false;
        db.savepoint((tx) => {
          const doc = tx.selectObjects('SELECT page_count, index_text FROM documents WHERE id = ?', [r.documentId])[0];
          if (!doc) return; // not in the library: nothing is kept
          if (r.pageIndex >= Number(doc.page_count)) throw new PageOcrError('bad-input', 'a page index is past the last page');
          tx.exec({
            sql: `INSERT INTO page_ocr (document_id, page_index, engine, engine_version, langs, words, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (document_id, page_index) DO UPDATE SET engine = excluded.engine, engine_version = excluded.engine_version,
                    langs = excluded.langs, words = excluded.words, created_at = excluded.created_at`,
            bind: [r.documentId, r.pageIndex, r.engine, r.engineVersion, JSON.stringify(langs), JSON.stringify(words), createdAt],
          });
          wrote = true;
          if (o?.index !== false && Number(doc.index_text) === 1) {
            tx.exec({
              sql: `INSERT INTO page_text (document_id, page_index, text, source) VALUES (?, ?, ?, ?)
                    ON CONFLICT (document_id, page_index) DO UPDATE SET text = excluded.text, source = excluded.source
                    WHERE page_text.text IS NOT excluded.text OR page_text.source IS NOT excluded.source`,
              bind: [r.documentId, r.pageIndex, text, source],
            });
            indexed = true;
          }
          if (/\S/u.test(text)) hasText = markHasText(tx, r.documentId, true);
        });
        if (!wrote) return false;
        const id = `${r.documentId}:${r.pageIndex}`;
        publish([
          { table: 'page_ocr', ids: [id], op: 'upsert', documentId: r.documentId },
          ...(indexed ? [{ table: 'page_text' as const, ids: [id], op: 'upsert' as const, documentId: r.documentId }] : []),
          ...(hasText ? [{ table: 'documents' as const, ids: [r.documentId], op: 'upsert' as const, documentId: r.documentId }] : []),
        ]);
        return true;
      }),

    getPageOcr: (documentId, pageIndex) =>
      attempt(() => {
        checkId(documentId);
        checkPage(pageIndex);
        const row = db.selectObjects('SELECT engine, engine_version, langs, words, created_at FROM page_ocr WHERE document_id = ? AND page_index = ?', [documentId, pageIndex])[0];
        if (!row || typeof row.words !== 'string') return null;
        let words: OcrWord[];
        let langs: string[] = [];
        try {
          words = cleanWords(JSON.parse(row.words));
          const l: unknown = JSON.parse(typeof row.langs === 'string' ? row.langs : '[]');
          if (Array.isArray(l)) langs = l.filter((x): x is string => typeof x === 'string');
        } catch {
          return null; // unreadable: the page is simply read again
        }
        return {
          documentId,
          pageIndex,
          engine: str(row.engine),
          engineVersion: str(row.engine_version),
          langs,
          words,
          text: ocrText(words),
          createdAt: Number(row.created_at),
        };
      }),

    listPageOcr: (documentId) =>
      attempt(() => {
        checkId(documentId);
        return db
          .selectObjects('SELECT page_index, engine, engine_version, created_at FROM page_ocr WHERE document_id = ? ORDER BY page_index', [documentId])
          .map((r) => ({ pageIndex: Number(r.page_index), engine: str(r.engine), engineVersion: str(r.engine_version), createdAt: Number(r.created_at) }));
      }),

    deletePageOcr: (documentId, pageIndexes) =>
      attempt(() => {
        readOnly();
        checkId(documentId);
        if (!Array.isArray(pageIndexes)) throw new PageOcrError('bad-input', 'the pages come as a list');
        for (const p of pageIndexes) checkPage(p);
        if (pageIndexes.length === 0) return;
        const pages = JSON.stringify([...new Set(pageIndexes)]);
        db.savepoint((tx) => {
          tx.exec({ sql: 'DELETE FROM page_ocr WHERE document_id = ? AND page_index IN (SELECT value FROM json_each(?))', bind: [documentId, pages] });
          tx.exec({ sql: "DELETE FROM page_text WHERE document_id = ? AND source LIKE 'ocr:%' AND page_index IN (SELECT value FROM json_each(?))", bind: [documentId, pages] });
        });
        const ids = [...new Set(pageIndexes)].map((p) => `${documentId}:${p}`);
        publish([
          { table: 'page_ocr', ids, op: 'delete', documentId },
          { table: 'page_text', ids, op: 'delete', documentId },
        ]);
      }),

    setHasText: (documentId, on) =>
      attempt(() => {
        readOnly();
        checkId(documentId);
        let changed = false;
        db.savepoint((tx) => {
          changed = markHasText(tx, documentId, on === true);
        });
        if (changed) publish([{ table: 'documents', ids: [documentId], op: 'upsert', documentId }]);
      }),
  };
}
