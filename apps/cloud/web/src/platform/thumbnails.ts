// The web's version of apps/extension/src/library/data/thumbnails.ts (swapped in by vite.config.ts): a reading's first-page
// picture comes from the owner's cloud (`GET /api/thumbs/<sha>`, uploaded by the extension), not drawn from a PDF here. A reading
// with no picture keeps its PDF tile. Pictures are kept in this tab's memory only.
import type { DocumentId } from '@sop/core';

export interface ThumbnailCache {
  /** An object URL for the first page of `id`; null when the cloud has no picture for it. */
  get(id: DocumentId): Promise<string | null>;
  /** Drops the pictures of these documents (they were forgotten). */
  forget(ids: readonly DocumentId[]): Promise<void>;
  /** Nothing is kept on disk, so there is nothing to sweep. */
  sweep(): Promise<void>;
}

export interface ThumbnailDeps {
  savedPdf(id: DocumentId): Promise<Blob | null>;
  hasDocument(id: DocumentId): Promise<boolean>;
}

const ID = /^[0-9a-f]{64}$/;

export function createThumbnailCache(deps: ThumbnailDeps): ThumbnailCache {
  const urls = new Map<DocumentId, string>();
  const pending = new Map<DocumentId, Promise<string | null>>();
  /** No picture in the cloud (or it could not be read): not asked again while this page is open. */
  const missing = new Set<DocumentId>();

  async function fetchOne(id: DocumentId): Promise<string | null> {
    if (!(await deps.hasDocument(id))) return null;
    const res = await fetch(`/api/thumbs/${id}`, { credentials: 'same-origin', cache: 'default', redirect: 'error' });
    if (!res.ok) {
      missing.add(id);
      return null;
    }
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) {
      missing.add(id);
      return null;
    }
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    return url;
  }

  return {
    get(id) {
      if (!ID.test(id) || missing.has(id)) return Promise.resolve(null);
      const known = urls.get(id);
      if (known !== undefined) return Promise.resolve(known);
      let p = pending.get(id);
      if (p === undefined) {
        p = fetchOne(id)
          .catch(() => {
            missing.add(id);
            return null;
          })
          .finally(() => pending.delete(id));
        pending.set(id, p);
      }
      return p;
    },
    forget(ids) {
      for (const id of ids) {
        const url = urls.get(id);
        if (url !== undefined) URL.revokeObjectURL(url);
        urls.delete(id);
        missing.add(id);
      }
      return Promise.resolve();
    },
    sweep: () => Promise.resolve(),
  };
}
