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
import { type DocumentId, type HlcStamp, type ImportRefBackup, type ImportRefsBackupFile, isNewerEngineVersion, type OcrBackupFile, type OcrPageResult, type OcrWord, ocrPlainText, ocrSource, ocrText, parseImportRefsFile, parseOcrFile } from '@sop/core';
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

  // ---- backup (Release 3). Scan text and import refs are the only local tables a backup holds; `passage_vectors`, `source_pages`
  // and the Claude Send consent store never are.
  /**
   * The readings whose scan text a backup may hold: not in Trash, and the owner lets their text into search (not D9). A reading that
   * is not in the library (not saved, forgotten) has no rows at all, so it can never be named here.
   */
  backupOcrIds(): Promise<DocumentId[]>;
  /** One such reading's recognised pages, or null when it is not eligible or has none. */
  backupOcrFile(documentId: DocumentId): Promise<OcrBackupFile | null>;
  /**
   * Merges a backup's recognised pages into this library. A page this library lacks is added; a page it has is replaced only by a
   * strictly newer version of the same engine, and never when the page already carries notes. Nothing is written for a reading this
   * library does not hold (forgotten, not restored, in Trash). Answers how many pages were added or replaced.
   */
  restoreOcrFile(file: unknown): Promise<number>;
  /** The readings with import refs that a backup may hold (not in Trash). */
  backupImportRefs(documentId: DocumentId): Promise<ImportRefsBackupFile | null>;
  /** Adds a backup's import refs for a reading this library holds. Inserts only; a ref that names a note this library lacks is left out. */
  restoreImportRefs(file: unknown): Promise<number>;
}

export const PAGE_OCR_API_METHODS = ['putPageOcr', 'getPageOcr', 'listPageOcr', 'deletePageOcr', 'setHasText', 'backupOcrIds', 'backupOcrFile', 'restoreOcrFile', 'backupImportRefs', 'restoreImportRefs'] as const satisfies readonly (keyof PageOcrApi)[];
export const PAGE_OCR_READ_METHODS = ['getPageOcr', 'listPageOcr', 'backupOcrIds', 'backupOcrFile', 'backupImportRefs'] as const satisfies readonly (keyof PageOcrApi)[];

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

    backupOcrIds: () =>
      attempt(() =>
        db
          .selectObjects('SELECT d.id AS id FROM documents d WHERE d.deleted_at IS NULL AND d.index_text = 1 AND EXISTS (SELECT 1 FROM page_ocr o WHERE o.document_id = d.id) ORDER BY d.id')
          .map((r) => str(r.id) as DocumentId),
      ),

    backupOcrFile: (documentId) =>
      attempt(() => {
        checkId(documentId);
        const doc = db.selectObjects('SELECT 1 AS ok FROM documents WHERE id = ? AND deleted_at IS NULL AND index_text = 1', [documentId])[0];
        if (!doc) return null;
        const pages: OcrBackupFile['pages'] = [];
        for (const r of db.selectObjects('SELECT page_index, engine, engine_version, langs, words, created_at FROM page_ocr WHERE document_id = ? ORDER BY page_index', [documentId])) {
          try {
            const l: unknown = JSON.parse(typeof r.langs === 'string' ? r.langs : '[]');
            pages.push({
              pageIndex: Number(r.page_index),
              engine: str(r.engine),
              engineVersion: str(r.engine_version),
              langs: Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : [],
              words: cleanWords(JSON.parse(str(r.words))),
              createdAt: Number(r.created_at),
            });
          } catch {
            // an unreadable page is left out; it is simply read again
          }
        }
        return pages.length === 0 ? null : { format: 'sop-ocr', version: 1, documentId, pages };
      }),

    restoreOcrFile: (input) =>
      attempt(() => {
        readOnly();
        const file = parseOcrFile(input);
        if (file === null) return 0;
        const documentId = file.documentId;
        const changed: string[] = [];
        let indexed = false;
        let hasText = false;
        db.savepoint((tx) => {
          const doc = tx.selectObjects('SELECT page_count, index_text FROM documents WHERE id = ? AND deleted_at IS NULL', [documentId])[0];
          if (!doc) return; // forgotten, never restored, or in Trash: nothing comes back for it
          for (const p of file.pages) {
            if (p.pageIndex >= Number(doc.page_count) || p.engine.length > MAX_NAME || p.engineVersion.length > MAX_NAME) continue;
            let words: OcrWord[];
            try {
              words = cleanWords(p.words);
            } catch {
              continue;
            }
            const have = tx.selectObjects('SELECT engine, engine_version FROM page_ocr WHERE document_id = ? AND page_index = ?', [documentId, p.pageIndex])[0];
            if (have) {
              // Never an older engine over a newer one, never a different engine over this one, never new words under an existing note.
              if (str(have.engine) !== p.engine || !isNewerEngineVersion(p.engineVersion, str(have.engine_version))) continue;
              const noted = tx.selectObjects(
                `SELECT 1 AS n FROM marks WHERE document_id = ?1 AND page_index = ?2 AND deleted_at IS NULL
                 UNION ALL SELECT 1 FROM threads WHERE document_id = ?1 AND page_index = ?2 AND deleted_at IS NULL LIMIT 1`,
                [documentId, p.pageIndex],
              )[0];
              if (noted) continue;
            }
            tx.exec({
              sql: `INSERT INTO page_ocr (document_id, page_index, engine, engine_version, langs, words, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (document_id, page_index) DO UPDATE SET engine = excluded.engine, engine_version = excluded.engine_version,
                      langs = excluded.langs, words = excluded.words, created_at = excluded.created_at`,
              bind: [documentId, p.pageIndex, p.engine, p.engineVersion, JSON.stringify(p.langs.slice(0, 16)), JSON.stringify(words), p.createdAt],
            });
            changed.push(`${documentId}:${p.pageIndex}`);
            const text = ocrPlainText(ocrText(words, 0));
            if (Number(doc.index_text) === 1) {
              tx.exec({
                sql: `INSERT INTO page_text (document_id, page_index, text, source) VALUES (?, ?, ?, ?)
                      ON CONFLICT (document_id, page_index) DO UPDATE SET text = excluded.text, source = excluded.source
                      WHERE page_text.text IS NOT excluded.text OR page_text.source IS NOT excluded.source`,
                bind: [documentId, p.pageIndex, text, ocrSource({ engine: p.engine, engineVersion: p.engineVersion })],
              });
              indexed = true;
            }
            if (/\S/u.test(text)) hasText = markHasText(tx, documentId, true) || hasText;
          }
        });
        if (changed.length === 0) return 0;
        publish([
          { table: 'page_ocr', ids: changed, op: 'upsert', documentId, origin: 'restore' },
          ...(indexed ? [{ table: 'page_text' as const, ids: changed, op: 'upsert' as const, documentId, origin: 'restore' as const }] : []),
          ...(hasText ? [{ table: 'documents' as const, ids: [documentId], op: 'upsert' as const, documentId, origin: 'restore' as const }] : []),
        ]);
        return changed.length;
      }),

    backupImportRefs: (documentId) =>
      attempt(() => {
        checkId(documentId);
        if (!db.selectObjects('SELECT 1 AS ok FROM documents WHERE id = ? AND deleted_at IS NULL', [documentId])[0]) return null;
        const refs: ImportRefBackup[] = db
          .selectObjects('SELECT pdf_ref, row_table, row_id, created_at FROM pdf_import_refs WHERE document_id = ? ORDER BY pdf_ref', [documentId])
          .map((r) => ({ pdfRef: str(r.pdf_ref), rowTable: str(r.row_table) as ImportRefBackup['rowTable'], rowId: str(r.row_id), createdAt: Number(r.created_at) }));
        return refs.length === 0 ? null : { format: 'sop-import-refs', version: 1, documentId, refs };
      }),

    restoreImportRefs: (input) =>
      attempt(() => {
        readOnly();
        const file = parseImportRefsFile(input);
        if (file === null) return 0;
        let added = 0;
        db.savepoint((tx) => {
          if (!tx.selectObjects('SELECT 1 AS ok FROM documents WHERE id = ? AND deleted_at IS NULL', [file.documentId])[0]) return;
          for (const r of file.refs) {
            // A ref that names a note must name a note of this reading that is here; otherwise it would point at nothing.
            if (r.rowId !== '' && !tx.selectObjects(`SELECT 1 AS ok FROM ${r.rowTable} WHERE id = ? AND document_id = ?`, [r.rowId, file.documentId])[0]) continue;
            const before = tx.selectValue('SELECT count(*) FROM pdf_import_refs WHERE document_id = ?', [file.documentId]);
            tx.exec({
              sql: 'INSERT OR IGNORE INTO pdf_import_refs (document_id, pdf_ref, row_table, row_id, created_at) VALUES (?, ?, ?, ?, ?)',
              bind: [file.documentId, r.pdfRef, r.rowTable, r.rowId, r.createdAt],
            });
            if (Number(tx.selectValue('SELECT count(*) FROM pdf_import_refs WHERE document_id = ?', [file.documentId])) > Number(before)) added += 1;
          }
        });
        return added;
      }),
  };
}
