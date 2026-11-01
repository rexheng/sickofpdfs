// The figure cache (contracts §2 and Phase 2 plan §7): what the detector found on each page, per detector version.
// `page_figures` is derived data. It is never synced or backed up, and it is kept only for saved documents.
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends PageFiguresApi`, and the object it returns spreads
// `createPageFiguresApi(db, deps)`. `protocol.ts` and `client.ts` serve and proxy `PAGE_FIGURES_METHODS`.

import type { DocumentId, PageFigure } from '@sop/core';
import type { AnnotationChange } from './annotations';
import { isReadOnly, type SqlDb } from './schema-v2';

export interface PageFiguresApi {
  /** The cached figures of one page, or null when none are stored for this detector version (a new version re-runs). */
  getPageFigures(documentId: DocumentId, pageIndex: number, detectorVersion: string): Promise<PageFigure[] | null>;
  /**
   * Saved documents only. For a document the library does not hold this writes nothing and returns, so nothing about an
   * unsaved PDF reaches the database. Replaces any earlier result for the page.
   */
  putPageFigures(documentId: DocumentId, pageIndex: number, detectorVersion: string, figures: PageFigure[]): Promise<void>;
}

export const PAGE_FIGURES_METHODS = ['getPageFigures', 'putPageFigures'] as const satisfies readonly (keyof PageFiguresApi)[];

export function createPageFiguresApi(db: SqlDb, deps: { publish(c: AnnotationChange): void }): PageFiguresApi {
  const attempt = <T>(f: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      try {
        resolve(f());
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  return {
    getPageFigures: (documentId, pageIndex, detectorVersion) =>
      attempt(() => {
        const row = db.selectObjects('SELECT detector_version, figures FROM page_figures WHERE document_id = ? AND page_index = ?', [documentId, pageIndex])[0];
        if (!row || row.detector_version !== detectorVersion || typeof row.figures !== 'string') return null;
        try {
          const parsed: unknown = JSON.parse(row.figures);
          // Handed back as stored, so fields a newer detector added are still there.
          return Array.isArray(parsed) ? (parsed as PageFigure[]) : null;
        } catch {
          return null; // a cache: if it cannot be read, the page is simply detected again
        }
      }),

    putPageFigures: (documentId, pageIndex, detectorVersion, figures) =>
      attempt(() => {
        if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error('bad-row: page is not a whole number');
        if (typeof detectorVersion !== 'string' || detectorVersion.length === 0) throw new Error('bad-row: no detector version');
        if (!Array.isArray(figures)) throw new Error('bad-row: figures must be a list');
        if (isReadOnly(db)) return; // a newer library: it is only read, and this cache can be rebuilt later
        const json = JSON.stringify(figures);
        let wrote = false;
        db.savepoint((tx) => {
          if (tx.selectObjects('SELECT 1 AS x FROM documents WHERE id = ?', [documentId]).length === 0) return;
          tx.exec({
            sql: `INSERT INTO page_figures (document_id, page_index, detector_version, figures) VALUES (?, ?, ?, ?)
                  ON CONFLICT (document_id, page_index) DO UPDATE SET detector_version = excluded.detector_version, figures = excluded.figures`,
            bind: [documentId, pageIndex, detectorVersion, json],
          });
          wrote = true;
        });
        if (!wrote) return;
        try {
          deps.publish({ table: 'page_figures', ids: [`${documentId}:${pageIndex}`], op: 'upsert', documentId });
        } catch {
          // A cache write has already happened; a failed broadcast changes nothing.
        }
      }),
  };
}
